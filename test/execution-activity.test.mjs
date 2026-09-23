import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { Workspace } from '../lib/workspace.mjs';
import { renderActivity, activityTitle } from '../public/execution-view.js';

function fixture(t, items = []) {
  const bridge = new EventEmitter(), workspace = new Workspace(bridge, '/project');
  const raw = { id: 'thread', cwd: '/project', turns: [{ id: 'turn', status: 'inProgress', items }] };
  const thread = workspace.importThread(raw);
  t.after(() => { for (const timer of workspace.timers.values()) clearTimeout(timer); });
  const emit = (method, params = {}) => workspace.notification({ method, params: { threadId: 'thread', turnId: 'turn', ...params } });
  return { workspace, raw, thread, emit };
}

test('public summaries stream by index, finalize once and never expose raw reasoning', t => {
  const { thread, emit, workspace } = fixture(t);
  emit('item/started', { item: { id: 'r', type: 'reasoning', summary: [], content: ['private chain'] } });
  emit('item/reasoning/textDelta', { itemId: 'r', delta: 'private chain delta' });
  assert.equal(thread.items.length, 0);
  emit('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: '检查' });
  emit('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: '文件' });
  emit('item/reasoning/summaryPartAdded', { itemId: 'r', summaryIndex: 1 });
  emit('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 1, delta: '运行验证' });
  assert.equal(thread.items[0].text, '检查文件\n\n运行验证');
  emit('item/completed', { item: { id: 'r', type: 'reasoning', summary: ['公开摘要'], content: ['private chain'], encryptedContent: 'private token' } });
  assert.equal(thread.items.length, 1); assert.equal(thread.items[0].status, 'completed');
  assert.equal(JSON.stringify(thread).includes('private'), false);
  const history = workspace.importThread({ id: 'history', turns: [{ id: 'old', status: 'completed', items: [{ id: 'r', type: 'reasoning', summary: ['公开摘要'], content: ['private'] }] }] });
  assert.equal(history.items[0].text, '公开摘要'); assert.equal(JSON.stringify(history).includes('private'), false);
});

test('plan and MCP progress update existing items, retain progress on completion and read refresh', t => {
  const { thread, emit, workspace, raw } = fixture(t);
  emit('turn/plan/updated', { plan: [{ step: '验证', status: 'inProgress' }] });
  emit('turn/plan/updated', { plan: [{ step: '验证', status: 'completed' }], explanation: '已验证' });
  const item = { id: 'mcp', type: 'mcpToolCall', tool: 'check', server: 'demo', status: 'inProgress', arguments: { apiKey: 'private-test-key' } };
  emit('item/started', { item });
  emit('item/mcpToolCall/progress', { itemId: 'mcp', message: '已完成 1/2' });
  emit('item/mcpToolCall/progress', { itemId: 'mcp', message: '已完成 1/2' });
  emit('item/mcpToolCall/progress', { itemId: 'mcp', message: '已完成 2/2' });
  item.status = 'completed'; item.durationMs = 1234; item.result = { content: [{ type: 'text', text: 'done' }] };
  emit('item/completed', { item });
  assert.equal(thread.items.length, 2); assert.deepEqual(thread.items[1].progress, ['已完成 1/2', '已完成 2/2']);
  assert.equal(thread.items[1].durationMs, 1234); assert.equal(JSON.stringify(thread).includes('private-test-key'), false);
  emit('item/mcpToolCall/progress', { itemId: 'mcp', message: 'stale' });
  assert.equal(thread.items[1].progress.length, 2);
  raw.turns[0].items = [item];
  const refreshed = workspace.importThread(raw);
  assert.equal(refreshed.items.filter(item => item.type === 'activityPlan').length, 1);
  assert.equal(refreshed.items.find(item => item.id === 'mcp').progress.length, 2);
});

test('history and live activities retain command metadata, web actions and actual failure status', t => {
  const command = { id: 'cmd', type: 'commandExecution', command: 'cat demo.md', cwd: '/project', commandActions: [{ type: 'read', name: 'demo.md', path: '/project/demo.md' }], status: 'completed', aggregatedOutput: 'hello', durationMs: 12, exitCode: 0 };
  const { thread, emit } = fixture(t, [command]);
  assert.equal(activityTitle(thread.items[0]), '读取 demo.md'); assert.equal(thread.items[0].cwd, '/project'); assert.equal(thread.items[0].durationMs, 12);
  emit('item/started', { item: { id: 'web', type: 'webSearch', action: { type: 'open_page', url: 'https://example.com/' } } });
  assert.equal(thread.items[1].status, 'inProgress'); assert.equal(thread.items[1].title, '打开网页');
  emit('item/completed', { item: { id: 'web', type: 'webSearch', action: { type: 'findInPage', url: 'https://example.com/', pattern: 'term' } } });
  assert.equal(thread.items[1].status, 'completed'); assert.match(thread.items[1].text, /term/);
  emit('item/completed', { item: { id: 'failed', type: 'dynamicToolCall', tool: 'test', status: 'completed', success: false } });
  assert.equal(thread.items[2].status, 'failed');
});

test('live output preserves expanded details, scroll and selected output; untrusted text stays inert', () => {
  const dom = new JSDOM('<article></article>'), document = dom.window.document, element = document.querySelector('article');
  const item = { type: 'commandExecution', title: 'cat demo.md', cwd: '/project', actions: [{ type: 'read', name: 'demo.md' }], text: 'first output', status: 'inProgress' };
  renderActivity(element, item);
  const details = element.querySelector('details'), output = element.querySelector('.activity-output'); details.open = true; output.scrollTop = 14;
  const range = document.createRange(); range.selectNodeContents(output.firstChild); document.getSelection().addRange(range);
  renderActivity(element, { ...item, text: 'first output\n<img src=x onerror=alert(1)>', durationMs: 1234, exitCode: 0, status: 'completed' });
  assert.equal(element.querySelector('details'), details); assert.equal(details.open, true); assert.equal(output.scrollTop, 14); assert.equal(document.getSelection().toString(), 'first output');
  assert.equal(element.querySelector('img'), null); assert.equal(element.querySelector('.activity-duration').textContent, '1.2 秒');
  assert.match(element.textContent, /读取 demo.md/); assert.match(element.textContent, /退出码：0/);
  renderActivity(element, { ...item, status: 'completed', exitCode: -1 }); assert.equal(element.querySelector('.activity-status').textContent, '失败');
  renderActivity(element, { ...item, turnStatus: 'interrupted' }); assert.equal(element.querySelector('.activity-status').textContent, '已结束，状态未返回');
  dom.window.close();
});
