// Shared helpers for the serverless API routes.
// Files inside `api/_lib` are not exposed as routes by Vercel (underscore prefix).

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_MODEL = 'llama-3.1-8b-instant';
export const MAX_INPUT_LENGTH = 120;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Vercel parses JSON bodies automatically, but a missing/incorrect Content-Type
// (or a plain Node server) leaves us with a string or an unread stream.
export async function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    return parseBodyText(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
  }
  if (typeof req.on !== 'function') return {};

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10_000) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk);
  }
  return parseBodyText(Buffer.concat(chunks).toString('utf8'));
}

function parseBodyText(text) {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

// Collapse whitespace, strip control characters and enforce a length limit.
export function cleanText(value, maxLength = MAX_INPUT_LENGTH) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function requireInput(body, field, label) {
  const value = cleanText(body?.[field]);
  if (!value) throw new HttpError(400, `${label} is required.`);
  return value;
}

export function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

export function allowPostOnly(req, res) {
  if (req.method === 'POST') return true;
  res.setHeader('Allow', 'POST');
  sendJson(res, 405, { error: 'Method not allowed.' });
  return false;
}

export function handleError(res, error, fallbackMessage) {
  if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
  console.error('API ERROR:', error);
  sendJson(res, 500, { error: fallbackMessage });
}

const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
// Tried in order when the configured model is retired or unavailable on the account.
export const FALLBACK_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'];
const NON_CHAT_MODEL = /whisper|tts|guard|playai|orpheus|compound|prompt-guard/i;
const MAX_ATTEMPTS = 3;

// Remembers a working fallback for the lifetime of the (warm) serverless instance.
let resolvedModel = null;

export function resetModelCache() {
  resolvedModel = null;
}

function getApiKey() {
  // Env values pasted into a dashboard often carry stray whitespace or quotes.
  const apiKey = (process.env.GROQ_API_KEY || '').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!apiKey) throw new HttpError(500, 'Server is missing GROQ_API_KEY.');
  return apiKey;
}

function isModelError(status, error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === 'model_not_found' || code === 'model_decommissioned' ||
    ((status === 400 || status === 404) && /model/i.test(message) &&
      /decommission|not found|does not exist|not supported|no longer|access/i.test(message));
}

// Picks the next model to try, preferring ones the account can actually use.
async function pickFallbackModel(apiKey, tried, fetchImpl) {
  let available = null;
  try {
    const response = await fetchImpl(GROQ_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    const data = await response.json();
    if (response.ok && Array.isArray(data?.data)) {
      available = data.data.filter(m => m?.id && m.active !== false).map(m => m.id);
    }
  } catch {
    // Fall through to the static list.
  }

  const untried = id => !tried.has(id);
  if (available) {
    return FALLBACK_MODELS.find(id => available.includes(id) && untried(id)) ||
      available.find(id => untried(id) && !NON_CHAT_MODEL.test(id)) || null;
  }
  return FALLBACK_MODELS.find(untried) || null;
}

function describeProviderError(status, error) {
  const detail = String(error?.message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return `The AI provider rejected the request (${status}${detail ? `: ${detail}` : ''}).`;
}

// Calls Groq's chat completion endpoint in JSON mode and returns the parsed object.
// Retries on transient JSON-mode failures and switches models if the configured one is retired.
export async function callGroqJson(messages, { temperature = 0.7, timeoutMs = 25_000, fetchImpl = globalThis.fetch } = {}) {
  const apiKey = getApiKey();
  let model = resolvedModel || cleanText(process.env.GROQ_MODEL, 100) || DEFAULT_MODEL;
  const tried = new Set();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    tried.add(model);
    let response;
    try {
      response = await fetchImpl(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, temperature, response_format: { type: 'json_object' }, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new HttpError(504, 'The AI provider took too long to respond. Please try again.');
      }
      throw error;
    }

    const data = await response.json().catch(() => null);
    const lastAttempt = attempt === MAX_ATTEMPTS;

    if (!response.ok || !data || data.error) {
      const error = data?.error;
      console.error('GROQ ERROR:', response.status, model, error);

      if (response.status === 401) throw new HttpError(500, 'Groq rejected the configured GROQ_API_KEY (401). Check the key and redeploy.');
      if (response.status === 429) throw new HttpError(429, 'AI rate limit reached. Please wait a moment and try again.');

      if (!lastAttempt && isModelError(response.status, error)) {
        const next = await pickFallbackModel(apiKey, tried, fetchImpl);
        if (next) {
          console.warn(`Model "${model}" unavailable; retrying with "${next}".`);
          model = next;
          continue;
        }
      }
      // Groq returns 400 json_validate_failed when the model emits invalid JSON; a retry usually succeeds.
      if (!lastAttempt && (error?.code === 'json_validate_failed' || response.status >= 500)) continue;

      throw new HttpError(502, describeProviderError(response.status, error));
    }

    try {
      const parsed = JSON.parse(data.choices?.[0]?.message?.content);
      if (model !== (cleanText(process.env.GROQ_MODEL, 100) || DEFAULT_MODEL)) resolvedModel = model;
      return parsed;
    } catch {
      if (lastAttempt) throw new HttpError(502, 'The AI returned malformed data. Please try again.');
    }
  }
}
