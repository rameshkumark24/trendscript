import { AiOutputError, HttpError } from './errors.js';

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_MODEL = 'llama-3.1-8b-instant';

export function requireApiKey(env) {
  const apiKey = typeof env.GROQ_API_KEY === 'string' ? env.GROQ_API_KEY.trim() : '';
  if (!apiKey) {
    throw new HttpError(500, 'The server is missing GROQ_API_KEY. Add it to your environment variables.', {
      code: 'missing_api_key',
    });
  }
  return apiKey;
}

export function resolveModel(env) {
  const model = typeof env.GROQ_MODEL === 'string' ? env.GROQ_MODEL.trim() : '';
  return model || DEFAULT_MODEL;
}

/**
 * Parses a JSON object out of model text, tolerating Markdown code fences or
 * chatter around the object. Returns null when nothing parseable is found.
 */
export function parseModelJson(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function readJson(response) {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

function toHttpError(status, data, model, retryAfterHeader) {
  const upstreamCode = data?.error?.code;
  if (status === 401 || status === 403) {
    return new HttpError(502, 'The AI service rejected the API key. Check GROQ_API_KEY.', { code: 'ai_auth_failed' });
  }
  if (status === 429) {
    const retryAfter = Math.ceil(Number(retryAfterHeader)) || undefined;
    return new HttpError(429, 'The AI service is rate limited right now. Please wait a moment and try again.', {
      code: 'ai_rate_limited',
      retryAfter,
    });
  }
  if (status === 404 || upstreamCode === 'model_not_found' || upstreamCode === 'model_decommissioned') {
    return new HttpError(502, `The AI model "${model}" is unavailable. Set GROQ_MODEL to a supported model.`, {
      code: 'ai_model_unavailable',
    });
  }
  if (status >= 500) {
    return new HttpError(502, 'The AI service is having trouble right now. Please try again shortly.', {
      code: 'ai_unavailable',
    });
  }
  return new HttpError(502, 'The AI service rejected the request.', { code: 'ai_request_rejected' });
}

async function requestOnce({ apiKey, model, messages, temperature, maxTokens, timeoutMs, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new HttpError(504, 'The AI service took too long to respond. Please try again.', { code: 'ai_timeout' });
    }
    throw new HttpError(502, 'Could not reach the AI service. Please try again.', { code: 'ai_unreachable' });
  }

  const data = await readJson(response);
  if (!response.ok) {
    // JSON mode fails server-side when the model emits invalid JSON; that is
    // an output problem worth retrying, not a request problem.
    if (response.status === 400 && data?.error?.code === 'json_validate_failed') {
      throw new AiOutputError('Groq could not produce valid JSON');
    }
    throw toHttpError(response.status, data, model, response.headers.get('retry-after'));
  }

  const parsed = parseModelJson(data?.choices?.[0]?.message?.content);
  if (!parsed || typeof parsed !== 'object') throw new AiOutputError('Model response was not a JSON object');
  return parsed;
}

/**
 * Calls Groq in JSON mode and runs `validate` on the parsed object. Output
 * problems (bad JSON, failed validation) are retried; transport and HTTP
 * errors are surfaced immediately as HttpErrors.
 */
export async function requestGroqJson({
  apiKey,
  model = DEFAULT_MODEL,
  messages,
  validate = (value) => value,
  temperature = 0.7,
  maxTokens = 1024,
  timeoutMs = 15_000,
  attempts = 2,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const parsed = await requestOnce({ apiKey, model, messages, temperature, maxTokens, timeoutMs, fetchImpl });
      return validate(parsed);
    } catch (error) {
      if (!(error instanceof AiOutputError)) throw error;
      logger.warn(`[trendscript] Unusable AI output (attempt ${attempt}/${attempts}): ${error.message}`);
    }
  }
  throw new HttpError(502, 'The AI returned an incomplete answer. Please try again.', { code: 'ai_bad_output' });
}
