import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { Workspace } from '../lib/workspace.mjs';
import { renderActivity, activityTitle, executionLayout, activityState, renderExecutionGroup, fileChangeLines } from '../public/execution-view.js';

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

test('native file patch snapshots stream before tool start, replace proposals and reject stale turns', t => {
  const { thread, emit, workspace, raw } = fixture(t);
  const first = { path: '/project/a.py', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-x=1\n+x=2' };
  emit('item/fileChange/patchUpdated', { itemId: 'edit', changes: [first] });
  assert.equal(thread.items.length, 1); assert.equal(thread.items[0].patchStreaming, true);
  emit('item/fileChange/patchUpdated', { itemId: 'edit', changes: [{ ...first, diff: first.diff + '00' }, { path: '/project/b.py', kind: { type: 'add' }, diff: '+y=1' }] });
  assert.equal(thread.items.length, 1); assert.equal(thread.items[0].changes.length, 2); assert.match(thread.items[0].changes[0].diff, /x=200$/);
  const refreshed = workspace.importThread(raw);
  assert.equal(refreshed.items.length, 1, 'refresh retains pre-start native proposal');
  emit('item/started', { item: { id: 'edit', type: 'fileChange', status: 'inProgress', changes: [] } });
  assert.equal(refreshed.items[0].changes.length, 2); assert.equal(refreshed.items[0].patchStreaming, undefined);
  emit('item/completed', { item: { id: 'edit', type: 'fileChange', status: 'completed', changes: [first] } });
  const completed = JSON.stringify(refreshed.items);
  emit('item/fileChange/patchUpdated', { itemId: 'edit', changes: [{ ...first, diff: 'late' }] });
  emit('item/fileChange/patchUpdated', { itemId: 'other', turnId: 'old-turn', changes: [first] });
  emit('item/fileChange/patchUpdated', { itemId: 'other', threadId: 'other-thread', changes: [first] });
  assert.equal(JSON.stringify(refreshed.items), completed);
  refreshed.busy = false;
  emit('item/fileChange/patchUpdated', { itemId: 'late', changes: [first] });
  assert.equal(JSON.stringify(refreshed.items), completed);
});

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

test('inline file diffs distinguish patch headers from literal signs, show exact line numbers and bound large previews', () => {
  const patch = '--- a/demo.py\n+++ b/demo.py\n@@ -36,2 +36,3 @@\n keep\n---literal\n+++literal\n+<img src=x onerror=alert(1)>\n@@ -100 +101,0 @@\n-delete\n';
  const parsed = fileChangeLines(patch);
  assert.equal(parsed.known, true); assert.equal(parsed.added, 2); assert.equal(parsed.removed, 2);
  assert.deepEqual(parsed.rows.filter(row => ['add', 'remove'].includes(row.kind)), [
    { kind: 'remove', oldLine: 37, text: '--literal' }, { kind: 'add', newLine: 37, text: '++literal' },
    { kind: 'add', newLine: 38, text: '<img src=x onerror=alert(1)>' }, { kind: 'remove', oldLine: 100, text: 'delete' },
  ]);
  assert.equal(fileChangeLines('没有文本差异').known, false);
  const large = fileChangeLines('@@ -0,0 +1,4000 @@\n' + '+line\n'.repeat(4000));
  assert.equal(large.rows.length, 3000); assert.equal(large.truncated, true); assert.equal(large.known, false);
  assert.equal(fileChangeLines('x'.repeat(200_001)).truncated, true);
});

test('native file changes appear before completion and preserve rows, folding, selection and output during live updates', t => {
  const { thread, emit } = fixture(t), dom = new JSDOM('<article></article>'), document = dom.window.document;
  t.after(() => dom.window.close());
  const element = document.querySelector('article'), opened = [], options = { cwd: '/project', onOpenFile: entry => opened.push(entry), animate: true };
  let item = { id: 'edit', type: 'fileChange', status: 'inProgress', changes: [{ path: '/project/demo.py', kind: { type: 'update' }, diff: '@@ -1 +1,2 @@\n-old\n+new\n+<img src=x>\n' }] };
  emit('item/started', { item }); renderActivity(element, thread.items[0], options);
  const details = element.querySelector('.activity-details'), file = element.querySelector('.file-change-file'), code = element.querySelector('[data-kind=add] .file-diff-code'), scroller = element.querySelector('.file-diff-scroll'), link = element.querySelector('.file-change-path');
  assert.equal(details.open, true); assert.equal(file.open, true); assert.equal(element.dataset.executionState, 'running');
  assert.equal(code.textContent, 'new'); assert.match(element.textContent, /\+2  −1/); assert.equal(element.querySelector('img'), null);
  assert.equal(element.querySelector('.activity-output'), null, 'patch is visible directly, not in a generic output box');
  const selection = dom.window.getSelection(), range = document.createRange(); range.selectNodeContents(code); selection.addRange(range);
  assert.equal(selection.toString(), 'new'); scroller.scrollTop = 47; scroller.scrollLeft = 19; file.open = false;
  emit('item/fileChange/outputDelta', { itemId: 'edit', delta: '应用中\n' }); renderActivity(element, thread.items[0], options);
  assert.equal(element.querySelector('.file-change-file'), file); assert.equal(file.open, false);
  assert.equal(element.querySelector('[data-kind=add] .file-diff-code'), code); assert.equal(selection.toString(), 'new');
  assert.equal(scroller.scrollTop, 47); assert.equal(scroller.scrollLeft, 19);
  assert.equal(element.querySelector('.file-change-log').hidden, false); assert.match(element.querySelector('.activity-log').textContent, /应用中/);
  renderActivity(element, thread.items[0], { ...options, waiting: true }); assert.equal(element.dataset.executionState, 'waiting'); assert.match(element.querySelector('.file-change-hint').textContent, /待确认/);
  renderActivity(element, thread.items[0], { ...options, live: false }); assert.equal(element.dataset.executionState, 'unknown');
  item = { ...item, status: 'completed' }; emit('item/completed', { item }); renderActivity(element, thread.items[0], options);
  assert.equal(element.dataset.executionState, 'completed'); assert.equal(element.querySelector('.file-change-path'), link);
  assert.equal(selection.toString(), 'new'); assert.equal(file.open, false); assert.match(element.querySelector('.file-change-hint').textContent, /已应用/);
  link.click(); assert.deepEqual(opened, [{ cwd: '/project', path: 'demo.py' }]);
  renderActivity(element, { ...thread.items[0], status: 'failed' }, options); assert.equal(element.dataset.executionState, 'failed'); assert.equal(code.textContent, 'new');
});

test('file preview actions enforce project and creation boundaries, retain unknown diffs and disclose limits', t => {
  const dom = new JSDOM('<article></article>'), element = dom.window.document.querySelector('article'); t.after(() => dom.window.close());
  const changes = [
    { path: '/project/new.py', kind: 'add', diff: '@@ -0,0 +1,200 @@\n' + '+line\n'.repeat(200) },
    { path: '/project/deleted.py', kind: 'delete', diff: '' }, { path: '/outside/other.py', kind: 'update' },
    { path: '/project/.env', kind: 'update' }, { path: '/project/before.py', movePath: '/project/after.py', kind: 'update', diff: '' },
  ], options = { cwd: '/project', onOpenFile() {} };
  renderActivity(element, { type: 'fileChange', status: 'inProgress', changes }, options);
  const files = [...element.querySelectorAll('.file-change-file')];
  assert.deepEqual(files.map(file => file.querySelector('button').disabled), [true, true, true, true, false]);
  assert.match(files[1].textContent, /尚未提供文本差异/); assert.equal(files[0].querySelectorAll('.file-diff-line').length, 160);
  files[0].querySelector('.file-diff-more').click(); assert.equal(files[0].querySelectorAll('.file-diff-line').length, 201);
  renderActivity(element, { type: 'fileChange', status: 'completed', changes }, options);
  assert.equal(files[0].querySelector('button').disabled, false); assert.match(files[4].querySelector('button').title, /after\.py/);
  renderActivity(element, { type: 'fileChange', status: 'completed', changes: Array.from({ length: 15 }, (_, i) => ({ path: `/project/file${i}.py`, diff: '' })) }, options);
  assert.equal(element.querySelectorAll('.file-change-file').length, 12); assert.match(element.textContent, /另有 3 个文件/);
});
