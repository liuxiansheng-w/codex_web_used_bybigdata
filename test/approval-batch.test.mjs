import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalBatch } from '../public/permissions.js';

const request = (key, method = 'item/commandExecution/requestApproval', threadId = 'a') => ({ key, method, params: { threadId, command: `mock ${key}` } });
function fixture(requests) {
  let thread = { id: 'a', requests }, connected = true;
  const calls = [], notices = [], pending = [];
  const controller = createApprovalBatch({ getThread: () => thread, isConnected: () => connected,
    api: (route, body) => { calls.push({ route, body }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
    onComplete: text => notices.push(text) });
  return { controller, calls, notices, pending, get thread() { return thread; },
    select(value) { thread = value; controller.view(); }, disconnect() { connected = false; controller.view(); } };
}
const tick = () => new Promise(setImmediate);

test('bulk approval snapshots only visible commands/file changes, excluding future requests and other interaction types', async () => {
  const a = request('one'), b = request('two', 'item/fileChange/requestApproval');
  const f = fixture([a, b, request('permission', 'item/permissions/requestApproval'), request('question', 'item/tool/requestUserInput'), request('plugin', 'mcpServer/elicitation/request')]);
  assert.equal(f.controller.view().candidates.length, 2); assert.equal(f.calls.length, 0);
  const work = f.controller.approveAll();
  await f.controller.approveAll(); await f.controller.respond(a, { decision: 'decline' });
  assert.equal(f.calls.length, 1, 'double-clicking or individual actions cannot replay an in-flight batch');
  f.thread.requests.push(request('arrived-later'));
  f.pending.shift().resolve({ ok: true }); await tick();
  assert.equal(f.calls.length, 2); f.pending.shift().resolve({ ok: true }); await work;
  assert.deepEqual(f.calls.map(call => call.body), [{ key: 'one', decision: 'accept' }, { key: 'two', decision: 'accept' }]);
  assert.deepEqual(f.controller.view().candidates.map(r => r.key), ['arrived-later']);
  assert.match(f.notices[0], /已允许 2 项/);
});

test('switching away and back or disconnecting cancels the remaining batch without approving another thread', async () => {
  for (const action of ['switch', 'disconnect']) {
    const f = fixture([request('one'), request('two')]), original = f.thread;
    const work = f.controller.approveAll();
    if (action === 'switch') { f.select({ id: 'b', requests: [request('other', undefined, 'b')] }); f.select(original); }
    else f.disconnect();
    f.pending.shift().resolve({ ok: true }); await work;
    assert.equal(f.calls.length, 1); assert.match(f.notices[0], /剩余 1 项未提交/);
    assert.equal(f.controller.status('two').done, undefined);
  }
});

test('resolved requests are skipped, failures remain retryable, and only explicit clicks resubmit', async () => {
  const f = fixture([request('one'), request('two'), request('three'), request('four')]);
  const work = f.controller.approveAll();
  f.thread.requests = f.thread.requests.filter(r => r.key !== 'two');
  f.pending.shift().reject(Object.assign(new Error('already handled'), { status: 409 })); await tick();
  assert.equal(f.calls[1].body.key, 'three');
  f.pending.shift().reject(Object.assign(new Error('mock validation failed'), { status: 400 })); await tick();
  assert.equal(f.calls[2].body.key, 'four'); f.pending.shift().resolve({ ok: true }); await work;
  assert.match(f.notices[0], /已允许 1 项，1 项提交失败，2 项已结束或变化/);
  assert.match(f.controller.status('three').error, /validation failed/);
  await tick(); assert.equal(f.calls.length, 3, 'errors never cause automatic retries');
  const retry = f.controller.respond(f.thread.requests.find(r => r.key === 'three'), { decision: 'decline' });
  assert.deepEqual(f.calls.at(-1).body, { key: 'three', decision: 'decline' });
  f.pending.shift().resolve({ ok: true }); await retry;
  assert.equal(f.controller.status('three').done, true);
});

test('network errors stop the batch and changed request content is not covered by an earlier approval click', async () => {
  const f = fixture([request('one'), request('two')]);
  const work = f.controller.approveAll();
  f.pending.shift().reject(new Error('offline')); await work;
  assert.equal(f.calls.length, 1); assert.match(f.notices[0], /1 项提交失败，剩余 1 项未提交/);
  const changed = fixture([request('one'), request('two')]), work2 = changed.controller.approveAll();
  changed.thread.requests[1] = { ...changed.thread.requests[1], params: { threadId: 'a', command: 'different mock command' } };
  changed.pending.shift().resolve({ ok: true }); await work2;
  assert.equal(changed.calls.length, 1); assert.match(changed.notices[0], /1 项已结束或变化/);
});

test('single approvals and rejections keep their original response and deduplicate rapid clicks', async () => {
  const a = request('one'), f = fixture([a]);
  const work = f.controller.respond(a, { decision: 'accept' });
  assert.equal(f.controller.view().disabled, true);
  await f.controller.respond(a, { decision: 'accept' }); await f.controller.approveAll();
  assert.equal(f.calls.length, 1); f.pending.shift().resolve({ ok: true }); await work;
  await f.controller.respond(a, { decision: 'decline' }); assert.equal(f.calls.length, 1);
});
