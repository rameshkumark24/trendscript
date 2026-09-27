import { AiOutputError, HttpError } from './errors.js';

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
export const DEFAULT_MODEL = 'llama-3.1-8b-instant';
// Larger model used for the retry when the default one returns unusable output.
export const RESCUE_MODEL = 'llama-3.3-70b-versatile';

// Preferred replacements, in order, when the configured model is retired.
export const FALLBACK_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
const NON_CHAT_MODEL = /whisper|tts|guard|playai|orpheus|compound|distil/i;
const MAX_MODEL_FALLBACKS = 2;

// Working replacement per configured model, remembered while the instance is warm.
const modelOverrides = new Map();

export function clearModelOverrides() {
  modelOverrides.clear();
}

export function requireApiKey(env) {
  // Values pasted into a dashboard often carry stray whitespace or quotes.
  const raw = typeof env.GROQ_API_KEY === 'string' ? env.GROQ_API_KEY.trim() : '';
  const apiKey = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
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

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Fixes the flaws models most often leave in JSON: trailing commas, raw line
 * breaks inside strings, and output cut off before the closing brackets.
 */
export function repairJson(text) {
  let out = '';
  const closers = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === '\n' || ch === '\r') {
        out += ch === '\n' ? '\\n' : '';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') closers.push('}');
    else if (ch === '[') closers.push(']');
    else if (ch === '}' || ch === ']') closers.pop();
    out += ch;
  }
  if (escaped) out = out.slice(0, -1);
  if (inString) out += '"';
  out = out.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
  out += closers.reverse().join('');
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Parses a JSON object out of model text, tolerating Markdown code fences,
 * chatter around the object and small syntax flaws. Returns null when
 * nothing parseable is found.
 */
