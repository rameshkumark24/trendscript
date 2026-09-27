import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpError } from '../lib/errors.js';
import { clientKey, readJsonBody, sendError } from '../lib/http.js';
import { cleanText } from '../lib/input.js';
import { createRateLimiter, limitFromEnv } from '../lib/rate-limit.js';
import { mockResponse } from './helpers.js';

const json = { 'content-type': 'application/json; charset=utf-8' };

describe('readJsonBody', () => {
  it('accepts parsed objects, JSON strings, buffers and empty bodies', () => {
    assert.deepEqual(readJsonBody({ headers: json, body: { a: 1 } }), { a: 1 });
    assert.deepEqual(readJsonBody({ headers: json, body: '{"a":1}' }), { a: 1 });
    assert.deepEqual(readJsonBody({ headers: json, body: Buffer.from('{"a":1}') }), { a: 1 });
    assert.deepEqual(readJsonBody({ headers: json, body: '' }), {});
    assert.deepEqual(readJsonBody({ headers: json }), {});
  });

  it('turns a throwing body getter (Vercel on malformed JSON) into a 400', () => {
    const req = {
      headers: json,
      get body() {
        throw new Error('Invalid JSON');
      },
    };
    assert.throws(() => readJsonBody(req), { status: 400, code: 'invalid_json' });
  });

  it('rejects non-JSON content types and non-object bodies', () => {
    assert.throws(() => readJsonBody({ headers: {}, body: {} }), { status: 415 });
    assert.throws(() => readJsonBody({ headers: json, body: '"text"' }), { status: 400, code: 'invalid_body' });
  });
});

describe('sendError', () => {
  it('serializes HttpErrors with their status and headers', () => {
    const res = mockResponse();
    sendError(res, new HttpError(429, 'Slow down', { code: 'rate_limited', retryAfter: 5, headers: { 'X-Test': '1' } }));
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['retry-after'], '5');
    assert.equal(res.headers['x-test'], '1');
    assert.deepEqual(res.json(), { error: 'Slow down', code: 'rate_limited' });
  });

  it('logs unexpected errors and hides their details', () => {
    const logged = [];
    const res = mockResponse();
    sendError(res, new Error('secret stack detail'), { error: (...args) => logged.push(args) });
    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(res.body, /secret/);
    assert.equal(logged.length, 1);
  });
});

describe('clientKey', () => {
  it('uses the first forwarded address, then the socket', () => {
    assert.equal(clientKey({ headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.1' } }), '1.1.1.1');
    assert.equal(clientKey({ headers: {}, socket: { remoteAddress: '::1' } }), '::1');
  });
});

describe('rate limiter', () => {
  it('limits per key and resets after the window', () => {
    let now = 0;
    const check = createRateLimiter({ windowMs: 1000, now: () => now });
    assert.equal(check('a', 2).allowed, true);
    assert.equal(check('a', 2).allowed, true);
    assert.deepEqual(check('a', 2), { allowed: false, retryAfter: 1 });
    assert.equal(check('b', 2).allowed, true);
    now = 1000;
    assert.equal(check('a', 2).allowed, true);
  });

  it('is disabled by a zero limit and reads the env safely', () => {
    const check = createRateLimiter();
    for (let i = 0; i < 50; i += 1) assert.equal(check('a', 0).allowed, true);
    assert.equal(limitFromEnv({}), 20);
    assert.equal(limitFromEnv({ RATE_LIMIT_PER_MINUTE: '0' }), 0);
    assert.equal(limitFromEnv({ RATE_LIMIT_PER_MINUTE: 'lots' }), 20);
  });
});

describe('cleanText', () => {
  it('strips control characters, collapses whitespace and truncates', () => {
    assert.equal(cleanText('  a\u0000b \n\t c  '), 'a b c');
    assert.equal(cleanText('abcdef', 3), 'abc');
    assert.equal(cleanText(42), '');
  });
});
