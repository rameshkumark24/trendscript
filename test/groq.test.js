import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { AiOutputError, HttpError } from '../lib/errors.js';
import {
  DEFAULT_MODEL,
  GROQ_MODELS_URL,
  GROQ_URL,
  RESCUE_MODEL,
  clearModelOverrides,
  findReplacementModel,
  parseModelJson,
  repairJson,
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

  it('repairs trailing commas, cut-off output and raw line breaks', () => {
    assert.deepEqual(parseModelJson('{"topics": ["a", "b",]}'), { topics: ['a', 'b'] });
    assert.deepEqual(parseModelJson('Sure!\n```json\n{"topics": ["a", "b"'), { topics: ['a', 'b'] });
    assert.deepEqual(parseModelJson('{"hook": "line one\nline two"}'), { hook: 'line one\nline two' });
    assert.deepEqual(parseModelJson('{"script": {"hook": "Stop scrolling", "cta": "Follow for'), {
      script: { hook: 'Stop scrolling', cta: 'Follow for' },
    });
    assert.equal(repairJson('{"a": [1, 2,'), '{"a": [1, 2]}');
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

  it('retries without JSON mode when Groq keeps rejecting the output', async () => {
    const fetchImpl = fakeFetch([
      jsonResponse({ error: { code: 'json_validate_failed', message: 'Failed to generate JSON', failed_generation: '' } }, 400),
      groqReply('Here you go: {"topics": ["a"]}'),
    ]);
    assert.deepEqual(await requestGroqJson({ ...base, attempts: 1, fetchImpl }), { topics: ['a'] });
    assert.deepEqual(fetchImpl.calls[0].body.response_format, { type: 'json_object' });
    assert.equal(fetchImpl.calls[1].body.response_format, undefined);
  });

  it('uses parseText to salvage plain-text answers', async () => {
    const fetchImpl = fakeFetch([groqReply('1. First idea\n2. Second idea')]);
    const parseText = (text) => ({ lines: text.split('\n') });
    assert.deepEqual(await requestGroqJson({ ...base, fetchImpl, parseText }), { lines: ['1. First idea', '2. Second idea'] });
  });

  it('salvages the rejected text Groq returns with json_validate_failed', async () => {
    const failed = jsonResponse(
      { error: { code: 'json_validate_failed', message: 'Failed to generate JSON', failed_generation: 'Here you go: {"topics": ["a"]}' } },
      400,
    );
    const fetchImpl = fakeFetch([failed]);
    assert.deepEqual(await requestGroqJson({ ...base, fetchImpl }), { topics: ['a'] });
    assert.equal(fetchImpl.calls.length, 1);
  });

  it('retries unusable output with the rescue model and explains a final failure', async () => {
    const fetchImpl = fakeFetch(() => groqReply({ wrong: true }));
    const validate = (value) => {
      if (!value.ok) throw new AiOutputError('Script is missing: cta');
      return value;
    };
    await assert.rejects(requestGroqJson({ ...base, model: 'small', attempts: 3, rescueModel: RESCUE_MODEL, fetchImpl, validate }), {
      code: 'ai_bad_output',
      message: /Script is missing: cta/,
    });
    assert.deepEqual(
      fetchImpl.calls.map((c) => c.body.model),
      ['small', RESCUE_MODEL, RESCUE_MODEL],
    );

    const recovering = fakeFetch([groqReply({ wrong: true }), groqReply({ ok: true })]);
    const result = await requestGroqJson({ ...base, model: 'small', attempts: 3, rescueModel: RESCUE_MODEL, fetchImpl: recovering, validate });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(recovering.calls.map((c) => c.body.model), ['small', RESCUE_MODEL]);
  });

  it('keeps using the configured model if the rescue model is unavailable', async () => {
    const fetchImpl = fakeFetch([
      groqReply({ wrong: true }),
      jsonResponse({ error: { code: 'model_not_found', message: 'no such model' } }, 404),
      groqReply({ ok: true }),
    ]);
    const validate = (value) => {
      if (!value.ok) throw new AiOutputError('bad');
      return value;
    };
    const result = await requestGroqJson({ ...base, model: 'small', attempts: 3, rescueModel: RESCUE_MODEL, fetchImpl, validate });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(fetchImpl.calls.map((c) => c.body.model), ['small', RESCUE_MODEL, 'small']);
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
