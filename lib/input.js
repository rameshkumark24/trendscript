import { HttpError } from './errors.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Collapses whitespace, strips control characters and caps the length. */
export function cleanText(value, maxLength = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
}

export function requireText(value, { label, maxLength, minLength = 2 }) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new HttpError(400, `${label} must be text.`, { code: 'invalid_input' });
  }
  const cleaned = cleanText(value, maxLength);
  if (cleaned.length < minLength) {
    throw new HttpError(400, `${label} is required (at least ${minLength} characters).`, {
      code: 'invalid_input',
    });
  }
  return cleaned;
}

export function pickOption(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/** Case-insensitive de-duplication that keeps the first spelling seen. */
export function dedupe(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}
