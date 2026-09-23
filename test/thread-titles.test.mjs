import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Workspace } from '../lib/workspace.mjs';
import { COSMOS_MODEL } from '../lib/model-connections.mjs';

function fixture(t) {
  const bridge = new EventEmitter();
  bridge.ready = true;
  const calls = [];
  bridge.request = async (method, params) => { calls.push({ method, params }); return {}; };
  const workspace = new Workspace(bridge, '/private/tmp');
  const thread = workspace.importThread({ id: 'thread-1', cwd: '/private/tmp', name: null, preview: '首条消息预览', turns: [] });
  t.after(() => { for (const timer of workspace.timers.values()) clearTimeout(timer); });
  return { workspace, bridge, thread, calls };
}

test('native title notifications replace provisional previews without changing running state', async t => {
  const { workspace, bridge, thread } = fixture(t);
  Object.assign(thread, { busy: true, mode: 'read-only', queue: [{ text: 'keep' }], requests: [{ key: 'approval' }] });
  const items = thread.items, queue = thread.queue, requests = thread.requests;
  const event = new Promise(resolve => workspace.once('thread', resolve));
  bridge.emit('notification', { method: 'thread/name/updated', params: { threadId: thread.id, threadName: '原生自动生成的名称' } });
  assert.equal((await event).title, '原生自动生成的名称');
  assert.equal(thread.name, thread.title);
  assert.equal(thread.items, items); assert.equal(thread.queue, queue); assert.equal(thread.requests, requests);
  assert.equal(thread.busy, true); assert.equal(thread.mode, 'read-only');
  bridge.emit('notification', { method: 'thread/name/updated', params: { threadId: thread.id, threadName: null } });
  assert.equal(thread.title, '首条消息预览');
});

test('provisional previews stay compact while explicit names are preserved', t => {
  const { workspace } = fixture(t);
  const preview = '原生预览'.repeat(60);
  const thread = workspace.importThread({ id: 'long', preview, name: null });
  assert.equal([...thread.title].length, 28); assert.ok(thread.title.endsWith('…')); assert.equal(thread.preview, preview);
  workspace.updateTitle(thread, { name: '新对话', preview: 'another preview' });
  assert.equal(thread.name, '新对话'); assert.equal(thread.title, '新对话');
});

test('list reconciliation refreshes the loaded title cache while preserving live work', async t => {
  const { workspace, bridge, thread } = fixture(t);
  thread.busy = true; thread.items.push({ id: 'live', text: 'partial reply' });
  bridge.request = async () => ({ data: [{ id: thread.id, name: '原生新名称', preview: 'native preview', cwd: thread.cwd }], nextCursor: null });
  const list = await workspace.list('/private/tmp');
  assert.equal(list.threads[0].title, '原生新名称'); assert.equal(thread.title, '原生新名称');
  assert.equal(thread.busy, true); assert.equal(thread.items[0].text, 'partial reply');
});

test('a delayed list cannot undo a newer rename notification', async t => {
  const { workspace, bridge, thread } = fixture(t);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  bridge.request = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const loading = workspace.list('/private/tmp'); await entered;
  bridge.emit('notification', { method: 'thread/name/updated', params: { threadId: thread.id, threadName: '最新名称' } });
  release({ data: [{ id: thread.id, name: '过时名称', cwd: thread.cwd }], nextCursor: null });
  assert.equal((await loading).threads[0].title, '最新名称'); assert.equal(thread.title, '最新名称');
});

test('opening a cached thread reads only metadata and deduplicates in-flight title refreshes', async t => {
  const { workspace, bridge, thread, calls } = fixture(t);
  let release;
  bridge.request = (method, params) => { calls.push({ method, params }); return new Promise(resolve => { release = resolve; }); };
  const items = thread.items;
  const first = workspace.get(thread.id, { refreshTitle: true });
  const second = workspace.get(thread.id, { refreshTitle: true });
  assert.deepEqual(calls, [{ method: 'thread/read', params: { threadId: thread.id, includeTurns: false } }]);
  release({ thread: { id: thread.id, name: '从原生读取的名称', turns: [{ items: ['must not import'] }] } });
  assert.equal(await first, thread); assert.equal(await second, thread);
  assert.equal(thread.title, '从原生读取的名称'); assert.equal(thread.items, items);
});

