import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { waitForHttp } from '../src/health.mjs';

test('does not accept HTTP errors or unhealthy services', async () => {
  let mode = 'error';
  const server = http.createServer((req, res) => {
    res.writeHead(mode === 'error' ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: mode }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/health`;
  const healthy = body => body.status === 'ok';
  try {
    await assert.rejects(waitForHttp(url, 200, { healthy }), /Timed out/);
    mode = 'starting';
    await assert.rejects(waitForHttp(url, 200, { healthy }), /Timed out/);
    mode = 'ok';
    await waitForHttp(url, 1000, { healthy });
    await assert.rejects(waitForHttp(url, 1000, { healthy, failure: () => new Error('engine exited') }), /engine exited/);
  } finally { await new Promise(r => server.close(r)); }
});
