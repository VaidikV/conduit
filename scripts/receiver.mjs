// Tiny webhook receiver for local Conduit experiments.
//
// Run: node scripts/receiver.mjs [port]
// Then point a workflow's http_request step at http://localhost:<port>/hook
// and watch the request land here while the worker records the response.

import http from 'node:http';

const port = Number(process.argv[2] ?? 4567);

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    console.log(`[receiver] ${req.method} ${req.url} body=${body}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(port, () => {
  console.log(`[receiver] listening on :${port}`);
});
