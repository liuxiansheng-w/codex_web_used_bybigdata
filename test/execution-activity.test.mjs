import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { Workspace } from '../lib/workspace.mjs';
import { renderActivity, activityTitle, executionLayout, activityState, renderExecutionGroup } from '../public/execution-view.js';

test('activity segments respect replies, file edits, subtasks and legacy turn boundaries', () => {
  const entries = [
    ['u1', 'userMessage'], ['c1', 'commandExecution'], ['note', 'agentMessage'], ['c2', 'commandExecution'],
    ['file', 'fileChange'], ['c3', 'webSearch'], ['child', 'collabAgentToolCall'], ['c4', 'mcpToolCall'],
    ['u2', 'userMessage'], ['c5', 'commandExecution'],
  ].map(([id, type]) => ({ id, type }));
  const blocks = executionLayout(entries), groups = blocks.filter(block => block.items);
  assert.deepEqual(groups.map(block => block.items.map(item => item.id)), [['c1'], ['c2'], ['c3'], ['c4'], ['c5']]);
  assert.deepEqual(groups.map(block => block.turnId), ['u1', 'u1', 'u1', 'u1', 'u2']);
  const mixed = executionLayout([{ id: 'c1', type: 'commandExecution', turnId: 't1' }, { id: 'c2', type: 'commandExecution', turnId: 't2' }, { id: 'c3', type: 'commandExecution', turnId: 't1' }]);
  assert.equal(mixed.length, 3); assert.equal(new Set(mixed.map(block => block.key)).size, 3);
});

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

test('execution motion follows observed status and never treats interrupted or disconnected work as running', () => {
  const running = { type: 'commandExecution', status: 'inProgress', turnStatus: 'inProgress' };
  assert.equal(activityState(running), 'running');
  assert.equal(activityState(running, { live: false }), 'unknown');
  assert.equal(activityState(running, { active: false }), 'unknown', 'a historical inProgress record must not keep spinning');
  assert.equal(activityState(running, { waiting: true }), 'waiting');
  assert.equal(activityState({ ...running, turnStatus: 'interrupted' }), 'interrupted');
  assert.equal(activityState({ ...running, turnStatus: 'completed' }), 'unknown');
  assert.equal(activityState({ ...running, status: 'completed', exitCode: 1 }), 'failed');
  const dom = new JSDOM('<article></article>'), element = dom.window.document.querySelector('article');
  renderActivity(element, { ...running, status: 'completed' }, { animate: true });
  assert.equal(element.querySelector('.just-completed'), null, 'history must not replay a completion effect');
  renderActivity(element, running, { animate: true });
  const marker = element.querySelector('.activity-marker'), details = element.querySelector('details'); details.open = true;
  renderActivity(element, { ...running, status: 'completed', turnStatus: 'completed' }, { animate: true });
  assert.equal(element.dataset.executionState, 'completed'); assert.equal(marker.textContent, '✓'); assert.equal(marker.classList.contains('just-completed'), true);
  const end = new dom.window.Event('animationend', { bubbles: true }); Object.defineProperty(end, 'animationName', { value: 'execution-complete' }); marker.dispatchEvent(end);
  renderActivity(element, { ...running, status: 'completed', text: '追加记录' }, { animate: true }); assert.equal(marker.classList.contains('just-completed'), false, 'ordinary streamed updates must not restart completion motion'); assert.equal(details.open, true); assert.equal(element.querySelector('.activity-marker'), marker);
  renderActivity(element, running, { live: false }); assert.equal(element.dataset.executionState, 'unknown'); assert.equal(element.querySelector('.activity-status').textContent, '状态待同步');
  dom.window.close();
});
test('execution header motion stops for approvals, missing live state and completion without rebuilding expanded logs', () => {
  const dom = new JSDOM('<details><summary></summary><article>保留输出</article></details>'), group = dom.window.document.querySelector('details');
  const items = [{ id: 'run', type: 'commandExecution', status: 'inProgress', title: '示例命令' }]; group.open = true;
  renderExecutionGroup(group, { items, active: true }); const heading = group.firstElementChild, status = group.querySelector('.execution-status'), output = group.querySelector('article');
  assert.equal(group.dataset.executionState, 'running'); assert.match(status.textContent, /进行中/);
  group.open = false; renderExecutionGroup(group, { items, active: true, waiting: true }); assert.equal(group.dataset.executionState, 'waiting'); assert.match(status.textContent, /等待你处理/);
  renderExecutionGroup(group, { items, active: true, live: false }); assert.equal(group.dataset.executionState, 'unknown'); assert.match(status.textContent, /状态待同步/);
  renderExecutionGroup(group, { items: [{ ...items[0], status: 'failed' }], active: false }); assert.equal(group.dataset.executionState, 'failed'); assert.match(status.textContent, /1 项需查看/);
  assert.equal(group.firstElementChild, heading); assert.equal(group.querySelector('article'), output); assert.equal(group.open, false); assert.equal(group.querySelectorAll('.execution-flow').length, 1);
  dom.window.close();
});