test('a delayed metadata read cannot overwrite a rename and read failures do not fail the task', async t => {
  const { workspace, bridge, thread } = fixture(t);
  let release;
  bridge.request = () => new Promise(resolve => { release = resolve; });
  const pending = workspace.refreshTitle(thread);
  bridge.emit('notification', { method: 'thread/name/updated', params: { threadId: thread.id, threadName: '刚改的名称' } });
  release({ thread: { id: thread.id, name: '旧名称' } }); await pending;
  assert.equal(thread.title, '刚改的名称');
  bridge.request = async () => { throw new Error('offline'); };
  await workspace.get(thread.id, { refreshTitle: true });
  assert.equal(thread.title, '刚改的名称'); assert.equal(thread.error, null);
});

test('turn completion reconciles native titles without writing a locally generated name', async t => {
  const { workspace, bridge, thread, calls } = fixture(t);
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: thread.id, name: '原生完成后的标题' } };
  };
  workspace.on('thread', value => { if (value.title === '原生完成后的标题') finish(); });
  bridge.emit('notification', { method: 'turn/completed', params: { threadId: thread.id, turn: { id: 'turn-1', status: 'completed' } } });
  await finished;
  assert.equal(thread.title, '原生完成后的标题'); assert.equal(thread.busy, false);
  assert.equal(calls.some(call => call.method === 'thread/name/set'), false);
});

test('generated summaries strip attachment paths, persist native names once and preserve live work', async t => {
  const { workspace, bridge, thread, calls } = fixture(t);
  let release, source;
  workspace.titleGenerator = { generate: text => { source = text; return new Promise(resolve => { release = resolve; }); } };
  thread.items = [{ type: 'userMessage', text: '查保险字段对应ADS表\n用户附加的文件："image.png"\n本机路径："/private/tmp/image.png"' }];
  thread.busy = true; thread.queue = [{ text: 'queued' }]; thread.requests = [{ key: 'approval' }];
  bridge.request = async (method, params) => { calls.push({ method, params }); return method === 'thread/read' ? { thread: { name: null, preview: 'native preview changed' } } : {}; };
  const first = workspace.ensureTitle(thread), duplicate = workspace.ensureTitle(thread);
  assert.equal(first, duplicate); assert.equal(source, '查保险字段对应ADS表');
  release('查询保险ADS字段'); await first;
  assert.equal(thread.title, '查询保险ADS字段'); assert.equal(thread.name, thread.title);
  assert.equal(calls.filter(call => call.method === 'thread/name/set').length, 1);
  assert.equal(thread.busy, true); assert.equal(thread.queue.length, 1); assert.equal(thread.requests.length, 1);
  await workspace.ensureTitle(thread); assert.equal(calls.filter(call => call.method === 'thread/name/set').length, 1);
});

test('manual or native renames arriving during generation win and transient failure leaves tasks alone', async t => {
  const { workspace, bridge, thread, calls } = fixture(t);
  let release;
  workspace.titleGenerator = { generate: () => new Promise(resolve => { release = resolve; }) };
  const generating = workspace.ensureTitle(thread);
  bridge.emit('notification', { method: 'thread/name/updated', params: { threadId: thread.id, threadName: '我的名称' } });
  release('自动名称'); await generating;
  assert.equal(thread.title, '我的名称'); assert.equal(calls.some(call => call.method === 'thread/name/set'), false);
  const another = workspace.importThread({ id: 'another', preview: '首条问题', cwd: thread.cwd });
  bridge.request = async (method, params) => { calls.push({ method, params }); return { thread: { name: '其他客户端的名称' } }; };
  workspace.titleGenerator = { generate: async () => '模型标题' };
  await workspace.ensureTitle(another); assert.equal(another.title, '其他客户端的名称');
  assert.equal(calls.some(call => call.method === 'thread/name/set'), false);
  const failed = workspace.importThread({ id: 'failed', preview: '需要查询保险信息'.repeat(10), cwd: thread.cwd });
  workspace.titleGenerator = { generate: async () => { throw Error('offline'); } };
  await workspace.ensureTitle(failed); assert.equal(failed.error, null); assert.equal([...failed.title].length, 28);
});

