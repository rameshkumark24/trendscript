import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createDevServer } from '../dev/server.js';
import { silentLogger } from './helpers.js';

describe('dev server (mock mode)', () => {
  let server;
  let origin;

  before(async () => {
    server = createDevServer({ env: {}, mock: true, mockLatencyMs: 0, logger: silentLogger });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const post = (path, body, headers = { 'content-type': 'application/json' }) =>
    fetch(`${origin}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('serves the app with production security headers', async () => {
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await res.text(), /<title>TrendScript/);
  });

  it('never serves files outside the public allowlist', async () => {
    for (const path of ['/.env', '/package.json', '/api/trends.js', '/lib/groq.js', '/dev/server.js', '/%2e%2e/%2e%2e/etc/passwd', '/api/../.env']) {
      const res = await fetch(`${origin}${path}`);
      assert.equal(res.status, 404, path);
      assert.match(await res.text(), /isn't trending/, path);
    }
  });

  it('runs the full trends -> generate flow against mocked upstreams', async () => {
    const trendsRes = await post('/api/trends', { category: 'fitness', region: 'US' });
    assert.equal(trendsRes.status, 200);
    const { trends, source } = await trendsRes.json();
    assert.equal(trends.length, 6);
    assert.equal(source, 'google-trends-rising');

    const packageRes = await post('/api/generate', { topic: trends[0], niche: 'fitness' });
    assert.equal(packageRes.status, 200);
    const { package: pkg } = await packageRes.json();
    assert.ok(pkg.script.hook && pkg.script.cta);
    assert.ok(pkg.hashtags.includes('#shorts'));
  });

  it('reports source fallbacks and upstream rate limits', async () => {
    const down = await (await post('/api/trends', { category: 'trends-down fitness' })).json();
    assert.equal(down.source, 'google-autocomplete');

    const limited = await post('/api/generate', { topic: 'ratelimit test' });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '7');
  });

  it('rejects oversized bodies and wrong methods', async () => {
    const big = await post('/api/generate', { topic: 'x'.repeat(20_000) });
    assert.equal(big.status, 413);

    const get = await fetch(`${origin}/api/generate`);
    assert.equal(get.status, 405);

    const postStatic = await post('/index.html', {});
    assert.equal(postStatic.status, 405);
  });
});