export function parseModelJson(content) {
  if (typeof content !== 'string') return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const whole = start === -1 ? null : text.slice(start);
  const trimmed = start !== -1 && end > start ? text.slice(start, end + 1) : null;
  // Exact parses first; then repairs, preferring everything after the first
  // brace so a cut-off answer isn't shortened to an earlier inner object.
  const attempts = [text, trimmed, whole && repairJson(whole), trimmed && repairJson(trimmed), repairJson(text)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    const parsed = tryParse(attempt);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

async function readJson(response) {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

// Groq's own explanation (e.g. "Invalid API Key"), which never echoes secrets.
function upstreamDetail(data) {
  const message = typeof data?.error?.message === 'string' ? data.error.message.replace(/\s+/g, ' ').trim() : '';
  return message ? ` Groq says: "${message.slice(0, 200)}"` : '';
}

function toHttpError(status, data, model, retryAfterHeader) {
  const upstreamCode = data?.error?.code;
  if (status === 401 || status === 403) {
    return new HttpError(502, `The AI service rejected the API key. Check GROQ_API_KEY.${upstreamDetail(data)}`, {
      code: 'ai_auth_failed',
    });
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
  return new HttpError(502, `The AI service rejected the request.${upstreamDetail(data)}`, { code: 'ai_request_rejected' });
}

/**
 * Asks Groq which models this key can use and picks a replacement chat model
 * that hasn't been tried yet. Returns null if the list can't be fetched.
 */
export async function findReplacementModel({ apiKey, exclude = new Set(), fetchImpl, timeoutMs = 5_000 }) {
  let ids;
  try {
    const response = await fetchImpl(GROQ_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) return null;
    const data = await readJson(response);
    ids = Array.isArray(data?.data)
      ? data.data.filter((m) => typeof m?.id === 'string' && m.active !== false).map((m) => m.id)
      : [];
  } catch {
    return null;
  }
  const usable = ids.filter((id) => !exclude.has(id));
  return FALLBACK_MODELS.find((id) => usable.includes(id)) ?? usable.find((id) => !NON_CHAT_MODEL.test(id)) ?? null;
}

function snippet(text) {
  return typeof text === 'string' ? JSON.stringify(text.slice(0, 300)) : String(text);
}

async function requestOnce({ apiKey, model, messages, temperature, maxTokens, timeoutMs, jsonMode, parseText, fetchImpl, logger }) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (jsonMode) body.response_format = { type: 'json_object' };

  let response;
  try {
    response = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
    // Groq's JSON mode rejects the whole answer server-side when the model's
    // output isn't strictly valid JSON (often a loop or a cut-off reply).
    // Salvage what it sent back; otherwise the caller retries without JSON mode.
    if (response.status === 400 && data?.error?.code === 'json_validate_failed') {
      const failed = data.error.failed_generation;
      const salvaged = parseModelJson(failed) ?? parseText?.(failed);
      if (salvaged && typeof salvaged === 'object') return salvaged;
      logger.warn(`[trendscript] Groq JSON mode rejected output from "${model}": ${snippet(failed)}`);
      const error = new AiOutputError('Groq could not produce valid JSON');
      error.jsonModeFailed = true;
      throw error;
    }
    throw toHttpError(response.status, data, model, response.headers.get('retry-after'));
  }

  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  const parsed = parseModelJson(content) ?? parseText?.(content);
  if (!parsed || typeof parsed !== 'object') {
    logger.warn(`[trendscript] Unparseable output from "${model}" (finish_reason=${choice?.finish_reason}): ${snippet(content)}`);
    throw new AiOutputError(choice?.finish_reason === 'length' ? 'The answer was cut off' : 'The answer was not valid JSON');
  }
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
  rescueModel = null,
  parseText = null,
  autoFallback = true,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  let activeModel = modelOverrides.get(model) ?? model;
  const tried = new Set();
  let fallbacks = 0;
  let lastProblem = '';
  let jsonMode = true;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // After unusable output, retry with the larger model: small models drift from nested schemas.
    const rescuing = Boolean(lastProblem && rescueModel && rescueModel !== activeModel);
    const requestModel = rescuing ? rescueModel : activeModel;
    try {
      const parsed = await requestOnce({
        apiKey,
        model: requestModel,
        messages,
        temperature,
        maxTokens,
        timeoutMs,
        jsonMode,
        parseText,
        fetchImpl,
        logger,
      });
      return validate(parsed);
    } catch (error) {
      if (rescuing && error instanceof HttpError && error.code === 'ai_model_unavailable') {
        logger.warn(`[trendscript] Rescue model "${rescueModel}" is unavailable; retrying with "${activeModel}".`);
        rescueModel = null;
        continue;
      }
      // A retired or unknown model: switch to one the account can use instead of failing every request.
      if (autoFallback && error instanceof HttpError && error.code === 'ai_model_unavailable' && fallbacks < MAX_MODEL_FALLBACKS) {
        tried.add(model).add(activeModel);
        const replacement = await findReplacementModel({ apiKey, exclude: tried, fetchImpl });
        if (replacement) {
          logger.warn(`[trendscript] Model "${activeModel}" is unavailable; using "${replacement}" instead.`);
          modelOverrides.set(model, replacement);
          activeModel = replacement;
          fallbacks += 1;
          attempt -= 1; // a model switch doesn't spend an output retry
          continue;
        }
      }
      if (!(error instanceof AiOutputError)) throw error;
      if (error.jsonModeFailed && jsonMode) {
        // Stop relying on Groq's server-side JSON check; parse the plain answer ourselves.
        jsonMode = false;
        logger.warn(`[trendscript] Retrying "${requestModel}" without JSON mode.`);
        attempt -= 1; // this switch doesn't spend a retry
        continue;
      }
      lastProblem = error.message;
      logger.warn(`[trendscript] Unusable AI output from "${requestModel}" (attempt ${attempt}/${attempts}): ${error.message}`);
    }
  }
  throw new HttpError(502, `The AI returned an incomplete answer (${lastProblem || 'unknown problem'}). Please try again.`, {
    code: 'ai_bad_output',
  });
}
