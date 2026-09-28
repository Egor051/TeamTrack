// Local production smoke server. Mirrors Vercel's existing rewrite to / for
// app routes while leaving static assets and service files untouched.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const root = resolve(process.cwd(), 'dist');
const port = Number(process.env.PORT || 4173);
const appRoute = /^\/(?:|projects(?:\/[^/.]+)*|login|register|forgot-password|reset-password|profile|templates|notifications)\/?$/;
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
};

createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400).end(); return; }
  const path = resolve(root, `.${pathname}`);
  if (path !== root && !path.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  let file = path === root ? resolve(root, 'index.html') : path;
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    const htmlFile = `${path}.html`;
    try {
      if (!(await stat(htmlFile)).isFile()) throw new Error('not a file');
      file = htmlFile;
    } catch {
      if (!appRoute.test(pathname)) { response.writeHead(404).end(); return; }
      file = resolve(root, 'index.html');
    }
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Cache-Control': file.endsWith('sw.js') || file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(500).end(); }
}).listen(port, '127.0.0.1', () => console.log(`Serving dist at http://127.0.0.1:${port}`));
