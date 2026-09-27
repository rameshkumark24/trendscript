import { AiOutputError } from './errors.js';
import { cleanText, dedupe } from './input.js';

// LLM output is untrusted: it can drift from the requested schema, rename
// keys, or return the wrong types. Everything the frontend renders passes
// through here so it always receives the same, predictable shape.

export const SCRIPT_PHASES = ['hook', 'buildup', 'climax', 'cta'];

// Small models often rename the script sections ("Hook (0-3s)", "build_up",
// "call to action", "payoff"...), so keys are matched loosely by prefix.
const PHASE_PATTERNS = {
  hook: /^(hook|opening|opener|intro)/,
  buildup: /^(buildup|build|setup|context|tension|problem)/,
  climax: /^(climax|payoff|reveal|solution|twist|value|answer|mainpoint)/,
  cta: /^(cta|calltoaction|call|outro|closing|close|ending|conclusion)/,
};
const PHASE_LABEL_KEYS = ['phase', 'section', 'part', 'name', 'label', 'type', 'segment', 'title'];
const PHASE_TEXT_KEYS = ['text', 'line', 'lines', 'content', 'script', 'dialogue', 'voiceover', 'narration', 'spoken', 'words', 'copy'];

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

export function canonicalPhase(key) {
  const compact = String(key ?? '').toLowerCase().replace(/[^a-z]/g, '');
  const byName = SCRIPT_PHASES.find((phase) => PHASE_PATTERNS[phase].test(compact));
  if (byName) return byName;

  // Keys named by their start time, e.g. "0-3s", "3-15s", "0:15".
  const time = String(key ?? '').match(/^\s*(\d{1,2})(?::(\d{2}))?/);
  if (!time) return null;
  const start = time[2] ? Number(time[1]) * 60 + Number(time[2]) : Number(time[1]);
  if (start < 3) return 'hook';
  if (start < 15) return 'buildup';
  if (start < 25) return 'climax';
  return start <= 30 ? 'cta' : null;
}

// A section's spoken text may arrive as a string, an array of lines, or an
// object such as {"text": "...", "duration": "3s"}.
function phaseText(value) {
  if (typeof value === 'string') return cleanText(value, 700);
  if (Array.isArray(value)) return cleanText(value.filter((line) => typeof line === 'string').join(' '), 700);
  if (isObject(value)) return firstText(value, PHASE_TEXT_KEYS, 700);
  return '';
}

function scriptFromObject(source) {
  const script = {};
  for (const [key, value] of Object.entries(source)) {
    const phase = canonicalPhase(key);
    if (phase && !script[phase]) script[phase] = phaseText(value);
  }
  return script;
}

function scriptFromArray(list) {
  const script = {};
  const unlabeled = [];
  for (const item of list) {
    const label = isObject(item) ? PHASE_LABEL_KEYS.map((key) => item[key]).find((v) => typeof v === 'string') : null;
    const phase = label ? canonicalPhase(label) : null;
    const text = phaseText(item);
    if (phase && !script[phase]) script[phase] = text;
    else if (text) unlabeled.push(text);
  }
  // Four unlabeled sections are almost certainly hook, build-up, climax, CTA in order.
  if (!Object.keys(script).length && unlabeled.length === SCRIPT_PHASES.length) {
    SCRIPT_PHASES.forEach((phase, index) => {
      script[phase] = unlabeled[index];
    });
  }
  return script;
}

// Last resort for a script returned as one paragraph: first sentence is the
// hook, last is the CTA, and the middle is split between build-up and climax.
function scriptFromText(text) {
  const sentences = cleanText(text, 2800).match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (sentences.length < SCRIPT_PHASES.length) return {};
  const middle = sentences.slice(1, -1);
  const half = Math.ceil(middle.length / 2);
  return {
    hook: sentences[0],
    buildup: middle.slice(0, half).join(' '),
    climax: middle.slice(half).join(' '),
    cta: sentences[sentences.length - 1],
  };
}

export function extractScript(source) {
  const script = {};
  const merge = (found) => {
    for (const phase of SCRIPT_PHASES) {
      if (!script[phase] && found[phase]) script[phase] = cleanText(found[phase], 700);
    }
  };

  for (const key of ['script', 'scripts', 'voiceover', 'narration', 'sections']) {
    const value = source[key];
    if (isObject(value)) merge(scriptFromObject(value));
    else if (Array.isArray(value)) merge(scriptFromArray(value));
  }
  merge(scriptFromObject(source)); // sections placed at the top level
  if (typeof source.script === 'string' && SCRIPT_PHASES.every((phase) => !script[phase])) {
    merge(scriptFromText(source.script));
  }
  return script;
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
  const source = isObject(raw.package) ? raw.package : isObject(raw.production_package) ? raw.production_package : raw;
  const script = extractScript(source);
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
