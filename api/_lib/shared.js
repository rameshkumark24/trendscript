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

// Calls Groq's chat completion endpoint in JSON mode and returns the parsed object.
export async function callGroqJson(messages, { temperature = 0.7, timeoutMs = 25_000, fetchImpl = globalThis.fetch } = {}) {
  // Env values pasted into a dashboard often carry stray whitespace or quotes.
  const apiKey = (process.env.GROQ_API_KEY || '').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!apiKey) throw new HttpError(500, 'Server is missing GROQ_API_KEY.');

  let response;
  try {
    response = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || DEFAULT_MODEL,
        temperature,
        response_format: { type: 'json_object' },
        messages,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new HttpError(504, 'The AI provider took too long to respond. Please try again.');
    }
    throw error;
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.error) {
    console.error('GROQ ERROR:', response.status, data?.error);
    if (response.status === 429) throw new HttpError(429, 'AI rate limit reached. Please wait a moment and try again.');
    if (response.status === 401) throw new HttpError(500, 'Groq rejected the configured GROQ_API_KEY (401). Check the key and redeploy.');
    throw new HttpError(502, 'The AI provider rejected the request.');
  }

  const content = data.choices?.[0]?.message?.content;
  try {
    return JSON.parse(content);
  } catch {
    throw new HttpError(502, 'The AI returned malformed data. Please try again.');
  }
}
