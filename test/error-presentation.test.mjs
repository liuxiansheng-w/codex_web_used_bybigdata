import test from 'node:test';
import assert from 'node:assert/strict';
import { readableNotice, modelRetryLabel } from '../public/interactions.js';
import { EventEmitter } from 'node:events';
import { Workspace } from '../lib/workspace.mjs';

test('model retry state uses willRetry, clears on same-turn model progress, and retains terminal errors', t => {
  const bridge = new EventEmitter(), workspace = new Workspace(bridge, '/project');
  workspace.refreshTitle = async () => {}; workspace.ensureTitle = () => {};
  t.after(() => { for (const timer of workspace.timers.values()) clearTimeout(timer); });
  const raw = { id: 'retry-thread', turns: [{ id: 'turn1', status: 'inProgress', items: [] }] };
  const thread = workspace.importThread(raw);
  const emit = (method, params = {}) => bridge.emit('notification', { method, params: { threadId: thread.id, turnId: 'turn1', ...params } });
  const retry = () => emit('error', { error: { message: 'Reconnecting... 5/5' }, willRetry: true });
  retry(); assert.equal(thread.error, null); assert.match(modelRetryLabel(thread), /模型连接正在重试（5\/5）/);
  emit('item/commandExecution/outputDelta', { itemId: 'other-tool', delta: 'local output' });
  emit('thread/tokenUsage/updated', { tokenUsage: {} }); assert.ok(thread.modelRetry);
  emit('item/agentMessage/delta', { turnId: 'older-turn', itemId: 'older', delta: 'old progress' }); assert.ok(thread.modelRetry);
  emit('item/agentMessage/delta', { itemId: 'reply', delta: '继续生成' }); assert.equal(thread.modelRetry, null);
  retry();
  const reread = workspace.importThread(raw); assert.deepEqual(reread.modelRetry, thread.modelRetry);
  emit('error', { turnId: 'older-turn', willRetry: false, error: { message: 'stale failure' } }); assert.equal(reread.error, null);
  emit('error', { willRetry: false, error: { message: 'upstream final failure' } });
  assert.equal(reread.modelRetry, null); assert.equal(reread.error, 'upstream final failure');
  emit('turn/completed', { turn: { id: 'turn1', status: 'failed', error: { message: 'upstream final failure' } } });
  assert.equal(reread.busy, false); assert.equal(modelRetryLabel(reread), '');
  retry(); assert.equal(reread.modelRetry, null); assert.equal(reread.error, 'upstream final failure');
  emit('turn/started', { turn: { id: 'turn2', status: 'inProgress' } });
  assert.equal(reread.error, null); assert.equal(reread.modelRetry, null);
  emit('error', { turnId: 'turn2', willRetry: true, error: { message: 'Retrying request' } });
  assert.equal(modelRetryLabel(reread), '模型请求正在重试…');
  emit('turn/completed', { turnId: 'turn2', turn: { id: 'turn2', status: 'completed' } });
  assert.equal(reread.modelRetry, null); assert.equal(reread.error, null);
});

test('retry presentation supports only exact legacy progress and does not hide explicit final errors', () => {
  const thread = { busy: true, turnId: 'turn', error: 'Reconnecting... 5/5' };
  assert.equal(modelRetryLabel(thread), '模型连接正在重试（5/5）');
  assert.equal(modelRetryLabel({ ...thread, modelRetry: null }), '');
  assert.equal(modelRetryLabel({ ...thread, busy: false }), '');
  assert.equal(modelRetryLabel({ ...thread, runtimeStale: true }), '');
  assert.equal(modelRetryLabel({ ...thread, error: 'failed after Reconnecting... 5/5' }), '');
});

test('upstream HTML errors keep status and actionable guidance without exposing page contents', () => {
  for (const code of ['401', '403', '429', '502']) {
    const message = `stream disconnected before completion: unexpected status ${code} Forbidden: <html><head><style>body{font-family:Arial}</style></head><body>private diagnostic</body></html>`;
    const shown = readableNotice(message);
    assert.ok(shown.includes(`HTTP ${code}`)); assert.doesNotMatch(shown, /<html|style|Arial|private diagnostic/);
  }
  assert.match(readableNotice('unexpected status 403 Forbidden: <html><head><style>body{'), /HTTP 403/);
  assert.doesNotMatch(readableNotice('unexpected status 403 Forbidden: <html>'), /额度|重新登录|已恢复|已重试/);
  assert.match(readableNotice('<!DOCTYPE html><html>proxy failure</html>'), /错误网页/);
});

test('ordinary runtime, validation and informational messages are retained verbatim', () => {
  for (const message of ['文件已变化，请重新打开。', 'stream disconnected before completion: rate limit exceeded', 'HTTP 403: workspace permission denied', 'Cannot open <html> example', '已复制项目绝对路径。', '']) assert.equal(readableNotice(message), message);
  assert.equal(readableNotice(null), '');
});
