import googleTrends from 'google-trends-api';
import { cleanText, dedupe } from './input.js';

const MAX_KEYWORDS = 12;
const AUTOCOMPLETE_URL = 'https://suggestqueries.google.com/complete/search';

/**
 * Where the seed keywords came from, from most to least trend-aware. The
 * frontend shows this so creators know how "live" their topics are.
 */
export const SOURCES = {
  trendsRising: 'google-trends-rising',
  trendsTop: 'google-trends-top',
  autocomplete: 'google-autocomplete',
  fallback: 'fallback',
};

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function cleanKeywords(values, category = '') {
  const normalizedCategory = category.toLowerCase();
  const cleaned = values
    .map((value) => cleanText(value, 80))
    .filter((value) => value && value.toLowerCase() !== normalizedCategory);
  return dedupe(cleaned).slice(0, MAX_KEYWORDS);
}

function rankedQueries(list) {
  const items = Array.isArray(list?.rankedKeyword) ? list.rankedKeyword : [];
  return items.map((item) => item?.query);
}

/**
 * Related queries from Google Trends, preferring "rising" (breakout) over
 * "top". google-trends-api rejects or returns an HTML page when Google rate
 * limits the caller, which is common from cloud IPs, so callers must be ready
 * for this to throw.
 */
export async function fetchGoogleTrendsQueries(category, { geo = '', client = googleTrends, timeoutMs = 4500 } = {}) {
  const options = { keyword: category };
  if (geo) options.geo = geo;
  const raw = await withTimeout(client.relatedQueries(options), timeoutMs, 'Google Trends');
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const lists = parsed?.default?.rankedList ?? [];

  const rising = cleanKeywords(rankedQueries(lists[1]), category);
  if (rising.length) return { keywords: rising, source: SOURCES.trendsRising };

  const top = cleanKeywords(rankedQueries(lists[0]), category);
  return { keywords: top, source: SOURCES.trendsTop };
}

/** What people are typing into Google for this niche right now. */
export async function fetchAutocompleteQueries(
  category,
  { geo = '', fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {},
) {
  const url = new URL(AUTOCOMPLETE_URL);
  url.searchParams.set('client', 'firefox');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('q', category);
  if (geo) url.searchParams.set('gl', geo.toLowerCase());

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Autocomplete responded with HTTP ${response.status}`);
  const data = JSON.parse(await response.text());
  const suggestions = Array.isArray(data?.[1]) ? data[1] : [];
  return cleanKeywords(suggestions, category);
}

export function fallbackKeywords(category) {
  return [
    `${category} tips`,
    `${category} for beginners`,
    `${category} mistakes`,
    `best ${category}`,
    `${category} myths`,
    `${category} hacks`,
  ];
}

/**
 * Best-effort seed keywords for a niche. Never throws: each source degrades
 * to the next so topic generation keeps working when Google blocks us.
 */
export async function collectSeedKeywords(category, { geo = '', trendsClient, fetchImpl, logger = console } = {}) {
  try {
    const result = await fetchGoogleTrendsQueries(category, { geo, client: trendsClient ?? googleTrends });
    if (result.keywords.length) return result;
  } catch (error) {
    logger.warn(`[trendscript] Google Trends unavailable, falling back to autocomplete: ${error.message}`);
  }

  try {
    const keywords = await fetchAutocompleteQueries(category, { geo, fetchImpl: fetchImpl ?? globalThis.fetch });
    if (keywords.length) return { keywords, source: SOURCES.autocomplete };
  } catch (error) {
    logger.warn(`[trendscript] Autocomplete unavailable, using generic seeds: ${error.message}`);
  }

  return { keywords: fallbackKeywords(category), source: SOURCES.fallback };
}
