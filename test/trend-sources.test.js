import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SOURCES,
  collectSeedKeywords,
  fallbackKeywords,
  fetchAutocompleteQueries,
  fetchGoogleTrendsQueries,
} from '../lib/trend-sources.js';
import { fakeFetch, jsonResponse, silentLogger } from './helpers.js';

function trendsPayload({ top = [], rising = [] }) {
  return JSON.stringify({
    default: {
      rankedList: [
        { rankedKeyword: top.map((query) => ({ query })) },
        { rankedKeyword: rising.map((query) => ({ query })) },
      ],
    },
  });
}

function trendsClient(result) {
  const calls = [];
  return {
    calls,
    relatedQueries(options) {
      calls.push(options);
      return typeof result === 'function' ? result(options) : Promise.resolve(result);
    },
  };
}

describe('fetchGoogleTrendsQueries', () => {
  it('prefers rising queries and removes the bare category and duplicates', async () => {
    const client = trendsClient(trendsPayload({ top: ['top one'], rising: ['Fitness', 'creatine', 'Creatine', 'back pain'] }));
    const result = await fetchGoogleTrendsQueries('fitness', { client, geo: 'IN' });
    assert.deepEqual(result, { keywords: ['creatine', 'back pain'], source: SOURCES.trendsRising });
    assert.deepEqual(client.calls, [{ keyword: 'fitness', geo: 'IN' }]);
  });

  it('falls back to top queries and omits geo for worldwide', async () => {
    const client = trendsClient(trendsPayload({ top: ['top one', 'top two'] }));
    const result = await fetchGoogleTrendsQueries('fitness', { client });
    assert.deepEqual(result, { keywords: ['top one', 'top two'], source: SOURCES.trendsTop });
    assert.deepEqual(client.calls, [{ keyword: 'fitness' }]);
  });

  it('throws on HTML block pages and on timeouts', async () => {
    await assert.rejects(fetchGoogleTrendsQueries('x', { client: trendsClient('<html>429</html>') }), SyntaxError);
    const never = trendsClient(() => new Promise(() => {}));
    await assert.rejects(fetchGoogleTrendsQueries('x', { client: never, timeoutMs: 20 }), /timed out/);
  });
});

describe('fetchAutocompleteQueries', () => {
  it('builds the request and parses suggestions', async () => {
    const fetchImpl = fakeFetch([jsonResponse(['yoga', ['yoga', 'yoga for beginners', 'yoga mat']])]);
    const keywords = await fetchAutocompleteQueries('yoga', { geo: 'GB', fetchImpl });
    assert.deepEqual(keywords, ['yoga for beginners', 'yoga mat']);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.searchParams.get('q'), 'yoga');
    assert.equal(url.searchParams.get('gl'), 'gb');
  });

  it('throws on HTTP errors', async () => {
    const fetchImpl = fakeFetch([new Response('blocked', { status: 403 })]);
    await assert.rejects(fetchAutocompleteQueries('yoga', { fetchImpl }), /403/);
  });
});

describe('collectSeedKeywords', () => {
  it('uses Google Trends when it works', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('should not be called');
    });
    const result = await collectSeedKeywords('fitness', {
      trendsClient: trendsClient(trendsPayload({ rising: ['creatine'] })),
      fetchImpl,
      logger: silentLogger,
    });
    assert.equal(result.source, SOURCES.trendsRising);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('falls back to autocomplete when Google Trends blocks us', async () => {
    const result = await collectSeedKeywords('fitness', {
      trendsClient: trendsClient(Promise.reject(new Error('429'))),
      fetchImpl: fakeFetch([jsonResponse(['fitness', ['fitness app']])]),
      logger: silentLogger,
    });
    assert.deepEqual(result, { keywords: ['fitness app'], source: SOURCES.autocomplete });
  });

  it('falls back to generic seeds when every source fails', async () => {
    const result = await collectSeedKeywords('fitness', {
      trendsClient: trendsClient(trendsPayload({})),
      fetchImpl: fakeFetch([new TypeError('fetch failed')]),
      logger: silentLogger,
    });
    assert.deepEqual(result, { keywords: fallbackKeywords('fitness'), source: SOURCES.fallback });
  });
});
