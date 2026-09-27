import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { AiOutputError, HttpError } from '../lib/errors.js';
import {
  DEFAULT_MODEL,
  GROQ_MODELS_URL,
  GROQ_URL,
  clearModelOverrides,
  findReplacementModel,
  parseModelJson,
  requestGroqJson,
  requireApiKey,
  resolveModel,
} from '../lib/groq.js';
import { fakeFetch, groqReply, jsonResponse, silentLogger } from './helpers.js';

const base = { apiKey: 'test-key', messages: [{ role: 'user', content: 'hi' }], logger: silentLogger };

describe('parseModelJson', () => {
  it('parses plain, fenced and chatty JSON', () => {
    assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
    assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseModelJson('Sure! Here it is: {"a":1} Enjoy.'), { a: 1 });
  });

  it('returns null for unparseable content', () => {
    assert.equal(parseModelJson('no json here'), null);
    assert.equal(parseModelJson('{broken'), null);
    assert.equal(parseModelJson(undefined), null);
  });
});

describe('config helpers', () => {
  it('requires a non-blank API key', () => {
    assert.throws(() => requireApiKey({}), (error) => error instanceof HttpError && error.code === 'missing_api_key');
    assert.throws(() => requireApiKey({ GROQ_API_KEY: '   ' }), HttpError);
    assert.equal(requireApiKey({ GROQ_API_KEY: ' k ' }), 'k');
    assert.equal(requireApiKey({ GROQ_API_KEY: ' "gsk_abc" \n' }), 'gsk_abc');
    assert.equal(requireApiKey({ GROQ_API_KEY: "'gsk_abc'" }), 'gsk_abc');
  });

  it('allows overriding the model', () => {
    assert.equal(resolveModel({}), DEFAULT_MODEL);
    assert.equal(resolveModel({ GROQ_MODEL: 'llama-3.3-70b-versatile' }), 'llama-3.3-70b-versatile');
  });
});

