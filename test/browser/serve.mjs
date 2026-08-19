import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml'
};

/** Sert la racine du dépôt, le temps des tests. */
export function serve(root, port = 0) {
  const server = createServer(async (req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    // Un service worker déclaré à la racine ne peut contrôler la page que
    // s'il est servi depuis la racine : pas de réécriture de chemin ici.
    const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    } catch (e) {
      res.writeHead(404).end('404');
    }
  });
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
