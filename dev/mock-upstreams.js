import { GROQ_URL } from '../lib/groq.js';

// Offline stand-ins for Google Trends, Google Autocomplete and Groq, used by
// `npm run dev:mock` and the test suite. Responses are shaped exactly like
// the real services' so the production code paths run unchanged.
//
// Mock-only switches (put them in the niche or topic):
//   "ratelimit"     -> Groq answers 429
//   "trends-down"   -> Google Trends answers with an HTML block page

const AUTOCOMPLETE_PREFIX = 'https://suggestqueries.google.com/complete/search';

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function mockTopics({ niche, keywords = [] }) {
  const seeds = keywords.length ? keywords : [niche];
  const templates = [
    (k) => `Why everyone is suddenly searching "${k}"`,
    (k) => `The ${k} mistake 90% of people make`,
    (k) => `${k}: what nobody tells beginners`,
    (k) => `I tried ${k} for 7 days. Here's what happened`,
    (k) => `The fastest way to get started with ${k}`,
    (k) => `Stop doing this if you care about ${k}`,
  ];
  return { topics: templates.map((template, index) => template(seeds[index % seeds.length])) };
}

function mockPackage({ topic, niche }) {
  const subject = niche || 'this';
  return {
    title: topic.length > 58 ? `${topic.slice(0, 57)}…` : topic,
    thumbnail_idea: `Extreme close-up of a shocked face next to bold text reading "${topic.split(' ').slice(0, 4).join(' ')}".`,
    caption: `Most people get ${subject} completely wrong. Here's the 30-second fix that actually works.`,
    hashtags: ['#shorts', `#${subject.replace(/[^\p{L}\p{N}]/gu, '')}`, '#tips', '#learnontiktok'],
    chapters: [
      { time: '0:00', label: 'The Hook' },
      { time: '0:03', label: 'Why it matters' },
      { time: '0:15', label: 'The reveal' },
      { time: '0:25', label: 'Your next step' },
    ],
    script: {
      hook: 'Stop scrolling. You are doing this completely wrong.',
      buildup:
        'Every day thousands of people search for this exact problem, try the obvious fix, and give up a week later. The reason is simple, and almost nobody talks about it.',
      climax:
        'Start with the smallest possible version, do it at the same time every day, and track one number. Consistency beats intensity every single time.',
      cta: 'Follow for part two, where I show the exact routine.',
    },
  };
}

export function createMockUpstreams({ latencyMs = 500 } = {}) {
  const delay = () => new Promise((resolve) => setTimeout(resolve, latencyMs));

  const trendsClient = {
    async relatedQueries({ keyword }) {
      await delay();
      if (/trends-down/i.test(keyword)) return '<!DOCTYPE html><title>Error 429 (Too Many Requests)</title>';
      const rising = [`${keyword} for beginners`, `${keyword} mistakes`, `best ${keyword} 2026`, `is ${keyword} worth it`];
      return JSON.stringify({
        default: {
          rankedList: [
            { rankedKeyword: [{ query: `${keyword} tips`, value: 100 }] },
            { rankedKeyword: rising.map((query, index) => ({ query, value: 400 - index * 50 })) },
          ],
        },
      });
    },
  };

  async function fetchImpl(url, init = {}) {
    const href = String(url);
    await delay();

    if (href.startsWith(AUTOCOMPLETE_PREFIX)) {
      const query = new URL(href).searchParams.get('q') ?? '';
      return jsonResponse([query, [`${query} app`, `${query} near me`, `${query} at home`, `${query} explained`]]);
    }

    if (href === GROQ_URL) {
      const body = JSON.parse(init.body);
      const systemPrompt = body.messages[0].content;
      const data = JSON.parse(body.messages[1].content);
      if (/ratelimit/i.test(data.niche ?? '') || /ratelimit/i.test(data.topic ?? '')) {
        return jsonResponse({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }, 429, { 'retry-after': '7' });
      }
      const content = systemPrompt.includes('"topics"') ? mockTopics(data) : mockPackage(data);
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] });
    }

    return new Response('Not found', { status: 404 });
  }

  return { trendsClient, fetchImpl };
}
