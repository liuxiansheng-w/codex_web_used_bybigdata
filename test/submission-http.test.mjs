import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server.mjs';

class Bridge extends EventEmitter {
  ready = true; starts = 0;
  async start() {} close() {}
  async request(method, params) {
    if (method === 'configRequirements/read') return { requirements: null };
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [] };
    if (method === 'thread/start') return { thread: { id: 'fictional', cwd: this.cwd, turns: [] } };
    if (method === 'turn/start') { this.starts++; const turn = { id: 'fictional-turn', status: 'inProgress' }; this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn } }); return { turn }; }
    throw new Error('Unexpected mock method ' + method);
  }
}

test('receipt HTTP recovery is authenticated, same-origin, restart-bound and does not repeat a native task', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'lemon-receipt-')), bridge = new Bridge(); bridge.cwd = cwd;
  const app = createApplication({ cwd, bridge, stateDir: path.join(cwd, 'state') }); await app.start(0); t.after(() => app.close());
  app.workspace.catalog.input = async () => []; app.workspace.ensureTitle = async () => {};
  const base = 'http://127.0.0.1:' + app.server.address().port, page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const bootstrap = await (await fetch(base + '/api/bootstrap', { headers: { cookie } })).json();
  assert.equal(bootstrap.submissionRecovery, true); assert.ok(bootstrap.submissionEpoch);
  const body = { cwd, mode: 'read-only', text: 'fictional only', submissionId: randomUUID(), submissionEpoch: bootstrap.submissionEpoch };
  const route = '/api/submissions/' + body.submissionId + '?epoch=' + encodeURIComponent(body.submissionEpoch);
  assert.equal((await fetch(base + route)).status, 401);
  assert.equal((await fetch(base + route, { headers: { cookie, origin: 'https://outside.example' } })).status, 403);
  const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-codex-csrf': bootstrap.csrf };
  assert.equal((await fetch(base + '/api/send', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  const a = await fetch(base + '/api/send', { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(a.status, 200); const first = await a.json();
  const receipt = await (await fetch(base + route, { headers: { cookie } })).json(); assert.deepEqual(receipt, { state: 'accepted', threadId: 'fictional' }); assert.equal(bridge.starts, 1);
  const repeated = await fetch(base + '/api/send', { method: 'POST', headers, body: JSON.stringify(body) }); assert.deepEqual(await repeated.json(), first); assert.equal(bridge.starts, 1);
  assert.equal((await fetch(base + '/api/send', { method: 'POST', headers, body: JSON.stringify({ ...body, text: 'changed' }) })).status, 409);
  assert.equal((await fetch(base + route.replace(body.submissionEpoch, 'old-epoch'), { headers: { cookie } })).status, 409);
  for (const asset of ['draft-journal', 'project-paths', 'message-renderer', 'submission-state']) assert.equal((await fetch(base + '/' + asset + '.js')).status, 200);
  assert.equal(bridge.starts, 1, 'lookup and static assets cannot execute another task');
});
