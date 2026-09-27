import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGenerateHandler } from '../api/generate.js';
import { createTrendsHandler } from '../api/trends.js';
import { GROQ_URL } from '../lib/groq.js';
import { fakeFetch, groqReply, jsonResponse, mockRequest, mockResponse, silentLogger, VALID_PACKAGE } from './helpers.js';

const env = { GROQ_API_KEY: 'test-key' };
const risingTrends = {
  relatedQueries: async () =>
    JSON.stringify({ default: { rankedList: [{ rankedKeyword: [] }, { rankedKeyword: [{ query: 'creatine' }] }] } }),
};

async function call(handler, request) {
  const res = mockResponse();
  await handler(mockRequest(request), res);
  return res;
}

describe('POST /api/trends', () => {
  const topicsFetch = () => fakeFetch(() => groqReply({ topics: ['When should you take creatine?', 'Creatine myths'] }));

  it('returns AI topics plus where the seed keywords came from', async () => {
    const fetchImpl = topicsFetch();
    const handler = createTrendsHandler({ env, fetchImpl, trendsClient: risingTrends, logger: silentLogger });
    const res = await call(handler, { body: { category: '  Urban Beekeeping  ', region: 'IN' } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.json(), {
      trends: ['When should you take creatine?', 'Creatine myths'],
      source: 'google-trends-rising',
      keywords: ['creatine'],
    });

    // User data travels as JSON in the user message, never inside the system prompt.
    const [system, user] = fetchImpl.calls[0].body.messages;
    assert.equal(system.role, 'system');
    assert.ok(!system.content.includes('Urban Beekeeping'));
    assert.deepEqual(JSON.parse(user.content), { niche: 'Urban Beekeeping', keywords: ['creatine'], region: 'India' });
  });

  it('keeps working when Google Trends is down', async () => {
    const fetchImpl = fakeFetch((url) =>
      url.startsWith(GROQ_URL) ? groqReply({ topics: ['A topic'] }) : jsonResponse(['fitness', ['fitness app']]),
    );
    const trendsClient = { relatedQueries: async () => '<!DOCTYPE html><title>429</title>' };
    const handler = createTrendsHandler({ env, fetchImpl, trendsClient, logger: silentLogger });
    const res = await call(handler, { body: { category: 'fitness' } });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().source, 'google-autocomplete');
  });

  it('ignores unknown regions', async () => {
    const calls = [];
    const trendsClient = { relatedQueries: async (options) => (calls.push(options), risingTrends.relatedQueries()) };
    const handler = createTrendsHandler({ env, fetchImpl: topicsFetch(), trendsClient, logger: silentLogger });
    await call(handler, { body: { category: 'fitness', region: 'XX' } });
    assert.deepEqual(calls, [{ keyword: 'fitness' }]);
  });

  it('rejects wrong methods, content types and bad input', async () => {
    const handler = createTrendsHandler({ env, fetchImpl: topicsFetch(), trendsClient: risingTrends, logger: silentLogger });

    const get = await call(handler, { method: 'GET' });
    assert.equal(get.statusCode, 405);
    assert.equal(get.headers.allow, 'POST');

    const form = await call(handler, { body: 'category=x', headers: { 'content-type': 'text/plain' } });
    assert.equal(form.statusCode, 415);

    for (const body of [{}, { category: ' ' }, { category: 42 }]) {
      const res = await call(handler, { body });
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(res.json().code, 'invalid_input');
    }

    const badJson = await call(handler, { body: '{"category":' });
    assert.equal(badJson.statusCode, 400);
    assert.equal(badJson.json().code, 'invalid_json');

    const array = await call(handler, { body: ['fitness'] });
    assert.equal(array.statusCode, 400);
  });

  it('fails fast without an API key and never calls upstream', async () => {
    const fetchImpl = topicsFetch();
    let trendsCalled = false;
    const trendsClient = { relatedQueries: async () => ((trendsCalled = true), '') };
    const handler = createTrendsHandler({ env: {}, fetchImpl, trendsClient, logger: silentLogger });
    const res = await call(handler, { body: { category: 'fitness' } });

    assert.equal(res.statusCode, 500);
    assert.equal(res.json().code, 'missing_api_key');
    assert.equal(fetchImpl.calls.length, 0);
    assert.equal(trendsCalled, false);
  });

  it('rate limits each client', async () => {
    const handler = createTrendsHandler({
      env: { ...env, RATE_LIMIT_PER_MINUTE: '2' },
      fetchImpl: topicsFetch(),
      trendsClient: risingTrends,
      logger: silentLogger,
    });
    const request = { body: { category: 'fitness' }, ip: '198.51.100.7' };
    assert.equal((await call(handler, request)).statusCode, 200);
    assert.equal((await call(handler, request)).statusCode, 200);
    const limited = await call(handler, request);
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal((await call(handler, { ...request, ip: '198.51.100.8' })).statusCode, 200);
  });
});

describe('POST /api/generate', () => {
  it('returns a normalized production package', async () => {
    const fetchImpl = fakeFetch(() => groqReply('```json\n' + JSON.stringify({ ...VALID_PACKAGE, hashtags: 'backpain fitness' }) + '\n```'));
    const handler = createGenerateHandler({ env, fetchImpl, logger: silentLogger });
    const res = await call(handler, { body: JSON.stringify({ topic: 'Back pain fix', niche: 'Fitness', tone: 'educational' }) });

    assert.equal(res.statusCode, 200);
    const { package: pkg, tone } = res.json();
    assert.equal(tone, 'educational');
    assert.deepEqual(pkg.hashtags, ['#backpain', '#fitness', '#shorts']);
    assert.deepEqual(pkg.script, VALID_PACKAGE.script);

    const data = JSON.parse(fetchImpl.calls[0].body.messages[1].content);
    assert.equal(data.topic, 'Back pain fix');
    assert.equal(data.niche, 'Fitness');
    assert.match(data.tone, /educational/);
  });

  it('defaults unknown tones and requires a topic', async () => {
    const fetchImpl = fakeFetch(() => groqReply(VALID_PACKAGE));
    const handler = createGenerateHandler({ env, fetchImpl, logger: silentLogger });

    const res = await call(handler, { body: { topic: 'Valid topic', tone: 'sarcastic<script>' } });
    assert.equal(res.json().tone, 'energetic');

    assert.equal((await call(handler, { body: { topic: 'ab' } })).statusCode, 400);
    assert.equal((await call(handler, { body: {} })).statusCode, 400);
  });

  it('surfaces AI rate limits with Retry-After', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ error: { code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '9' }));
    const handler = createGenerateHandler({ env, fetchImpl, logger: silentLogger });
    const res = await call(handler, { body: { topic: 'Some topic' } });

    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '9');
    assert.equal(res.json().code, 'ai_rate_limited');
  });

  it('retries an incomplete package once before failing', async () => {
    const incomplete = { ...VALID_PACKAGE, script: { hook: 'only a hook' } };
    const fetchImpl = fakeFetch([groqReply(incomplete), groqReply(VALID_PACKAGE)]);
    const handler = createGenerateHandler({ env, fetchImpl, logger: silentLogger });
    const res = await call(handler, { body: { topic: 'Some topic' } });

    assert.equal(res.statusCode, 200);
    assert.equal(fetchImpl.calls.length, 2);
  });
});
