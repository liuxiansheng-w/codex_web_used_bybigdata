import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { subtaskGroups, createAgentCards, agentSummary } from '../public/task-results.js';

const collaboration = (id, turnId, tool, agentId, status, message = '') => ({ id, turnId, type: 'collabAgentToolCall', senderThreadId: 'main', tool, receiverThreadIds: [agentId], prompt: '检查页面', agentsStates: { [agentId]: { status, message } } });
test('one inline group per turn deduplicates collaboration events and isolates earlier results from reused agents', () => {
  const groups = subtaskGroups({ id: 'main', items: [
    collaboration('spawn-a', 'first', 'spawnAgent', 'a', 'running'), collaboration('wait-a', 'first', 'wait', 'a', 'completed', '第一轮结果'),
    collaboration('spawn-b', 'first', 'spawnAgent', 'b', 'errored', '检查失败'), collaboration('again-a', 'second', 'followupTask', 'a', 'running'),
  ] });
  assert.equal(groups.length, 2); assert.equal(groups[0].anchor, 'spawn-a'); assert.equal(groups[0].agents.length, 2);
  assert.equal(groups[0].agents[0].message, '第一轮结果'); assert.equal(groups[0].agents[0].live, false);
  assert.equal(groups[1].agents[0].message, ''); assert.equal(groups[1].agents[0].live, true);
  assert.match(agentSummary(groups[0].agents), /1 已完成 · 1 执行失败/);
});
function dom(t, html = '<main></main>') {
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const instance = new JSDOM(html, { url: 'http://127.0.0.1:4320', pretendToBeVisual: true, virtualConsole: vc });
  const before = Object.fromEntries(['window', 'document'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: instance.window, document: instance.window.document });
  t.after(() => { Object.assign(globalThis, before); instance.window.close(); assert.deepEqual(errors, []); });
  return instance;
}
test('agent content is visible immediately as safe Markdown; refresh keeps cards, focus and text selection', t => {
  const { window } = dom(t), container = document.querySelector('main');
  const view = createAgentCards(container, { onOpen() {}, onStop() {} });
  const row = { id: 'a', name: '审查任务', status: 'running', prompt: '核对代码', message: '**发现问题**\n\n<script>bad()</script>\n\n- 第一项\n- 第二项', canStop: true };
  view.update([row]); assert.equal(container.querySelectorAll('details').length, 0); assert.equal(container.querySelector('strong + .agent-state').textContent, '运行中');
  assert.equal(container.querySelector('.agent-output strong').textContent, '发现问题'); assert.equal(container.querySelector('script'), null); assert.equal(container.querySelectorAll('li').length, 2);
  const card = container.firstElementChild, output = container.querySelector('.agent-output'), child = output.firstElementChild, open = container.querySelector('.agent-actions button'); open.focus();
  view.update([{ ...row, status: 'waiting' }]); assert.equal(container.firstElementChild, card); assert.equal(output.firstElementChild, child); assert.equal(document.activeElement, open);
  const range = document.createRange(); range.selectNodeContents(output.querySelector('strong')); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); assert.equal(selection.toString(), '发现问题');
  view.update([{ ...row, message: '更新后的结果' }]); assert.equal(selection.toString(), '发现问题'); assert.equal(output.firstElementChild, child);
  selection.removeAllRanges(); view.update([{ ...row, message: '更新后的结果' }]); assert.equal(output.textContent, '更新后的结果');
});
test('stopping a subtask is single flight, and completion replaces the pending state without hiding another task', async t => {
  dom(t); let resolveStop, calls = 0; const container = document.querySelector('main');
  const view = createAgentCards(container, { onOpen() {}, onStop() { calls++; return new Promise(resolve => { resolveStop = resolve; }); } });
  const rows = [{ id: 'a', status: 'running', canStop: true }, { id: 'b', status: 'running', canStop: true }]; view.update(rows);
  const button = container.querySelector('.agent-stop'); button.click(); button.click(); assert.equal(calls, 1); assert.equal(button.disabled, true);
  resolveStop(); await Promise.resolve(); view.update([{ ...rows[0], status: 'interrupted', canStop: false }, rows[1]]);
  assert.equal(button.hidden, true); assert.equal(container.querySelector('[data-agent-id=b] .agent-state').textContent, '运行中');
});

