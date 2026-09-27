import { RESCUE_MODEL, requestGroqJson, requireApiKey, resolveModel } from '../lib/groq.js';
import { assertPost, readJsonBody, sendError, sendJson } from '../lib/http.js';
import { pickOption, requireText } from '../lib/input.js';
import { normalizeTopics } from '../lib/normalize.js';
import { REGIONS } from '../lib/options.js';
import { buildTopicMessages } from '../lib/prompts.js';
import { createRateLimiter, enforceRateLimit } from '../lib/rate-limit.js';
import { collectSeedKeywords } from '../lib/trend-sources.js';

/**
 * POST /api/trends  { category, region? }
 * -> { trends: string[], source: string, keywords: string[] }
 *
 * Dependencies are injectable so tests and the offline dev server can swap
 * out Google and Groq.
 */
export function createTrendsHandler({ env = process.env, fetchImpl, trendsClient, logger = console } = {}) {
  const limiter = createRateLimiter();

  return async function trendsHandler(req, res) {
    try {
      assertPost(req);
      enforceRateLimit(limiter, req, env);
      const body = readJsonBody(req);
      const category = requireText(body.category, { label: 'Category', maxLength: 80 });
      const region = pickOption(body.region, Object.keys(REGIONS), '');
      const apiKey = requireApiKey(env);

      const seeds = await collectSeedKeywords(category, { geo: region, trendsClient, fetchImpl, logger });
      const trends = await requestGroqJson({
        apiKey,
        model: resolveModel(env),
        messages: buildTopicMessages({ category, keywords: seeds.keywords, region }),
        validate: normalizeTopics,
        temperature: 0.8,
        maxTokens: 600,
        timeoutMs: 8_000,
        attempts: 3,
        rescueModel: RESCUE_MODEL,
        fetchImpl: fetchImpl ?? globalThis.fetch,
        logger,
      });

      sendJson(res, 200, { trends, source: seeds.source, keywords: seeds.keywords });
    } catch (error) {
      sendError(res, error, logger);
    }
  };
}

export default createTrendsHandler();
