import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { sendSqlResponse } from '../lib/sql-response.mjs';
import { SqlRunner } from '../lib/sql-runner.mjs';

test('pending SQL keeps the proxy active through heartbeats and returns one result or a late error', async t => {
  const waiting = [];
  const server = http.createServer((req, res) => {
    void sendSqlResponse(res, () => new Promise((resolve, reject) => waiting.push({ resolve, reject })), { heartbeatMs: 10 });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const fail of [false, true]) {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '';
    // There is still no result after several successive keep-alive chunks.
    for (let i = 0; i < 3; i++) {
      const chunk = await reader.read(); assert.equal(chunk.done, false);
      text += decoder.decode(chunk.value); assert.match(text, /^\s+$/);
    }
    const job = waiting.shift();
    if (fail) job.reject(Object.assign(new Error('mock upstream rejected the SQL'), { status: 502 }));
    else job.resolve({ ok: true, rows: [{ value: 1 }] });
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    assert.deepEqual(JSON.parse(text), fail
      ? { ok: false, error: 'mock upstream rejected the SQL', status: 502 }
      : { ok: true, rows: [{ value: 1 }] });
  }
  assert.equal(waiting.length, 0);
});

test('SQL transport has no response deadline while both engines retain their active-query lock', async t => {
  let release, received;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    received = JSON.parse(text);
    release = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rows: [], columns: [] }));
    };
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const optionsSeen = [];
  const runner = new SqlRunner({ base: `http://127.0.0.1:${server.address().port}`, fetchImpl: (url, options) => {
    optionsSeen.push(options);
    return fetch(url, options);
  } });
  for (const engine of ['huawei', 'aliyun']) {
    release = null;
    const query = runner.execute({ sql: '--lzy\nSELECT 1', engine });
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(received.timeoutSeconds, 0);
    assert.equal(optionsSeen.at(-1).signal, undefined);
    assert.equal(runner.active, true);
    await assert.rejects(runner.execute({ sql: '--lzy\nSELECT 2', engine }), /已有查询/);
    release(); assert.equal((await query).ok, true);
    assert.equal(runner.active, false);
  }
});