test('conversation shows live subtask content without opening tools; panel shares cards and parent return is always available', async t => {
  const { window } = dom(t, await readFile(new URL('../public/index.html', import.meta.url), 'utf8'));
  const $ = id => document.getElementById(id); window.matchMedia = () => ({ matches: false }); window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {} }); window.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const globals = ['Option', 'localStorage', 'requestAnimationFrame', 'EventSource', 'fetch', 'confirm', 'setTimeout'], before = Object.fromEntries(globals.map(key => [key, globalThis[key]])), timers = new Set();
  Object.assign(globalThis, { Option: window.Option, localStorage: window.localStorage, requestAnimationFrame: fn => { fn(); return 0; }, confirm: () => true, setTimeout: (...args) => { const id = before.setTimeout(...args); timers.add(id); return id; } });
  t.after(() => { for (const timer of timers) clearTimeout(timer); Object.assign(globalThis, before); });
  const settle = async condition => { for (let i = 0; i < 400; i++) { if (condition()) return; await new Promise(resolve => before.setTimeout(resolve, 2)); } assert.fail(`UI did not settle: ${$('noticeText').textContent}`); };
  let events; globalThis.EventSource = class { constructor() { this.listeners = {}; events = this; } addEventListener(event, fn) { this.listeners[event] = fn; } close() {} emit(event, value) { this.listeners[event]?.({ data: JSON.stringify(value) }); } };
  const thread = { id: 'main', cwd: '/project', title: '主任务', revision: 1, busy: false, requests: [], mode: 'read-only', items: [collaboration('spawn', 'turn', 'spawnAgent', 'child', 'running'), collaboration('wait', 'turn', 'wait', 'child', 'running')] };
  let message = '自动展示的 **检查结果**', fail = false, release; const requests = [];
  globalThis.fetch = async route => {
    requests.push(route); let data;
    if (route === '/api/bootstrap') data = { connected: true, csrf: 'x', cwd: '/project', workbenchFeatures: true, auth: { loggedIn: true }, models: [], permissions: { options: [{ id: 'read-only', enabled: true }] } };
    else if (route.startsWith('/api/threads?')) data = { threads: [{ ...thread, items: [] }], cwd: '/project' };
    else if (route === '/api/threads/main') data = thread;
    else if (route === '/api/threads/child') data = { ...thread, id: 'child', title: '子会话', parentThreadId: 'main', items: [{ id: 'answer', type: 'agentMessage', text: '子会话内容' }] };
    else if (route === '/api/threads/main/agents') { if (fail) throw Error('offline'); if (release === 'pending') await new Promise(resolve => { release = resolve; }); data = { parentId: 'main', agents: [{ id: 'child', name: '页面审查', status: 'running', prompt: '检查页面', message, canStop: true }] }; }
    else if (route === '/api/threads/child/agents') data = { parentId: 'child', parentThreadId: 'main', agents: [] };
    else if (route.startsWith('/api/project/files')) data = { cwd: '/project', entries: [] };
    else if (route === '/api/sql/status') data = { available: false };
    else if (route.startsWith('/api/capabilities')) data = { skills: [], plugins: [] };
    else throw Error(`Unexpected ${route}`);
    return { ok: true, json: async () => structuredClone(data) };
  };
  await import(`../public/app.js?subtasks=${Date.now()}`); await settle(() => document.querySelector('[data-thread-id=main]'));
  document.querySelector('[data-thread-id=main]').click(); await settle(() => $('messages').textContent.includes('自动展示的'));
  assert.equal($('workbenchDialog').hidden, true); assert.equal($('messages').querySelectorAll('.subtasks-inline').length, 1); assert.equal($('messages').querySelectorAll('.agent-card').length, 1); assert.doesNotMatch($('messages').textContent, /查看子任务|查看结果|协作对象/);
  const original = $('messages').querySelector('.agent-output'); $('quickAgents').click(); await settle(() => $('agentResults').textContent.includes('自动展示的'));
  assert.equal($('agentResults').querySelector('details'), null); await settle(() => !$('agentsRefresh').disabled); message = '继续更新的结果'; $('agentsRefresh').click(); await settle(() => original.textContent.includes('继续更新')); await settle(() => !$('agentsRefresh').disabled);
  assert.equal($('messages').querySelector('.agent-output'), original);
  fail = true; $('agentsRefresh').click(); await settle(() => $('messages').textContent.includes('同步暂时中断')); await settle(() => !$('agentsRefresh').disabled); assert.match(original.textContent, /继续更新/); assert.equal($('messages').querySelector('.agent-stop').hidden, true);
  fail = false; $('agentsRefresh').click(); await settle(() => !$('messages').textContent.includes('同步暂时中断'));
  $('messages').querySelector('.agent-actions button').click(); await settle(() => $('threadTitle').textContent === '子会话'); assert.equal($('parentThreadBack').hidden, false);
  await settle(() => !$('parentThreadBack').disabled); $('closeWorkbench').click(); await new Promise(resolve => before.setTimeout(resolve, 0)); $('parentThreadBack').click(); await settle(() => $('threadTitle').textContent === '主任务'); assert.equal($('parentThreadBack').hidden, true);
  await settle(() => $('messages').textContent.includes('继续更新')); $('quickAgents').click(); await settle(() => !$('agentsRefresh').disabled); release = 'pending'; $('agentsRefresh').click(); await settle(() => typeof release === 'function');
  $('newThread').click(); await settle(() => $('threadTitle').textContent === '新对话'); release(); await new Promise(resolve => before.setTimeout(resolve, 10));
  assert.equal($('messages').querySelectorAll('.agent-card').length, 0, 'late parent result cannot leak into a new conversation');
  assert.equal(requests.some(route => /send|followup|start/.test(route)), false, 'automatic rendering never starts model work');
});
