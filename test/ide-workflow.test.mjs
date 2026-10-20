import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Workspace } from '../lib/workspace.mjs';
import { editorContextInput, splitEditorContext } from '../lib/editor-context.mjs';
import { editorContextSnapshot, commentTodos, createEditorContext } from '../public/editor-context.js';
import { JSDOM } from 'jsdom';

const snapshot = { cwd: '/private/tmp', path: 'example.py', label: 'example.py:1 · 未保存', text: 'unsaved draft' };
class Bridge extends EventEmitter {
  ready = true; calls = []; sequence = 0; turn = 0; interruptResult = 'completed';
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'configRequirements/read') return { requirements: null };
    if (method === 'skills/list') return { data: [] };
    if (method === 'plugin/installed') return { marketplaces: [] };
    if (method === 'collaborationMode/list') return { data: [{ mode: 'plan' }] };
    if (method === 'thread/start') return { thread: { id: `t${++this.sequence}`, cwd: params.cwd, turns: [] }, model: params.model || 'test-model' };
    if (method === 'thread/resume') return { thread: { id: params.threadId, cwd: '/private/tmp', turns: [] }, model: 'test-model' };
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: '/private/tmp', turns: [] } };
    if (method === 'thread/goal/set') return { goal: { status: params.status } };
    if (method === 'turn/interrupt') {
      if (this.interruptResult === 'error') throw new Error('stop failed');
      if (this.interruptResult === 'offline') { this.ready = false; this.emit('offline', 'offline'); }
      else if (this.interruptResult === 'completed') this.complete(params.threadId, params.turnId, 'interrupted');
      return {};
    }
    if (['turn/start', 'review/start'].includes(method)) {
      const turn = { id: `turn${++this.turn}`, status: 'inProgress' };
      this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn } });
      if (params.input) this.emit('notification', { method: 'item/started', params: { threadId: params.threadId, turnId: turn.id, item: { id: `user${this.turn}`, type: 'userMessage', content: params.input } } });
      return { turn, reviewThreadId: params.threadId };
    }
    if (method === 'turn/steer') return {};
    throw new Error(`Unexpected ${method}`);
  }
  complete(threadId, id, status = 'completed') { this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id, status } } }); }
}
function system(t) {
  const bridge = new Bridge(), workspace = new Workspace(bridge, '/private/tmp');
  t.after(() => { bridge.ready = false; for (const timer of workspace.timers.values()) clearTimeout(timer); });
  return { bridge, workspace, send: (extra = {}) => workspace.send({ cwd: '/private/tmp', text: 'first', mode: 'read-only', ...extra }) };
}

test('editor snapshots include current unsaved selection, bound large buffers and exclude other projects/previews', () => {
  const file = { cwd: '/project', path: '中文.py', id: 'f', content: 'before\nunsaved selection\nafter', start: 7, end: 24 };
  const editor = { current: file, visible: true, tabs: [{ ...file, dirty: true }, { cwd: '/other', path: 'private.txt' }] };
  let result = editorContextSnapshot(editor, '/project');
  assert.match(result.label, /未保存/); assert.match(result.text, /unsaved selection/); assert.doesNotMatch(result.text, /private.txt/);
  file.content = 'a'.repeat(20 * 1024 * 1024); file.start = 100000; file.end = 200000;
  result = editorContextSnapshot(editor, '/project'); assert.ok(result.text.length < 14000); assert.match(result.label, /节选/);
  assert.equal(editorContextSnapshot(editor, '/other'), null);
  file.preview = true; assert.equal(editorContextSnapshot(editor, '/project'), null);
  file.preview = false; editor.visible = false; assert.equal(editorContextSnapshot(editor, '/project'), null);
});

