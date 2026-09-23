import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqlCompletion, completionContext, completionText } from '../lib/sql-completion.mjs';
import { createApplication } from '../server.mjs';

const context = { before: 'SELECT id FROM orders WHERE ', after: '\nORDER BY id;', header: '', dialect: 'hive', model: 'chosen-model' };
class Bridge extends EventEmitter {
  calls = []; closed = 0; ready = false;
  async start() {}
  close() { this.closed++; this.emit('offline'); }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'config/read') return { config: { mcp_servers: { warehouse: {} }, plugins: { external: {} } } };
    if (method === 'thread/start') return { thread: { id: 'helper' } };
    if (method === 'turn/start') {
      this.emit('notification', { method: 'item/completed', params: { threadId: 'helper', item: { type: 'agentMessage', text: JSON.stringify({ completion: 'id IS NOT NULL' }) } } });
      this.emit('notification', { method: 'turn/completed', params: { threadId: 'helper', turn: { status: 'completed' } } });
      return { turn: { id: 'turn' } };
    }
    throw new Error('Unexpected RPC');
  }
}
async function setup(t, options = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lemon-completion-test-')), bridge = new Bridge();
  const service = new SqlCompletion({ stateDir, bridgeFactory: () => bridge, ...options });
  t.after(() => service.close()); return { bridge, service, stateDir };
}

test('AI completion uses a disposable restricted helper and supplies both sides without touching a conversation', async t => {
  const { bridge, service } = await setup(t);
  assert.equal(await service.complete(context), 'id IS NOT NULL');
  const thread = bridge.calls.find(call => call.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, 'read-only'); assert.equal(thread.approvalPolicy, 'never');
  assert.equal(thread.model, 'chosen-model'); assert.deepEqual(thread.environments, []);
  for (const key of ['features.shell_tool', 'features.unified_exec', 'features.apps', 'features.multi_agent', 'mcp_servers.warehouse.enabled', 'plugins.external.enabled']) assert.equal(thread.config[key], false, key);
  const turn = bridge.calls.find(call => call.method === 'turn/start').params;
  assert.deepEqual(JSON.parse(turn.input[0].text), { before: context.before, after: context.after, fileHeader: '', dialect: 'hive' });
  assert.equal(turn.outputSchema.properties.completion.type, 'string'); assert.ok(bridge.closed); assert.equal(service.active, null);
});

test('cancellation during startup closes a late starting helper and never starts a model turn', async t => {
  const { bridge, service } = await setup(t);
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  bridge.start = () => new Promise(resolve => { release = resolve; started(); });
  const abort = new AbortController(), pending = service.complete(context, { signal: abort.signal });
  await ready; abort.abort(); await assert.rejects(pending, { status: 499 }); release();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(bridge.closed >= 2); assert.equal(bridge.calls.length, 0);
});

test('timeout and concurrent requests are bounded and do not expose runtime errors', async t => {
  const { bridge, service } = await setup(t, { timeout: 30 });
  bridge.start = () => new Promise(() => {});
  const pending = service.complete(context);
  await assert.rejects(service.complete(context), { status: 429 });
  await assert.rejects(pending, { status: 504 }); assert.equal(service.active, null); assert.ok(bridge.closed);
  bridge.start = async () => { throw new Error('private provider credential'); };
  await assert.rejects(service.complete(context), error => !error.message.includes('private') && error.status === 503);
});

test('cancelling an in-flight model turn shuts down only its owned helper', async t => {
  const { bridge, service } = await setup(t);
  let started; const running = new Promise(resolve => { started = resolve; });
  const request = bridge.request.bind(bridge);
  bridge.request = (method, params) => { if (method === 'turn/start') { started(); return new Promise(() => {}); } return request(method, params); };
  const controller = new AbortController(), pending = service.complete(context, { signal: controller.signal });
  await running; controller.abort(); await assert.rejects(pending, { status: 499 });
  assert.ok(bridge.closed); assert.equal(service.active, null);
});

test('context and output limits preserve whitespace and reject invalid data', () => {
  assert.equal(completionText('\n  AND id > 0'), '\n  AND id > 0'); assert.equal(completionText(''), '');
  assert.throws(() => completionContext({ before: 'x'.repeat(12001) }), { status: 400 });
  assert.throws(() => completionContext({ before: '  ' }), { status: 400 });
  for (const value of [null, '```sql\nSELECT 1', '\n'.repeat(24), '\0', 'x'.repeat(2401)]) assert.throws(() => completionText(value));
});

test('HTTP completion enforces session/CSRF/file boundaries and propagates browser cancellation', async t => {
  const { stateDir } = await setup(t); await writeFile(path.join(stateDir, 'sample.sql'), 'SELECT 1;');
  let calls = 0, captured, cancelled = false, hold = false, received;
  const arrived = new Promise(resolve => { received = resolve; });
  const app = createApplication({ bridge: new Bridge(), cwd: stateDir, stateDir, sqlCompletion: {
    close() {}, complete(data, { signal }) {
      calls++; captured = data; if (!hold) return '1';
      received(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('aborted')); }, { once: true }));
    },
  } });
  await app.start(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`, cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const boot = await (await fetch(base + '/api/bootstrap', { headers: { cookie } })).json(); assert.equal(boot.aiCompletionAvailable, true);
  const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-codex-csrf': boot.csrf };
  const body = { cwd: stateDir, path: 'sample.sql', ...context };
  const post = (value, extra = {}) => fetch(base + '/api/project/complete', { method: 'POST', headers, body: JSON.stringify(value), ...extra });
  assert.equal((await post(body, { headers: { ...headers, cookie: '' } })).status, 401);
  assert.equal((await post(body, { headers: { ...headers, 'x-codex-csrf': '' } })).status, 403);
  assert.equal((await post({ ...body, path: '../outside.sql' })).status, 403);
  assert.equal((await post({ ...body, before: 'x'.repeat(12001) })).status, 400); assert.equal(calls, 0);
  assert.deepEqual(await (await post(body)).json(), { completion: '1' }); assert.deepEqual(captured, context);
  hold = true; const abort = new AbortController(), pending = post(body, { signal: abort.signal });
  await arrived; abort.abort(); await assert.rejects(pending);
  for (let i = 0; i < 30 && !cancelled; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, true);
});
