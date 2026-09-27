import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackage } from '../api/generate.js';
import generateHandler from '../api/generate.js';
import trendsHandler, { fetchRawTrends, normalizeTopics } from '../api/trends.js';
import { cleanText, readJsonBody, resetModelCache } from '../api/_lib/shared.js';

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

function groqReply(content, status = 200) {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status });
}

const realFetch = globalThis.fetch;
beforeEach(() => { process.env.GROQ_API_KEY = 'test-key'; resetModelCache(); });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.GROQ_API_KEY; });

test('cleanText strips control chars, collapses whitespace and truncates', () => {
  assert.equal(cleanText('  hi\n\tthere\u0000 '), 'hi there');
  assert.equal(cleanText('abcdef', 3), 'abc');
  assert.equal(cleanText(42), '');
});

test('readJsonBody handles objects, strings and bad JSON', async () => {
  assert.deepEqual(await readJsonBody({ body: { a: 1 } }), { a: 1 });
  assert.deepEqual(await readJsonBody({ body: '{"a":2}' }), { a: 2 });
  await assert.rejects(readJsonBody({ body: '{nope' }), { status: 400 });
});

test('normalizePackage fills defaults and rejects incomplete scripts', () => {
  const pkg = normalizePackage({
    title: 'T', hashtags: 'fitness, #gym <script>', chapters: [{ time: 'bad', label: 'x' }],
    script: { hook: 'a', buildup: 'b', climax: 'c', cta: 'd' },
  }, 'topic');
  assert.deepEqual(pkg.hashtags, ['#fitness', '#gym', '#script']);
  assert.equal(pkg.chapters.length, 4);
  assert.equal(normalizePackage({ script: { hook: 'a' } }, 't'), null);
  assert.equal(normalizePackage(null, 't'), null);
});

test('normalizeTopics dedupes and caps at 6', () => {
  assert.deepEqual(normalizeTopics({ topics: ['a', 'a', '', 5, 'b'] }), ['a', 'b']);
  assert.equal(normalizeTopics({ topics: Array.from({ length: 10 }, (_, i) => `t${i}`) }).length, 6);
  assert.deepEqual(normalizeTopics({}), []);
});

test('fetchRawTrends falls back when Google Trends fails', async () => {
  const failing = { relatedQueries: async () => '<html>rate limited</html>' };
  const result = await fetchRawTrends('fitness', failing);
  assert.equal(result.source, 'fallback');
  assert.ok(result.keywords.includes('fitness'));

  const ok = { relatedQueries: async () => JSON.stringify({ default: { rankedList: [
    { rankedKeyword: [{ query: 'Top One' }] }, { rankedKeyword: [{ query: 'Rising' }, { query: 'top one' }] },
  ] } }) };
  assert.deepEqual(await fetchRawTrends('x', ok), { keywords: ['rising', 'top one'], source: 'google-trends' });
});

test('generate handler validates method and input', async () => {
  let res = mockRes();
  await generateHandler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 405);

  res = mockRes();
  await generateHandler({ method: 'POST', body: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('generate handler returns a normalized package', async () => {
  globalThis.fetch = groqReply({ title: 'Hi', hashtags: ['#a'], script: { hook: 'h', buildup: 'b', climax: 'c', cta: 'd' } });
  const res = mockRes();
  await generateHandler({ method: 'POST', body: { topic: 'cats' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.package.title, 'Hi');
  assert.equal(res.body.package.script.cta, 'd');
});

test('generate handler surfaces Groq rate limits and missing key', async () => {
  globalThis.fetch = async () => new Response('{"error":{"message":"slow down"}}', { status: 429 });
  let res = mockRes();
  await generateHandler({ method: 'POST', body: { topic: 'cats' } }, res);
  assert.equal(res.statusCode, 429);

  delete process.env.GROQ_API_KEY;
  res = mockRes();
  await generateHandler({ method: 'POST', body: { topic: 'cats' } }, res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /GROQ_API_KEY/);
});

test('trends handler rejects empty category', async () => {
  const res = mockRes();
  await trendsHandler({ method: 'POST', body: { category: '   ' } }, res);
  assert.equal(res.statusCode, 400);
});

test('Groq key is sent without stray whitespace or quotes', async () => {
  process.env.GROQ_API_KEY = '  "gsk_abc"\n';
  let authHeader;
  globalThis.fetch = async (_url, init) => {
    authHeader = init.headers.Authorization;
    return groqReply({ script: { hook: 'h', buildup: 'b', climax: 'c', cta: 'd' } })();
  };
  const res = mockRes();
  await generateHandler({ method: 'POST', body: { topic: 'cats' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(authHeader, 'Bearer gsk_abc');
});

const VALID_PKG = { script: { hook: 'h', buildup: 'b', climax: 'c', cta: 'd' } };
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('switches to an available model when the configured one is decommissioned', async () => {
  const models = [];
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }] });
    const { model } = JSON.parse(init.body);
    models.push(model);
    if (model === 'llama-3.1-8b-instant') {
      return jsonResponse({ error: { message: 'The model `llama-3.1-8b-instant` has been decommissioned', code: 'model_decommissioned' } }, 400);
    }
    return groqReply(VALID_PKG)();
  };
  const res = mockRes();
  await generateHandler({ method: 'POST', body: { topic: 'cats' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(models, ['llama-3.1-8b-instant', 'openai/gpt-oss-20b']);

  // The working model is remembered for later requests.
  models.length = 0;
  await generateHandler({ method: 'POST', body: { topic: 'dogs' } }, mockRes());
  assert.deepEqual(models, ['openai/gpt-oss-20b']);
});

test('retries once when Groq reports json_validate_failed', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return jsonResponse({ error: { message: 'Failed to generate JSON', code: 'json_validate_failed' } }, 400);
    return groqReply(VALID_PKG)();
  };
  const res = mockRes();
  await generateHandler({ method: 'POST', body: { topic: 'cats' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls, 2);
});

test('surfaces the provider error detail for other failures', async () => {
  globalThis.fetch = async () => jsonResponse({ error: { message: 'Organization has been restricted.', code: 'organization_restricted' } }, 400);
  const res = mockRes();
  await generateHandler({ method: 'POST', body: { topic: 'cats' } }, res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /\(400: Organization has been restricted\.\)/);
});
