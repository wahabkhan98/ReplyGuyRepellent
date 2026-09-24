// Dev server for the fixture. Any /user/status/ID path serves fixture.html, so content.js sees a post detail URL.
//   node test/serve.js  ->  http://localhost:8123/demo/status/1837000000000000000
//   add ?standalone to run the extension scripts in-page with a fake chrome.* (no extension install needed)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 8123;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  let file = path.join(ROOT, 'test', 'fixture.html');
  if (/^\/(extension|test)\//.test(pathname)) {
    file = path.normalize(path.join(ROOT, pathname));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  } else if (pathname === '/') {
    res.writeHead(302, { Location: '/demo/status/1837000000000000000' });
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Fixture: http://localhost:${PORT}/demo/status/1837000000000000000`));
