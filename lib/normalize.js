import { AiOutputError } from './errors.js';
import { cleanText, dedupe } from './input.js';

// LLM output is untrusted: it can drift from the requested schema, rename
// keys, or return the wrong types. Everything the frontend renders passes
// through here so it always receives the same, predictable shape.

export const SCRIPT_PHASES = ['hook', 'buildup', 'climax', 'cta'];

const SCRIPT_ALIASES = {
  hook: ['hook'],
  buildup: ['buildup', 'build_up', 'build-up', 'buildUp'],
  climax: ['climax', 'payoff'],
  cta: ['cta', 'call_to_action', 'callToAction'],
};

export const DEFAULT_CHAPTERS = [
  { time: '0:00', label: 'The Hook' },
  { time: '0:03', label: 'Build-up' },
  { time: '0:15', label: 'Climax' },
  { time: '0:25', label: 'Call to Action' },
];

const MAX_TOPICS = 6;
const MAX_HASHTAGS = 8;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripWrappingQuotes(text) {
  return text.replace(/^["'“‘]+|["'”’]+$/g, '').trim();
}

function firstText(source, keys, maxLength) {
  for (const key of keys) {
    const value = cleanText(source?.[key], maxLength);
    if (value) return value;
  }
  return '';
}

export function normalizeTopics(raw) {
  let list = raw?.topics;
  if (!Array.isArray(list) && isObject(raw)) list = Object.values(raw).find(Array.isArray);
  if (!Array.isArray(list)) throw new AiOutputError('Response has no topics array');

  const topics = list
    .map((item) => (typeof item === 'string' ? item : (item?.title ?? item?.topic)))
    .map((item) => stripWrappingQuotes(cleanText(item, 140)))
    .filter((item) => item.length >= 3);

  const unique = dedupe(topics).slice(0, MAX_TOPICS);
  if (!unique.length) throw new AiOutputError('Response contained no usable topics');
  return unique;
}

export function normalizeHashtags(value) {
  let items = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.split(/[\s,]+/);

  const tags = items
    .filter((item) => typeof item === 'string')
    .map((item) => item.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(Boolean)
    .map((item) => `#${item}`);

  const unique = dedupe(tags).slice(0, MAX_HASHTAGS - 1);
  if (!unique.some((tag) => tag.toLowerCase() === '#shorts')) unique.push('#shorts');
  return unique;
}

function toSeconds(time) {
  const [minutes, seconds] = time.split(':').map(Number);
  return minutes * 60 + seconds;
}

function parseChapter(item) {
  if (typeof item === 'string') {
    const match = item.trim().match(/^(\d{1,2}:\d{2})\s*[-–—:|]?\s*(.+)$/);
    return match ? { time: match[1], label: cleanText(match[2], 60) } : null;
  }
  if (!isObject(item)) return null;
  return {
    time: cleanText(String(item.time ?? item.timestamp ?? ''), 8),
    label: firstText(item, ['label', 'title', 'name'], 60),
  };
}

export function normalizeChapters(value) {
  if (!Array.isArray(value)) return DEFAULT_CHAPTERS.map((chapter) => ({ ...chapter }));

  const chapters = value
    .map(parseChapter)
    .filter((chapter) => chapter && /^\d{1,2}:[0-5]\d$/.test(chapter.time) && chapter.label)
    .map((chapter) => ({ time: chapter.time.replace(/^0(\d:)/, '$1'), label: chapter.label }))
    .sort((a, b) => toSeconds(a.time) - toSeconds(b.time));

  const unique = chapters.filter((chapter, index) => index === 0 || chapter.time !== chapters[index - 1].time);
  if (unique.length < 2) return DEFAULT_CHAPTERS.map((chapter) => ({ ...chapter }));
  unique[0] = { ...unique[0], time: '0:00' }; // YouTube timelines must start at 0:00.
  return unique;
}

export function normalizePackage(raw, { topic }) {
  if (!isObject(raw)) throw new AiOutputError('Package is not an object');
  const source = isObject(raw.package) ? raw.package : raw;
  const scriptSource = isObject(source.script) ? source.script : source;

  const script = {};
  for (const phase of SCRIPT_PHASES) {
    script[phase] = firstText(scriptSource, SCRIPT_ALIASES[phase], 700);
  }
  const missing = SCRIPT_PHASES.filter((phase) => !script[phase]);
  if (missing.length) throw new AiOutputError(`Script is missing: ${missing.join(', ')}`);

  return {
    title: stripWrappingQuotes(firstText(source, ['title'], 120)) || topic,
    thumbnail_idea: firstText(source, ['thumbnail_idea', 'thumbnail', 'visual'], 400),
    caption: firstText(source, ['caption', 'description'], 500),
    hashtags: normalizeHashtags(source.hashtags ?? source.tags),
    chapters: normalizeChapters(source.chapters),
    script,
  };
}
