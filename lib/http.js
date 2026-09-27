import { HttpError } from './errors.js';

// These helpers only touch Node's core request/response API so the same
// handlers run unchanged on Vercel, in the local dev server and in tests.

export function sendJson(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

export function sendError(res, error, logger = console) {
  if (error instanceof HttpError) {
    const headers = { ...error.headers };
    if (error.retryAfter) headers['Retry-After'] = String(error.retryAfter);
    return sendJson(res, error.status, { error: error.message, code: error.code }, headers);
  }
  logger.error('[trendscript] Unexpected error:', error);
  return sendJson(res, 500, {
    error: 'Something went wrong on our side. Please try again.',
    code: 'internal_error',
  });
}

export function assertPost(req) {
  if (req.method !== 'POST') {
    throw new HttpError(405, 'Method not allowed. Use POST.', {
      code: 'method_not_allowed',
      headers: { Allow: 'POST' },
    });
  }
}

/**
 * Returns the parsed JSON body as a plain object. Requiring a JSON content
 * type means browsers on other origins must pass a CORS preflight (which we
 * never grant) before they can spend this deployment's AI quota.
 */
export function readJsonBody(req) {
  const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, 'Requests must be sent as JSON.', { code: 'unsupported_media_type' });
  }

  let body;
  try {
    // Vercel parses the body lazily and throws on malformed JSON.
    body = req.body;
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      const text = body.toString();
      body = text.trim() ? JSON.parse(text) : {};
    }
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.', { code: 'invalid_json' });
  }

  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object.', { code: 'invalid_body' });
  }
  return body;
}

export function clientKey(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}
