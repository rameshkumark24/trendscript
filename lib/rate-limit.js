import { HttpError } from './errors.js';
import { clientKey } from './http.js';

const DEFAULT_LIMIT_PER_MINUTE = 20;
const MAX_TRACKED_CLIENTS = 5000;

/**
 * Fixed-window, in-memory limiter. On serverless platforms each warm instance
 * keeps its own counters, so this is a speed bump against scripted abuse of
 * the Groq key rather than a hard global quota.
 */
export function createRateLimiter({ windowMs = 60_000, now = Date.now } = {}) {
  const windows = new Map();

  function prune(time) {
    for (const [key, entry] of windows) {
      if (time - entry.start >= windowMs) windows.delete(key);
    }
  }

  return function check(key, limit) {
    if (!(limit > 0)) return { allowed: true };
    const time = now();
    let entry = windows.get(key);
    if (!entry || time - entry.start >= windowMs) {
      if (windows.size >= MAX_TRACKED_CLIENTS) prune(time);
      entry = { start: time, count: 0 };
      windows.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((entry.start + windowMs - time) / 1000)) };
    }
    return { allowed: true };
  };
}

export function limitFromEnv(env) {
  const raw = env.RATE_LIMIT_PER_MINUTE;
  if (raw === undefined || raw === '') return DEFAULT_LIMIT_PER_MINUTE;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_LIMIT_PER_MINUTE;
}

export function enforceRateLimit(limiter, req, env) {
  const result = limiter(clientKey(req), limitFromEnv(env));
  if (!result.allowed) {
    throw new HttpError(429, 'Too many requests. Please wait a moment and try again.', {
      code: 'rate_limited',
      retryAfter: result.retryAfter,
    });
  }
}
