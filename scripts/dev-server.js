// Zero-dependency local server: serves the static frontend and the /api routes
// with a minimal Vercel-compatible request/response shim.
// Usage: npm start   (reads GROQ_API_KEY from .env or the environment)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT) || 3000;
const STATIC_FILES = new Set(['index.html', 'app.js', 'style.css', '404.html', 'favicon.svg']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const API_ROUTES = { '/api/trends': 'api/trends.js', '/api/generate': 'api/generate.js' };

loadEnvFile(join(ROOT, '.env'));

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function withVercelHelpers(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return res;
  };
  res.send = payload => { res.end(String(payload)); return res; };
  return res;
}

async function serveStatic(pathname, res) {
  const name = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^[/\\]+/, '');
  const filePath = join(ROOT, name);
  if (STATIC_FILES.has(name) && filePath.startsWith(ROOT + sep)) {
    res.writeHead(200, { 'Content-Type': MIME[extname(name)] || 'application/octet-stream' });
    return res.end(await readFile(filePath));
  }
  res.writeHead(404, { 'Content-Type': MIME['.html'] });
  res.end(await readFile(join(ROOT, '404.html')));
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    const route = API_ROUTES[pathname.replace(/\/$/, '')];
    if (route) {
      const { default: handler } = await import(pathToFileURL(join(ROOT, route)).href);
      return await handler(req, withVercelHelpers(res));
    }
    await serveStatic(pathname, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
});

server.listen(PORT, () => {
  console.log(`TrendScript running at http://localhost:${PORT}`);
  if (!process.env.GROQ_API_KEY) console.warn('Warning: GROQ_API_KEY is not set; API calls will fail.');
});