test('compact title previews never include generated attachment metadata', async () => {
  const { titleSource, previewTitle, validTitle } = await import('../lib/thread-titles.mjs');
  const text = '这个在哪个ads可以查到用户附加的文件："image.png" 本机路径："/var/folders/private-file.png"';
  assert.equal(titleSource(text), '这个在哪个ads可以查到'); assert.equal(previewTitle(text), '这个在哪个ads可以查到');
  assert.equal(validTitle('多行\n标题'), null); assert.equal(validTitle('/private/tmp/file'), null); assert.equal(validTitle('字'.repeat(33)), null);
});

test('Cosmos titles are generated locally without model calls, and preserve approvals and manual names', async t => {
  const { workspace, bridge, thread, calls } = fixture(t);
  thread.model = COSMOS_MODEL; thread.busy = true; thread.requests = [{ key: 'pending' }];
  thread.items = [{ type: 'userMessage', text: '查询保险的用户分布\n用户附加的文件："demo.txt"\n本机路径："/private/tmp/demo.txt"' }];
  workspace.titleGenerator = { generate() { assert.fail('Cosmos must not call a model for a title'); } };
  workspace.modelConnections = { value: { active: 'cosmos' }, forThread() { assert.fail('Local title must not open a model connection'); } };
  bridge.request = async (method, params) => { calls.push({ method, params }); return method === 'thread/read' ? { thread: { name: null } } : {}; };
  await workspace.ensureTitle(thread);
  assert.equal(thread.name, '查询保险的用户分布'); assert.equal(thread.busy, true); assert.equal(thread.requests.length, 1);
  assert.deepEqual(calls.map(c => c.method), ['thread/read', 'thread/name/set']);
  workspace.updateTitle(thread, { name: '用户手动名称' }); await workspace.ensureTitle(thread);
  assert.equal(thread.name, '用户手动名称'); assert.equal(calls.length, 2);
});

test('title generation uses an ephemeral restricted task and always closes its bridge', async () => {
  const { TitleGenerator } = await import('../lib/thread-titles.mjs');
  class Mock extends EventEmitter {
    calls = []; closed = false;
    async start() {} close() { this.closed = true; }
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'config/read') return { config: { mcp_servers: { warehouse: {} }, plugins: { 'mail@market': {} } } };
      if (method === 'thread/start') return { thread: { id: 'helper' } };
      if (method === 'turn/start') {
        this.emit('notification', { method: 'item/completed', params: { threadId: 'helper', item: { type: 'agentMessage', text: '{"title":"查询保险字段"}' } } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: 'helper', turn: { status: 'completed' } } });
        return { turn: { id: 'summary' } };
      }
    }
  }
  const bridge = new Mock(), generator = new TitleGenerator({ stateDir: '/private/tmp/ningmeng-title-test', bridgeFactory: () => bridge });
  try {
    assert.equal(await generator.generate('查询对应的保险字段', 'selected-model'), '查询保险字段');
    const start = bridge.calls.find(call => call.method === 'thread/start').params;
    assert.equal(start.ephemeral, true); assert.equal(start.sandbox, 'read-only'); assert.equal(start.model, 'selected-model');
    assert.equal(start.config['features.shell_tool'], false); assert.equal(start.config['mcp_servers.warehouse.enabled'], false); assert.equal(start.config['plugins.mail@market.enabled'], false);
    assert.deepEqual(start.environments, []); assert.equal(bridge.closed, true);
  } finally { generator.close(); }
});

test('a failed final native-name read never risks overwriting another client title', async t => {
  const { workspace, bridge, thread, calls } = fixture(t);
  workspace.titleGenerator = { generate: async () => '自动标题' };
  bridge.request = async (method, params) => { calls.push({ method, params }); throw Error('metadata unavailable'); };
  await workspace.ensureTitle(thread);
  assert.equal(calls.some(call => call.method === 'thread/name/set'), false);
  assert.equal(thread.name, null); assert.equal(thread.error, null);
});
