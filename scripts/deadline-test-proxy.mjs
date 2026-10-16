// Test-only static host + isolated PostgREST proxy. Auth responses use synthetic
// fixture sessions; this harness does not claim to validate Supabase Auth.
import { createServer, request as proxyRequest } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const root = resolve('dist');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
let blockBootstrapPages = false;
createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__test/bootstrap-pages') {
    blockBootstrapPages = url.searchParams.get('blocked') === '1'; res.writeHead(200).end('ok'); return;
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    const forward = (body) => {
      const forwarded = proxyRequest(config.api + req.url.slice('/rest/v1'.length), { method: req.method, headers: { ...req.headers, host: new URL(config.api).host } }, (upstream) => {
        res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res);
      });
      forwarded.on('error', () => res.writeHead(502).end());
      if (body) forwarded.end(body); else req.pipe(forwarded);
    };
    if (blockBootstrapPages && url.pathname === '/rest/v1/rpc/get_offline_account_page') {
      const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => {
        const body = Buffer.concat(chunks);
        let dataset;
        try { dataset = JSON.parse(body).p_dataset; }
        catch { res.writeHead(400).end('Invalid fixture request'); return; }
        // Interrupt Extended resources while allowing changed mandatory pages
        // to finish after earlier role, assignment and deadline mutations.
        if (['history', 'notifications', 'last_editors'].includes(dataset)) req.socket.destroy();
        else forward(body);
      });
    } else forward();
    return;
  }
  if (url.pathname.startsWith('/auth/v1/')) {
    let body = {};
    if (url.pathname.endsWith('/user')) {
      try { const token = req.headers.authorization.split(' ')[1]; const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub; body = config.users.find((user) => user.id === id) ?? {}; }
      catch { res.writeHead(401).end(); return; }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)); return;
  }
  if (url.pathname.startsWith('/realtime/')) { res.writeHead(503).end(); return; }
  let file = resolve(root, '.' + url.pathname);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (!existsSync(file) || !statSync(file).isFile()) file = resolve(root, 'index.html');
  res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': extname(file) === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600' });
  res.end(readFileSync(file));
}).listen(55539, '127.0.0.1', () => console.log('Deadline fixture proxy ready'));