describe('requestGroqJson', () => {
  beforeEach(() => clearModelOverrides());

  it('sends a JSON-mode request and returns the validated object', async () => {
    const fetchImpl = fakeFetch([groqReply({ ok: true })]);
    const result = await requestGroqJson({ ...base, model: 'm', fetchImpl, validate: (value) => ({ ...value, checked: true }) });

    assert.deepEqual(result, { ok: true, checked: true });
    const [call] = fetchImpl.calls;
    assert.equal(call.url, GROQ_URL);
    assert.equal(call.init.headers.Authorization, 'Bearer test-key');
    assert.equal(call.body.model, 'm');
    assert.deepEqual(call.body.response_format, { type: 'json_object' });
    assert.ok(call.init.signal instanceof AbortSignal);
  });

  it('retries once on unusable output, then succeeds', async () => {
    const fetchImpl = fakeFetch([
      jsonResponse({ error: { code: 'json_validate_failed', message: 'bad json' } }, 400),
      groqReply('not json at all'),
      groqReply({ topics: ['x'] }),
    ]);
    const result = await requestGroqJson({ ...base, attempts: 3, fetchImpl });
    assert.deepEqual(result, { topics: ['x'] });
    assert.equal(fetchImpl.calls.length, 3);
  });

  it('gives up with a 502 when validation keeps failing', async () => {
    const fetchImpl = fakeFetch(() => groqReply({ wrong: true }));
    const validate = () => {
      throw new AiOutputError('bad shape');
    };
    await assert.rejects(requestGroqJson({ ...base, fetchImpl, validate }), { status: 502, code: 'ai_bad_output' });
    assert.equal(fetchImpl.calls.length, 2);
  });

  it('does not retry non-output errors thrown by validate', async () => {
    const fetchImpl = fakeFetch(() => groqReply({}));
    const validate = () => {
      throw new TypeError('bug');
    };
    await assert.rejects(requestGroqJson({ ...base, fetchImpl, validate }), TypeError);
    assert.equal(fetchImpl.calls.length, 1);
  });

  const statusCases = [
    [401, { status: 502, code: 'ai_auth_failed' }],
    [404, { status: 502, code: 'ai_model_unavailable' }],
    [500, { status: 502, code: 'ai_unavailable' }],
    [400, { status: 502, code: 'ai_request_rejected' }],
  ];
  for (const [status, expected] of statusCases) {
    it(`maps upstream HTTP ${status} to ${expected.code} without retrying`, async () => {
      const fetchImpl = fakeFetch(() => jsonResponse({ error: { message: 'nope' } }, status));
      await assert.rejects(requestGroqJson({ ...base, fetchImpl, autoFallback: false }), expected);
      assert.equal(fetchImpl.calls.length, 1);
    });
  }

  it('maps decommissioned models to a helpful error', async () => {
    const fetchImpl = fakeFetch([jsonResponse({ error: { code: 'model_decommissioned' } }, 400)]);
    await assert.rejects(requestGroqJson({ ...base, model: 'old-model', fetchImpl }), {
      code: 'ai_model_unavailable',
      message: /old-model/,
    });
  });

  it('includes Groq\'s own reason when it rejects a request', async () => {
    const fetchImpl = fakeFetch([jsonResponse({ error: { message: 'Organization has been restricted.' } }, 400)]);
    await assert.rejects(requestGroqJson({ ...base, fetchImpl }), {
      code: 'ai_request_rejected',
      message: /Groq says: "Organization has been restricted\."/,
    });
  });

  it('switches to an available model when the configured one is retired, and remembers it', async () => {
    const retired = jsonResponse({ error: { code: 'model_decommissioned', message: 'The model has been decommissioned' } }, 400);
    const models = jsonResponse({ data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }, { id: 'old-model' }] });
    const fetchImpl = fakeFetch([retired, models, groqReply({ ok: 1 })]);

    const result = await requestGroqJson({ ...base, model: 'old-model', fetchImpl });
    assert.deepEqual(result, { ok: 1 });
    assert.deepEqual(
      fetchImpl.calls.map((c) => [c.url, c.body?.model]),
      [
        [GROQ_URL, 'old-model'],
        [GROQ_MODELS_URL, undefined],
        [GROQ_URL, 'openai/gpt-oss-20b'],
      ],
    );

    // The next request goes straight to the replacement.
    const next = fakeFetch([groqReply({ ok: 2 })]);
    await requestGroqJson({ ...base, model: 'old-model', fetchImpl: next });
    assert.equal(next.calls[0].body.model, 'openai/gpt-oss-20b');
  });

  it('prefers known-good replacements and skips non-chat models', async () => {
    const fetchImpl = fakeFetch([
      jsonResponse({ data: [{ id: 'distil-whisper' }, { id: 'some-new-llm' }, { id: 'llama-3.3-70b-versatile' }] }),
      jsonResponse({ data: [{ id: 'whisper-large-v3' }, { id: 'some-new-llm' }, { id: 'retired', active: false }] }),
      jsonResponse({ error: {} }, 500),
    ]);
    assert.equal(await findReplacementModel({ apiKey: 'k', fetchImpl }), 'llama-3.3-70b-versatile');
    assert.equal(await findReplacementModel({ apiKey: 'k', fetchImpl }), 'some-new-llm');
    assert.equal(await findReplacementModel({ apiKey: 'k', fetchImpl }), null);
  });

  it('passes 429s through with Retry-After', async () => {
    const fetchImpl = fakeFetch([jsonResponse({ error: {} }, 429, { 'retry-after': '6.2' })]);
    await assert.rejects(requestGroqJson({ ...base, fetchImpl }), { status: 429, code: 'ai_rate_limited', retryAfter: 7 });
  });

  it('reports network failures and timeouts distinctly', async () => {
    await assert.rejects(requestGroqJson({ ...base, fetchImpl: fakeFetch([new TypeError('fetch failed')]) }), {
      status: 502,
      code: 'ai_unreachable',
    });

    // AbortSignal.timeout() timers are unref'd, so hold the event loop open like a live server would.
    const hangingFetch = (url, init) =>
      new Promise((_, reject) => {
        const keepAlive = setTimeout(() => {}, 5000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason);
        });
      });
    await assert.rejects(requestGroqJson({ ...base, fetchImpl: hangingFetch, timeoutMs: 20 }), {
      status: 504,
      code: 'ai_timeout',
    });
  });
});