test('editor context toggles work without storage and Cosmos remains opt-in independently', t => {
  const dom = new JSDOM('<button id="editorContextToggle"></button><details id="editorContextPreview"><summary id="editorContextSummary"></summary><pre id="editorContextText"></pre></details>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = previous; dom.window.close(); });
  const context = { cwd: '/project', modelService: 'cosmos' }, editor = { current: { cwd: '/project', path: 'a.py', content: '<script>secret</script>', start: 0, end: 0 }, tabs: [], visible: true };
  const controller = createEditorContext({ editor, getContext: () => context, storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
  const toggle = document.getElementById('editorContextToggle'); assert.equal(controller.payload(), null);
  toggle.click(); assert.match(controller.payload().text, /secret/); assert.equal(document.querySelectorAll('script').length, 0);
  context.modelService = 'codex'; controller.sync(); assert.ok(controller.payload()); toggle.click(); assert.equal(controller.payload(), null);
  context.modelService = 'cosmos'; assert.ok(controller.payload());
});

test('TODO navigation finds comment entries, avoids ordinary text and bounds the list', () => {
  const found = commentTodos('TODO ordinary text\n-- TODO: add a check\n# todo handle empty input\nconst x = "TODO";\n// TODO next');
  assert.deepEqual(found.items.map(item => item.line), [2, 3, 5]);
  assert.equal(found.limited, false);
  const many = commentTodos('# TODO check\n'.repeat(60)); assert.equal(many.items.length, 50); assert.equal(many.limited, true);
});

test('context round trips through live and restored messages without altering typed marker examples', async t => {
  const { bridge, workspace, send } = system(t);
  const { threadId } = await send({ editorContext: snapshot });
  const input = bridge.calls.find(call => call.method === 'turn/start').params.input;
  const message = workspace.threads.get(threadId).items.find(item => item.id === 'user1');
  assert.equal(message.text, 'first'); assert.deepEqual(message.editorContext, snapshot);
  assert.deepEqual(splitEditorContext(input).editorContext, snapshot);
  const restored = workspace.importThread({ id: 'restored', cwd: '/private/tmp', turns: [{ id: 'old', items: [{ id: 'saved', type: 'userMessage', content: input }] }] });
  assert.deepEqual(restored.items[0].editorContext, snapshot); assert.equal(restored.items[0].text, 'first');
  assert.equal(splitEditorContext([input[1]]).editorContext, undefined, 'literal marker in the actual user prompt stays visible');
  assert.throws(() => editorContextInput({ ...snapshot, cwd: '/other' }, '/private/tmp'), /切换项目/);
  assert.throws(() => editorContextInput({ ...snapshot, text: 'x'.repeat(20001) }, '/private/tmp'), /过大/);
});

test('separate review creates a readonly thread using the original model and leaves source conversation untouched', async t => {
  const { bridge, workspace } = system(t);
  const source = workspace.importThread({ id: 'source', cwd: '/private/tmp', turns: [] }, { mode: 'workspace-write', model: 'original-model' });
  const result = await workspace.review({ threadId: source.id, delivery: 'detached', target: { type: 'uncommittedChanges' } });
  assert.notEqual(result.threadId, source.id); assert.equal(source.busy, false); assert.equal(source.mode, 'workspace-write');
  const start = bridge.calls.find(call => call.method === 'thread/start'); assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.model, 'original-model');
  const review = bridge.calls.find(call => call.method === 'review/start'); assert.equal(review.params.delivery, 'inline'); assert.equal(review.params.threadId, result.threadId);
  assert.equal(workspace.threads.get(result.threadId).parentThreadId, source.id); assert.equal(workspace.threads.get(result.threadId).busy, true);
  assert.equal(bridge.calls.some(call => call.method === 'thread/resume'), false);
});

test('interrupt then send pins the old turn, pauses goals/queue and preserves new context and permissions', async t => {
  const { bridge, workspace, send } = system(t), { threadId } = await send(), thread = workspace.threads.get(threadId);
  await workspace.followup({ threadId, text: 'keep queued', behavior: 'queue' }); thread.goal = { status: 'active' };
  const oldTurn = thread.turnId;
  await workspace.followup({ threadId, text: 'replacement', behavior: 'interrupt', editorContext: snapshot });
  assert.equal(bridge.calls.find(call => call.method === 'turn/interrupt').params.turnId, oldTurn);
  assert.equal(thread.goal.status, 'paused'); assert.equal(thread.queuePaused, true); assert.equal(thread.queue.length, 1);
  const turns = bridge.calls.filter(call => call.method === 'turn/start'); assert.equal(turns.length, 2);
  assert.equal(turns[1].params.input[0].text, 'replacement'); assert.deepEqual(splitEditorContext(turns[1].params.input).editorContext, snapshot);
  assert.equal(turns[1].params.sandboxPolicy.type, 'readOnly'); assert.equal(thread.turnId, 'turn2');
  bridge.complete(threadId, oldTurn, 'interrupted'); assert.equal(thread.busy, true); assert.equal(thread.turnId, 'turn2');
  assert.equal(bridge.listenerCount('notification'), 1); assert.equal(bridge.listenerCount('offline'), 1);
});

test('failed stop or disconnected runtime never starts the replacement and releases listeners', async t => {
  for (const outcome of ['error', 'offline']) {
    const { bridge, workspace, send } = system(t), { threadId } = await send(); bridge.interruptResult = outcome;
    await assert.rejects(workspace.followup({ threadId, text: 'replacement', behavior: 'interrupt' }), /stop failed|连接中断/);
    assert.equal(bridge.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(workspace.locks.size, 0); assert.equal(bridge.listenerCount('notification'), 1); assert.equal(bridge.listenerCount('offline'), 1);
  }
});

test('stop acknowledgement alone cannot authorize a new turn and concurrent followups are rejected', async t => {
  const { bridge, workspace, send } = system(t), { threadId } = await send(); bridge.interruptResult = 'wait';
  const replacement = workspace.followup({ threadId, text: 'replacement', behavior: 'interrupt' });
  while (!bridge.calls.some(call => call.method === 'turn/interrupt')) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(workspace.followup({ threadId, text: 'duplicate', behavior: 'interrupt' }), /正在提交/);
  assert.equal(bridge.calls.filter(call => call.method === 'turn/start').length, 1);
  bridge.complete(threadId, 'turn1', 'interrupted'); await replacement;
  assert.equal(bridge.calls.filter(call => call.method === 'turn/start').length, 2);
});
