#!/usr/bin/env node
// Zero-dependency local server: serves the static frontend and routes
// /api/* to the same handlers Vercel runs. Usage:
//   npm run dev        real Google Trends + Groq (needs GROQ_API_KEY in .env)
//   npm run dev:mock   fully offline, canned responses, no API key needed

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createGenerateHandler } from '../api/generate.js';
import { createTrendsHandler } from '../api/trends.js';
import { sendJson } from '../lib/http.js';
import { createMockUpstreams } from './mock-upstreams.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_BODY_BYTES = 16 * 1024;

// An explicit allowlist: nothing else in the project (.env, api/, lib/,
// package.json, ...) can ever be served, whatever the request path.
const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/style.css', 'style.css'],
  ['/favicon.svg', 'favicon.svg'],
  ['/404.html', '404.html'],
]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Reuse the production security headers from vercel.json so local dev matches. */
function loadSecurityHeaders() {
  try {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    return (config.headers ?? [])
      .filter((rule) => rule.source === '/(.*)')
      .flatMap((rule) => rule.headers.map(({ key, value }) => [key, value]));
  } catch {
    return [];
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge: size > MAX_BODY_BYTES }));
    req.on('error', reject);
  });
}

async function serveFile(req, res, file, status) {
  const content = await readFile(path.join(ROOT, file));
  res.statusCode = status;
  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(req.method === 'HEAD' ? undefined : content);
}

export function createDevServer({ env = process.env, mock = false, mockLatencyMs, logger = console } = {}) {
  const upstreams = mock ? createMockUpstreams({ latencyMs: mockLatencyMs }) : {};
  const handlerEnv = mock ? { ...env, GROQ_API_KEY: env.GROQ_API_KEY || 'mock-key' } : env;
  const api = new Map([
    ['/api/trends', createTrendsHandler({ env: handlerEnv, logger, ...upstreams })],
    ['/api/generate', createGenerateHandler({ env: handlerEnv, logger, ...upstreams })],
  ]);
  const securityHeaders = loadSecurityHeaders();

  return http.createServer(async (req, res) => {
    for (const [name, value] of securityHeaders) res.setHeader(name, value);

    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const handler = api.get(pathname);
      if (handler) {
        const { text, tooLarge } = await readBody(req);
        if (tooLarge) return sendJson(res, 413, { error: 'Request body is too large.', code: 'payload_too_large' });
        req.body = text;
        return await handler(req, res);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return sendJson(res, 405, { error: 'Method not allowed.', code: 'method_not_allowed' });
      }

      const file = PUBLIC_FILES.get(pathname);
      return await serveFile(req, res, file ?? '404.html', file ? 200 : 404);
    } catch (error) {
      logger.error('[dev-server]', error);
      if (!res.headersSent) sendJson(res, 500, { error: 'Dev server error.', code: 'internal_error' });
      else res.end();
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const mock = process.argv.includes('--mock');
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
    else console.warn('Warning: .env loading needs Node 20.12+. Export GROQ_API_KEY in your shell instead.');
  }

  const port = Number(process.env.PORT) || 3000;
  const server = createDevServer({ mock });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Try: PORT=3001 npm run dev`);
    else console.error(error);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`TrendScript running at http://localhost:${port}`);
    if (mock) console.log('Mock mode: Google and Groq are simulated, no network or API key needed.');
    else if (!process.env.GROQ_API_KEY) console.warn('Warning: GROQ_API_KEY is not set. Add it to .env or run `npm run dev:mock`.');
  });
}
