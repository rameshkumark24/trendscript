// Shared test utilities (no test cases here).

export const silentLogger = { warn() {}, error() {}, log() {} };

export function mockRequest({ method = 'POST', body, headers = { 'content-type': 'application/json' }, ip = '203.0.113.1' } = {}) {
  return { method, body, headers: { 'x-forwarded-for': ip, ...headers }, socket: { remoteAddress: ip } };
}

export function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

export function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function groqReply(content) {
  return jsonResponse({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
}

/** A fetch stub that records calls and answers from a queue or a function. */
export function fakeFetch(responder) {
  const calls = [];
  const queue = Array.isArray(responder) ? [...responder] : null;
  async function fetchImpl(url, init = {}) {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    const next = queue ? queue.shift() : responder(String(url), init);
    const value = typeof next === 'function' ? await next(String(url), init) : await next;
    if (value instanceof Error) throw value;
    return value;
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

export const VALID_PACKAGE = {
  title: 'The 30-second fix for lower back pain',
  thumbnail_idea: 'Close-up of someone wincing at a desk.',
  caption: 'Your chair is not the problem. Try this instead.',
  hashtags: ['#backpain', '#fitness', '#shorts'],
  chapters: [
    { time: '0:00', label: 'The Hook' },
    { time: '0:03', label: 'Why it hurts' },
    { time: '0:15', label: 'The fix' },
    { time: '0:25', label: 'Follow' },
  ],
  script: {
    hook: 'Your back pain is not from sitting.',
    buildup: 'It comes from one muscle that switches off when you sit for hours.',
    climax: 'Squeeze your glutes for five seconds, ten times, every hour.',
    cta: 'Follow for the full routine.',
  },
};
