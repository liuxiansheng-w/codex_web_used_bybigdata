import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { taskResult, projectPath } from '../public/task-results.js';
import { Workspace } from '../lib/workspace.mjs';
test('switching model service retains editor and composer drafts, separates old conversations and never stores a key', async t => {
  const { $, document, window, settle, input, open, requests } = await page(t);
  let connection = { active: 'codex', revision: 0, cosmos: { protocol: 'workflow', baseUrl: 'https://cosmos.example/v1', model: '', inputKey: 'input', outputKey: 'output', hasKey: false } };
  const originalFetch = globalThis.fetch, providerRequests = [];
  globalThis.fetch = async (route, options = {}) => {
    if (route === '/api/model-connections') {
      if (options.body) { const body = JSON.parse(options.body); providerRequests.push(body); connection = { ...connection, active: body.action === 'configure' ? 'cosmos' : body.provider, revision: connection.revision + 1, cosmos: { ...connection.cosmos, hasKey: true } }; }
      return { ok: true, json: async () => structuredClone(connection) };
    }
    const response = await originalFetch(route, options);
    if (route === '/api/bootstrap') { const data = await response.json(); return { ok: true, json: async () => ({ ...data, modelConnections: connection, models: [{ id: 'native-model', name: 'Native', isDefault: true }, { id: 'lemon-cosmos', name: 'Cosmos', efforts: [] }] }) }; }
    return response;
  };
  await open('a.py'); input('fileEditorText', 'x=9 # keep unsaved'); input('prompt', 'keep this unsent message');
  const editor = $('fileEditorText');
  $('modelSwitchButton').click(); await settle(() => document.querySelector('.model-connection-dialog [data-model-apply]').disabled === false);
  document.querySelector('[data-model-provider=cosmos]').click(); $('cosmosKey').value = 'fictional-only-key';
  document.querySelector('.model-connection-dialog form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => !document.querySelector('.model-connection-dialog').open);
  assert.equal($('model').value, 'lemon-cosmos'); assert.match($('modelSwitchButton').textContent, /Cosmos/);
  assert.equal($('fileEditorText'), editor); assert.equal(editor.value, 'x=9 # keep unsaved'); assert.equal($('prompt').value, 'keep this unsent message');
  assert.equal($('cosmosKey').value, ''); assert.equal(JSON.stringify(window.localStorage).includes('fictional-only-key'), false);
  assert.equal($('accountQuota').textContent.includes('46%'), false);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  assert.match($('modelSwitchButton').textContent, /Codex/); assert.notEqual($('model').value, 'lemon-cosmos');
  $('newThread').click(); assert.equal($('model').value, 'lemon-cosmos'); assert.equal($('prompt').value, 'keep this unsent message');
  assert.equal(providerRequests.length, 1); assert.equal(requests.some(r => r.route === '/api/send'), false);
});
test('comment shortcut remains in the editor while the same shortcut outside still searches sessions', async t => {
  const { $, document, window, open, requests } = await page(t);
  await open('a.py'); const input = $('fileEditorText'); input.focus(); input.setSelectionRange(0,input.value.length);
  const key = target => target.dispatchEvent(new window.KeyboardEvent('keydown',{key:'/',code:'Slash',metaKey:true,bubbles:true,cancelable:true}));
  key(input); assert.equal(input.value,'# x=1\n'); assert.equal(document.activeElement,input); assert.equal($('historyPanel').hidden,true);
  key(input); assert.equal(input.value,'x=1\n');
  $('prompt').focus();key($('prompt')); assert.equal(document.activeElement,$('search')); assert.equal($('historyPanel').hidden,false);
  assert.equal(requests.filter(request=>request.route.includes('/save')||request.route.includes('/sql/query')).length,0);
});
test('selection uses the existing menu and grouped execution preserves expanded state across updates', async t => {
  const { $, document, window, settle, events, thread, input, open, requests } = await page(t);
  await open('a.py');const editor=$('fileEditorText');editor.setSelectionRange(0,3);editor.dispatchEvent(new window.Event('select'));
  assert.equal($('selectionActions'),null);
  $('editorMoreToggle').click();
  assert.equal($('editorAdvanced').hidden,false);
  $('editorExplain').click();
  assert.match($('prompt').value,/x=1/);assert.equal(requests.filter(r=>r.route.includes('/turn')).length,0);
  document.querySelector('[data-thread-id=t1]').click();await settle(()=>$('threadTitle').textContent==='Task');
  const items=[{id:'user1',type:'userMessage',text:'帮我检查代码',turnId:'turn1'}, {id:'cmd1',type:'commandExecution',command:'检查一',status:'completed',exitCode:0,turnId:'turn1'},{id:'cmd2',type:'commandExecution',command:'检查二',status:'failed',exitCode:1,turnId:'turn1'},{id:'answer',type:'agentMessage',text:'已检查',turnId:'turn1'}];
  events.emit('thread',{...thread,revision:2,items});
  const group=document.querySelector('.execution-group');assert.ok(group);assert.equal(group.querySelectorAll('.tool').length,2);assert.match(group.firstElementChild.textContent,/1 项需查看/);assert.equal(group.contains(document.querySelector('.message.assistant')),false);
  group.open=true;events.emit('thread',{...thread,revision:3,items:[...items,{id:'cmd3',type:'commandExecution',command:'检查三',status:'completed',exitCode:0,turnId:'turn1'}]});
  assert.equal(document.querySelector('.execution-group'),group);assert.equal(group.open,true);assert.equal(group.querySelectorAll('.tool').length,3);
  input('prompt','');[...document.querySelectorAll('.user-message-actions button')].find(button=>button.textContent==='编辑后重发').click();
  assert.equal($('prompt').value,'帮我检查代码');assert.equal(requests.filter(r=>r.route.includes('/turn')).length,0);
});

test('on-demand files preserve turn boundaries and exclude failed changes from artifacts', t => {
  const bridge = new EventEmitter(), workspace = new Workspace(bridge, '/project');
  t.after(() => { for (const timer of workspace.timers.values()) clearTimeout(timer); });
  const thread = workspace.importThread({ id: 'one', cwd: '/project', turns: [
    { id: 'old', status: 'completed', items: [{ id: 'old-file', type: 'fileChange', status: 'completed', changes: [{ path: '/project/old.py', diff: 'old' }] }] },
    { id: 'new', status: 'completed', items: [
      { id: 'f1', type: 'fileChange', status: 'completed', changes: [{ path: '/project/new file.py', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-x=1\n+x=2' }] },
      { id: 'cmd', type: 'commandExecution', status: 'completed', command: 'node --test', exitCode: 1, aggregatedOutput: 'failed test' },
      { id: 'answer', type: 'agentMessage', text: '[报告](<report one.md>) [外部](https://example.com/report.pdf) [越界](../private.txt)' },
    ] },
  ] });
  let result = taskResult(thread);
  assert.equal(thread.latestTurnId, 'new'); assert.equal(thread.completion, 'completed');
  assert.deepEqual(result.changes.map(file => file.path), ['new file.py']);
  assert.deepEqual(result.artifacts.map(file => file.path), ['new file.py', 'report one.md']);
  workspace.notification({ method: 'turn/started', params: { threadId: 'one', turn: { id: 'third' } } });
  assert.equal(taskResult(thread).artifacts.length, 0, 'an empty new turn must not expose the previous turn artifacts');
  workspace.notification({ method: 'item/completed', params: { threadId: 'one', turnId: 'third', item: { id: 'denied', type: 'fileChange', status: 'declined', changes: [{ path: '/project/no.py' }] } } });
  workspace.notification({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'third', status: 'interrupted' } } });
  result = taskResult(thread); assert.equal(result.artifacts.length, 0); assert.equal(result.changes[0].status, 'declined');
  for (const target of ['/project-other/a.txt', '../a.txt', '.env', 'javascript:alert(1)', '/private/a.txt']) assert.equal(projectPath(target, '/project'), null);
});

test('live execution displays public activity and retains manual collapse, tool nodes and composer drafts', async t => {
  const { $, document, settle, events, thread, input, requests } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  input('prompt', '保留这个草稿');
  const items = [
    { id: 'u', type: 'userMessage', text: '检查', turnId: 'live' },
    { id: 's', type: 'activitySummary', title: '工作摘要', text: '核对文件后运行验证', turnId: 'live' },
    { id: 'p', type: 'activityPlan', title: '任务计划', steps: [{ step: '读取文件', status: 'completed' }, { step: '验证', status: 'inProgress' }], turnId: 'live' },
    { id: 'tool', type: 'mcpToolCall', title: '测试工具', text: '', progress: ['已完成 1/2'], status: 'inProgress', turnId: 'live' },
  ];
  events.emit('thread', { ...thread, revision: 2, busy: true, turnId: 'live', latestTurnId: 'live', items });
  const group = document.querySelector('.execution-group'), tool = group.querySelector('.activity-details');
  assert.equal(group.open, true); assert.match(group.textContent, /核对文件后运行验证/); assert.match(group.textContent, /已完成 1\/2/);
  assert.equal(group.querySelectorAll('.activity-steps li').length, 2);
  group.open = false; tool.open = true;
  items[3] = { ...items[3], text: '结果', status: 'completed', progress: ['已完成 1/2', '已完成 2/2'], durationMs: 2500 };
  events.emit('thread', { ...thread, revision: 3, busy: false, turnId: null, latestTurnId: 'live', completion: 'completed', items });
  assert.equal(document.querySelector('.execution-group'), group); assert.equal(group.open, false);
  assert.equal(group.querySelector('.activity-details'), tool); assert.equal(tool.open, true); assert.match(group.firstElementChild.textContent, /已结束/);
  assert.equal($('prompt').value, '保留这个草稿'); assert.equal(requests.some(request => request.route === '/api/send'), false);
});

test('historical file attachments hide transport paths, open in the editor and do not pollute resend text', async t => {
  const { $, document, settle, events, thread, requests } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  const text = '检查这个文件\n用户附加的文件："a.py"\n本机路径："/project/a.py"';
  const items = [{ id: 'file-message', type: 'userMessage', text, attachments: [] }];
  events.emit('thread', { ...thread, revision: 2, items });
  const message = document.querySelector('.message.user'), body = message.children[1];
  assert.equal(body.textContent, '检查这个文件'); assert.equal(message.querySelector('details').open, false);
  assert.equal(message.querySelector('.attachment-file-info strong').textContent, 'a.py');
  const reads = requests.filter(request => request.route.startsWith('/api/project/file?')).length;
  assert.equal(reads, 0, 'rendering a card must not read its file');
  message.querySelector('.attachment-file-main').click(); await settle(() => $('fileEditorText').value === 'x=1\n');
  assert.equal($('fileEditor').hidden, false);
  [...message.querySelectorAll('.user-message-actions button')].find(button => button.textContent === '编辑后重发').click();
  assert.equal($('prompt').value, '检查这个文件'); assert.match($('noticeText').textContent, /附件请重新选择/);
  assert.equal(items[0].text, text);
  assert.equal(requests.some(request => /\/save|\/sql\/query|\/api\/send/.test(request.route)), false);
});

test('expired realtime sessions recover automatically without replaying writes or resetting drafts', async t => {
  const { $, window, document, settle, requests, events, getEvents, thread, input, open } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  await open('a.py'); input('fileEditorText', 'unsaved = 2\n'); input('prompt', '保留这条未发送的消息');
  $('prompt').focus(); $('prompt').setSelectionRange(3, 5);
  const editor = $('fileEditorText'), prompt = $('prompt');
  const originalFetch = globalThis.fetch, reads = []; let expired = true;
  globalThis.fetch = async (route, options) => {
    reads.push(route);
    if (route === '/api/bootstrap' && expired) return { ok: false, status: 401, json: async () => ({ error: '连接已过期' }) };
    if (route === '/') { expired = false; return { ok: true, text: async () => '<html></html>' }; }
    return originalFetch(route, options);
  };
  events.emit('error'); assert.match($('connectionText').textContent, /恢复实时连接/);
  await new Promise(resolve => setTimeout(resolve, 850)); await settle(() => getEvents() !== events);
  const recovered = getEvents(); recovered.emit('open');
  thread.revision = 0; thread.items = [{ id: 'latest', type: 'agentMessage', text: '恢复后的真实状态' }];
  recovered.emit('snapshot', { connected: true, threads: [] });
  await settle(() => $('messages').textContent.includes('恢复后的真实状态'));
  assert.deepEqual(reads.filter(route => route === '/' || route === '/api/bootstrap'), ['/api/bootstrap', '/', '/api/bootstrap']);
  assert.equal($('connectionText').textContent, '本地已连接');
  assert.equal($('prompt'), prompt); assert.equal(prompt.value, '保留这条未发送的消息');
  assert.equal(document.activeElement, prompt); assert.equal(prompt.selectionStart, 3);
  assert.equal($('fileEditorText'), editor); assert.equal(editor.value, 'unsaved = 2\n');
  events.emit('error'); events.emit('thread', { ...thread, revision: 999, items: [] });
  assert.equal($('connectionText').textContent, '本地已连接');
  assert.match($('messages').textContent, /恢复后的真实状态/);
  assert.equal(requests.some(request => request.body), false, 'recovery must never replay a send, approval, query or save');
  window.dispatchEvent(new window.Event('online'));
  assert.equal(getEvents(), recovered, 'online events do not reopen a healthy stream');
});

test('live patches update replies and approvals; manual reconnect preserves the conversation and form input', async t => {
  const { $, document, settle, events, getEvents, thread, requests, input } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  events.emit('snapshot', { connected: true, threads: [thread] });
  input('prompt', '还没有发送');
  const item = { id: 'reply', type: 'agentMessage', text: '增量返回' };
  const fields = { ...thread, revision: 2, busy: true, items: undefined };
  events.emit('thread-patch', { baseRevision: 1, thread: fields, order: ['reply'], items: [item] });
  assert.match($('messages').textContent, /增量返回/);
  events.emit('thread-patch', { baseRevision: -1, thread: fields, order: [], items: [] });
  assert.match($('connectionText').textContent, /恢复实时连接/);
  $('reconnect').click(); await settle(() => getEvents() !== events);
  getEvents().emit('open'); getEvents().emit('snapshot', { connected: true, threads: [{ ...fields, items: [item] }] });
  assert.equal($('prompt').value, '还没有发送'); assert.match($('messages').textContent, /增量返回/);
  assert.equal(requests.some(request => request.body), false);
});

async function page(t, stored = {}, terminalProcesses = []) {
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4318', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom, document = window.document, $ = id => document.getElementById(id);
  for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);
  window.matchMedia = () => ({ matches: false }); window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {} });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const saved = Object.fromEntries(['window', 'document', 'Option', 'localStorage', 'requestAnimationFrame', 'EventSource', 'fetch', 'confirm', 'setTimeout'].map(key => [key, globalThis[key]]));
  const timers = new Set();
  Object.assign(globalThis, { window, document, Option: window.Option, localStorage: window.localStorage, confirm: () => true, requestAnimationFrame: fn => { fn(); return 0; }, setTimeout: (...args) => { const id = saved.setTimeout(...args); timers.add(id); return id; } });
  t.after(() => { for (const timer of timers) clearTimeout(timer); Object.assign(globalThis, saved); window.close(); assert.deepEqual(errors, []); });
  const settle = async condition => { for (let n = 0; n < 300; n++) { if (condition()) return; await new Promise(resolve => saved.setTimeout(resolve, 1)); } assert.fail(`UI did not settle: ${$('noticeText').textContent} ${$('fileEditorError').textContent}`); };
  let events;
  globalThis.EventSource = class { constructor() { this.listeners = {}; events = this; } addEventListener(name, fn) { this.listeners[name] = fn; } close() {} emit(name, value) { this.listeners[name]?.({ data: JSON.stringify(value) }); } };
  const requests = [], files = { 'a.py': 'x=1\n', 'b.py': 'y=1\n' };
  const thread = { id: 't1', cwd: '/project', title: 'Task', revision: 1, items: [], requests: [], busy: false, mode: 'workspace-write' };
  let conflict = false;
  globalThis.fetch = async (route, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; requests.push({ route, body }); const url = new URL(route, 'http://localhost'); let data;
    switch (url.pathname) {
      case '/api/bootstrap': data = { connected: true, csrf: 'test', cwd: '/project', models: [], auth: { loggedIn: true }, permissions: { options: [{ id: 'workspace-write', enabled: true }] } }; break;
      case '/api/usage': data = { rateLimits: { primary: { usedPercent: 54, windowDurationMins: 10080 } } }; break;
      case '/api/threads': data = { cwd: '/project', threads: [thread] }; break;
      case '/api/threads/t1': data = thread; break;
      case '/api/project/files': {
        const folder = url.searchParams.get('path') || '', prefix = folder ? folder + '/' : '', entries = new Map();
        for (const path of Object.keys(files)) if (path.startsWith(prefix)) { const tail = path.slice(prefix.length), name = tail.split('/')[0]; entries.set(name, { path: prefix + name, name, kind: tail.includes('/') ? 'folder' : 'file' }); }
        data = { cwd: '/project', entries: [...entries.values()], nextOffset: null }; break;
      }
      case '/api/project/file': { const path = url.searchParams.get('path'); data = { cwd: '/project', path, content: files[path], version: 'a'.repeat(64), writable: true, newline: 'LF' }; break; }
      case '/api/project/save': if (conflict) return { ok: false, status: 409, json: async () => ({ error: '磁盘冲突' }) }; files[body.path] = body.content; data = { ...body, writable: true, newline: 'LF' }; break;
      case '/api/project/attach': data = { id: 'disk', name: body.path, projectRoot: body.cwd, projectPath: body.path, kind: 'file' }; break;
      case '/api/attachments/upload': data = { id: 'snapshot', name: body.name, kind: 'file' }; break;
      case '/api/capabilities': data = { skills: [], plugins: [], planSupported: true }; break;
      case '/api/sql/status': data = { available: true }; break;
      case '/api/respond': data = { ok: true }; break;
      case '/api/project/search': data = { cwd: '/project', results: [{ path: 'unloaded/nested.py', line: 1, text: 'unloaded/nested.py' }], scanned: 4 }; break;
      case '/api/git': data = { cwd: '/project', branch: 'main', files: [{ path: 'a.py', index: ' ', workingTree: 'M' }], version: 'v1', unstaged: 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x=1\n+x=2\n', staged: '' }; break;
      case '/api/git/action': data = { ok: true }; break;
      case '/api/terminal': data = { processes: terminalProcesses }; break;
      default: throw new Error(`Unexpected ${route}`);
    }
    return { ok: true, json: async () => structuredClone(data) };
  };
  await import(`../public/app.js?product=${Date.now()}`); events.emit('open'); await settle(() => document.querySelector('.file-main'));
  return { $, window, document, settle, requests, files, events, getEvents: () => events, thread, terminalProcesses, conflict: value => { conflict = value; },
    input(id, value) { $(id).value = value; $(id).dispatchEvent(new window.Event('input', { bubbles: true })); },
    async open(path) { document.querySelector(`.file-main[aria-label="打开编辑：${path}"]`).click(); await settle(() => $('editorFilename').textContent === path && !$('fileEditorText').readOnly); },
  };
}

test('approval toolbar preserves individual actions, question drafts and plugin forms across live updates', async t => {
  const { $, document, window, settle, events, thread, requests } = await page(t);
  const savedFormData = globalThis.FormData; globalThis.FormData = window.FormData; t.after(() => { globalThis.FormData = savedFormData; });
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  const command = key => ({ key, method: 'item/commandExecution/requestApproval', params: { threadId: 't1', command: `mock ${key}`, reason: '虚构审批测试' } });
  const question = { key: 'question', method: 'item/tool/requestUserInput', params: { threadId: 't1', questions: [{ id: 'answer', question: '填写测试答案' }] } };
  const permission = { key: 'permission', method: 'item/permissions/requestApproval', params: { threadId: 't1', permissions: { network: { enabled: true } } } };
  const plugin = { key: 'plugin', method: 'mcpServer/elicitation/request', params: { threadId: 't1', serverName: 'mock', mode: 'form', requestedSchema: { properties: { unsupported: { type: 'object' } } } } };
  const base = [question, permission, plugin];
  events.emit('thread', { ...thread, revision: 2, requests: [command('one'), command('two'), ...base] });
  assert.match($('approveAll').textContent, /（2）/); assert.equal($('approveAll').disabled, false);
  const answer = document.querySelector('[data-request-key=question] input'); answer.value = '保留输入中的答案'; answer.focus();
  const pluginCard = document.querySelector('[data-request-key=plugin]');
  assert.equal(pluginCard.querySelector('[type=submit]').disabled, true);
  assert.equal(document.querySelector('[data-request-key=permission] [type=submit]').textContent, '允许本轮权限');
  $('approveAll').click();
  await settle(() => requests.filter(r => r.route === '/api/respond').length === 2 && !document.querySelector('[data-request-key=two]'));
  assert.deepEqual(requests.filter(r => r.route === '/api/respond').map(r => r.body), [{ decision: 'accept', key: 'one' }, { decision: 'accept', key: 'two' }]);
  assert.equal(document.querySelector('[data-request-key=question] input'), answer); assert.equal(answer.value, '保留输入中的答案'); assert.equal(document.activeElement, answer);
  assert.equal(document.querySelector('[data-request-key=plugin]'), pluginCard); assert.equal(pluginCard.querySelector('[type=submit]').disabled, true);
  events.emit('thread', { ...thread, revision: 3, requests: [...base, command('later')] });
  assert.equal(requests.filter(r => r.route === '/api/respond').length, 2, 'new approval never inherits the batch');
  document.querySelector('[data-request-key=later] .secondary-button').click();
  await settle(() => !document.querySelector('[data-request-key=later]'));
  assert.deepEqual(requests.filter(r => r.route === '/api/respond').at(-1).body, { decision: 'decline', key: 'later' });
  document.querySelector('[data-request-key=question]').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => !document.querySelector('[data-request-key=question]'));
  assert.deepEqual(requests.filter(r => r.route === '/api/respond').at(-1).body, { key: 'question', answers: { answer: '保留输入中的答案' } });
});

test('account quota shares the composer footer and remains independent of thread context usage', async t => {
  const { $, document, settle, events, thread, input, requests } = await page(t);
  await settle(() => $('accountQuota').textContent.includes('46%'));
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  input('prompt', '不要发送这份草稿'); $('prompt').focus();
  events.emit('thread', { ...thread, revision: 2, tokenUsage: { total: { totalTokens: 12186496 }, last: { inputTokens: 82000 }, modelContextWindow: 100000 } });
  assert.match($('tokenUsage').textContent, /上下文 82%/); assert.equal($('accountQuota').textContent, '额度 46%');
  assert.equal($('accountQuota').parentElement, $('tokenUsage').parentElement);
  $('accountQuota').click(); await settle(() => $('accountQuota').getAttribute('aria-busy') === 'false');
  assert.equal($('prompt').value, '不要发送这份草稿'); assert.equal(document.activeElement, $('prompt'));
  assert.equal(requests.filter(({ route }) => route === '/api/usage').length, 2);
  assert.equal(requests.some(({ route }) => route === '/api/send'), false);
});

test('startup restores file layout with the active conversation and preserves pending opt-in drafts', async t => {
  const draft = { cwd: '/project', path: 'a.py', baseline: 'x=1\n', content: 'x=99\n', version: 'a'.repeat(64) };
  const { $, window, document, requests, settle } = await page(t, {
    'codex-desk:cwd': '/project', 'codex-desk:active': 't1', 'codex-desk:persistDrafts': 'true', 'codex-desk:editorDrafts': JSON.stringify([draft]),
    'lemon:workspaceMode': 'files', 'lemon:openFiles:v1': JSON.stringify({ version: 1, files: [{ cwd: '/project', path: 'a.py', start: 2, end: 2 }], projects: [{ cwd: '/project', active: 'a.py', visible: true }] }),
  });
  await settle(() => !$('fileEditorText').readOnly);
  assert.equal($('workSurface').dataset.mode, 'files'); assert.equal($('threadTitle').textContent, 'Task'); assert.equal($('fileEditorText').value, 'x=1\n');
  window.dispatchEvent(new window.Event('pagehide'));
  assert.deepEqual(JSON.parse(window.localStorage.getItem('codex-desk:editorDrafts')), [draft], 'metadata recovery must not clear a pending draft');
  $('recoverDraftsNow').click(); await settle(() => $('fileEditorText').value === 'x=99\n');
  assert.equal($('editorDirty').hidden, false); assert.equal($('draftRecovery').hidden, true);
  assert.equal(requests.filter(request => /\/save|\/send|\/sql\/query|\/completion/.test(request.route)).length, 0);
  assert.equal(document.querySelectorAll('.editor-tab').length, 1, 'draft recovery reuses the restored file tab');
});

test('native title updates synchronize the sidebar, heading and browser title without losing drafts', async t => {
  const { $, document, window, settle, events, thread, input, requests } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  input('prompt', '保留未发送内容');
  events.emit('thread', { ...thread, revision: 2, title: '原生会话名称' });
  assert.equal($('threadTitle').textContent, '原生会话名称');
  assert.match(document.querySelector('[data-thread-id=t1]').textContent, /原生会话名称/);
  assert.equal(document.title, '原生会话名称 — 柠檬');
  assert.equal($('prompt').value, '保留未发送内容');
  events.emit('thread', { ...thread, revision: 1, title: '过时名称' });
  assert.equal($('threadTitle').textContent, '原生会话名称');
  const count = requests.filter(request => request.route.startsWith('/api/threads?')).length;
  window.dispatchEvent(new window.Event('focus'));
  await settle(() => requests.filter(request => request.route.startsWith('/api/threads?')).length > count);
  assert.equal($('prompt').value, '保留未发送内容');
});

test('message images open a large preview with original sizing and download, while failures keep the message readable', async t => {
  const { $, document, window, settle, events, thread, input } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  input('prompt', '保留草稿');
  const previewUrl = '/api/attachments/images/12345678-1234-1234-1234-123456789abc';
  events.emit('thread', { ...thread, revision: 2, items: [{ id: 'photo', type: 'userMessage', text: '看图', attachments: [{ kind: 'image', name: '字段截图.png', previewUrl }] }] });
  const thumbnail = document.querySelector('.message.user .attachment-image img');
  assert.equal(thumbnail.getAttribute('src'), previewUrl); assert.equal(thumbnail.loading, 'lazy');
  document.querySelector('.attachment-image-button').click();
  const dialog = document.querySelector('.image-preview-dialog'); assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('img').getAttribute('src'), previewUrl);
  assert.equal(dialog.querySelector('a').download, '字段截图.png');
  dialog.querySelector('button.text-button').click(); assert.ok(dialog.querySelector('.original-size'));
  dialog.querySelector('button[aria-label="关闭图片预览"]').click(); assert.equal(dialog.open, false);
  assert.equal($('prompt').value, '保留草稿');
  thumbnail.dispatchEvent(new window.Event('error'));
  assert.equal(thumbnail.hidden, true); assert.match(document.querySelector('.message.user').textContent, /看图.*图片已失效或无法读取/s);
});

test('DGC SQL links open the integrated editor without a new page or automatic execution', async t => {
  const { $, document, settle, files, events, thread, requests } = await page(t);
  files['query.sql'] = 'SELECT 1;';
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  events.emit('thread', { ...thread, revision: 2, items: [{ id: 'sql-link', type: 'agentMessage', text: '[打开查询](http://127.0.0.1:5177/#path=%2Fproject%2Fquery.sql)' }] });
  const link = document.querySelector('.message.agent a'); assert.equal(link.getAttribute('target'), null); link.click();
  await settle(() => $('fileEditorText').value === 'SELECT 1;');
  assert.equal($('sqlTools').hidden, false); assert.equal($('sqlRun').textContent, '查询全文');
  assert.equal(requests.some(request => request.route === '/api/sql/query'), false);
});

test('dirty file version choices precede side effects, preserve drafts and stop on save conflict', async t => {
  const { $, document, settle, input, open, files, requests, conflict } = await page(t);
  await open('a.py'); input('fileEditorText', 'x=2 # 草稿\n');
  document.querySelector('.file-add[aria-label="加入对话：a.py"]').click(); await settle(() => $('referenceVersionDialog').open);
  assert.equal(requests.some(r => r.route === '/api/project/attach'), false); assert.equal($('sendButton').disabled, true);
  $('referenceSnapshot').click(); await settle(() => $('contextChips').textContent.includes('未保存快照'));
  assert.equal(files['a.py'], 'x=1\n'); const uploaded = requests.find(r => r.route === '/api/attachments/upload');
  assert.match(Buffer.from(uploaded.body.base64, 'base64').toString(), /x=2 # 草稿/); assert.match(Buffer.from(uploaded.body.base64, 'base64').toString(), /\/project\/a.py/);
  $('contextChips').querySelector('button').click();
  $('editorAttach').click(); await settle(() => $('referenceVersionDialog').open); $('referenceCancel').click(); await settle(() => !$('referenceVersionDialog').open && !$('editorAttach').disabled);
  assert.equal($('contextChips').children.length, 0);
  conflict(true); $('editorAttach').click(); await settle(() => $('referenceVersionDialog').open); $('referenceSave').click(); await settle(() => $('fileEditorError').textContent.includes('尚未成功保存'));
  assert.equal(requests.some(r => r.route === '/api/project/attach'), false); assert.equal(files['a.py'], 'x=1\n');
  conflict(false); $('editorAttach').click(); await settle(() => $('referenceVersionDialog').open); $('referenceDisk').click(); await settle(() => $('contextChips').textContent.includes('磁盘版本'));
  assert.equal(files['a.py'], 'x=1\n'); assert.equal($('fileEditorText').value, 'x=2 # 草稿\n');
  $('contextChips').querySelector('button').click();
  $('editorAttach').click(); await settle(() => $('referenceVersionDialog').open); $('referenceSave').click(); await settle(() => $('contextChips').textContent.includes('磁盘版本'));
  assert.equal(files['a.py'], 'x=2 # 草稿\n');
});

test('unsent prompt exit protection, unified settings, full-project search and clickable diff feedback', async t => {
  const { $, document, window, settle, input, requests } = await page(t);
  input('prompt', '尚未发送的长需求'); assert.equal($('draftChoice').hidden, false);
  $('newThread').click(); assert.equal($('prompt').value, '尚未发送的长需求', 'repeating new conversation must not silently erase the unsent draft');
  const unload = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); assert.equal(unload.defaultPrevented, true);
  $('enableDraftRecovery').click(); assert.equal(localStorage.getItem('codex-desk:persistDrafts'), 'true'); assert.match(localStorage.getItem('codex-desk:promptDrafts'), /尚未发送/);
  $('settingsButton').click(); assert.equal(document.querySelector('[data-panel=preferences]').hidden, false); assert.equal($('workbenchDialog').tagName, 'SECTION');
  assert.equal($('prompt').readOnly, false); assert.equal(document.querySelector('[data-tab=search]').hidden, true);
  $('closeWorkbench').click(); input('fileSearch', 'nested');
  await settle(() => $('projectFileTree').textContent.includes('unloaded/nested.py')); assert.match($('projectFileTree').textContent, /unloaded\/nested.py/); assert.ok(requests.some(r => r.route.includes('filenames=1')));
  $('quickGit').click(); $('review-tab-git').click(); await settle(() => document.querySelector('.git-file-name'));
  document.querySelector('.git-file-name').click(); const line = document.querySelector('button.diff-add'); assert.ok(line); line.click();
  assert.equal($('reviewLocation').value, 'a.py:1'); assert.equal(document.activeElement, $('reviewComment'));
  $('quickTerminal').click(); assert.equal($('bottomTerminal').hidden, false); assert.equal($('workbenchDialog').hidden, true); assert.equal($('prompt').readOnly, false);
  assert.equal(requests.some(r => r.route === '/api/terminal/start'), false);
});

test('startup restores the open terminal and existing output without selecting a conversation or executing a command', async t => {
  const { $, settle, requests } = await page(t, {
    'lemon:bottomPanel': JSON.stringify({ tab: 'terminal', open: true, height: 400 }),
  }, [{ id: 'restored-command', cwd: '/project', command: 'previous command', running: false, exitCode: 0, output: 'previous output' }]);
  await settle(() => $('terminal-restored-command'));
  assert.equal($('bottomTerminal').hidden, false);
  assert.equal($('bottomTabTerminal').getAttribute('aria-selected'), 'true');
  assert.match($('terminalResults').textContent, /previous output/);
  assert.equal(requests.some(r => r.route === '/api/terminal/start' || r.route === '/api/terminal/action'), false);
});

test('bottom terminal retains output and command drafts across tabs, collapse and same-project conversations without restarting commands', async t => {
  const { $, document, window, settle, input, requests, terminalProcesses, open } = await page(t);
  terminalProcesses.push({ id: 'running-demo', cwd: '/project', command: 'demo task', running: true, output: 'first output' });
  await open('a.py'); input('fileEditorText', 'x=7 # unsaved'); input('prompt', 'keep this draft');
  const editor = $('fileEditorText'); editor.setSelectionRange(2, 5);
  $('quickTerminal').click(); await settle(() => $('terminal-running-demo'));
  input('terminalCommand', 'pending stdin');
  const output = $('terminal-running-demo'); assert.equal($('terminalCommand').getAttribute('aria-label'), '终端标准输入');
  $('bottomTabResults').click(); assert.equal($('bottomTerminal').hidden, true); assert.equal($('bottomResultsEmpty').hidden, false);
  $('bottomTabTerminal').click(); await settle(() => !$('bottomTerminal').hidden);
  assert.equal($('terminal-running-demo'), output); assert.equal($('terminalCommand').value, 'pending stdin');
  $('bottomPanelClose').click(); assert.equal($('bottomTerminal').hidden, true); assert.equal(document.activeElement, $('bottomTabTerminal'));
  $('bottomTabTerminal').click(); terminalProcesses[0].output = 'second output';
  $('bottomTabResults').click(); $('bottomTabTerminal').click(); await settle(() => output.textContent.includes('second output'));
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  assert.equal($('terminal-running-demo'), output); assert.equal($('terminalCommand').value, 'pending stdin');
  assert.equal($('fileEditorText'), editor); assert.equal(editor.value, 'x=7 # unsaved'); assert.equal(editor.selectionStart, 2);
  assert.equal(requests.some(r => r.route === '/api/terminal/start' || r.route === '/api/terminal/action'), false);
  assert.equal($('bottomPanel').parentElement, $('workSurface'));
  $('bottomPanelClose').click(); assert.equal(JSON.parse(window.localStorage.getItem('lemon:bottomPanel')).open, false);
});

test('chat omits the result dashboard while changes and artifacts remain available on demand', async t => {
  const { $, document, settle, events, thread, requests, input } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  events.emit('thread', { ...thread, revision: 2, latestTurnId: 'done', completion: 'completed', turnTimings: [{ id: 'done', status: 'completed', durationMs: 246000 }], items: [
    { id: 'reply', turnId: 'done', type: 'agentMessage', text: '[结果](a.py)', timestamp: 1789635363000, timestampSource: 'native' },
    { id: 'check', turnId: 'done', type: 'commandExecution', title: 'node --test', status: 'completed', exitCode: 1, text: 'first attempt failed' },
    { id: 'file', turnId: 'done', type: 'fileChange', title: '修改文件', status: 'completed', changes: [{ path: 'a.py', diff: '@@ -1 +1 @@\n-x=1\n+x=2' }] },
  ] });
  assert.equal($('taskResult'), null); assert.equal($('workbenchDialog').hidden, true);
  assert.equal(document.querySelector('.message-time').getAttribute('datetime'), '2026-09-17T08:56:03.000Z');
  assert.equal(document.querySelector('.turn-duration').textContent, '用时 4 分钟 6 秒');
  assert.doesNotMatch($('scrollArea').textContent, /本轮结果|有异常 · 需检查|继续处理 \/ 补充验证/);
  $('quickGit').click(); $('review-tab-git').click(); await settle(() => document.querySelector('.git-file-name'));
  assert.equal($('turnChanges').hidden, false); assert.match($('turnChanges').textContent, /a\.py/);
  $('quickArtifacts').click(); assert.match($('artifactList').textContent, /a\.py/);
  assert.equal($('prompt').value, ''); assert.equal(requests.some(r => r.route === '/api/send'), false);
  events.emit('thread', { ...thread, revision: 3, latestTurnId: 'next', busy: true, items: [{ id: 'old', turnId: 'done', type: 'agentMessage', text: '[旧文件](a.py)' }] });
  assert.doesNotMatch($('artifactList').textContent, /a\.py/);
  $('quickGit').click(); $('review-tab-git').click(); await settle(() => document.querySelector('.git-file-name')); assert.equal($('turnChanges').hidden, true);
  events.emit('thread', { ...thread, revision: 4, latestTurnId: 'next', completion: 'failed', items: [{ id: 'new', turnId: 'next', type: 'agentMessage', text: '未完成' }] });
  assert.equal($('currentThreadStatus').textContent, '需检查'); events.emit('error'); assert.equal($('currentThreadStatus').textContent, '待核实');
  document.querySelector('[data-tab=files]').click(); input('managePath', 'nested/example.py');
  assert.equal($('manageCreateParent').textContent, '新建位置：nested');
});

test('desktop sidebar resizing persists width, cancels cleanly and preserves active editing', async t => {
  const { $, window, document, input, open, requests } = await page(t);
  window.innerWidth = 1440; window.dispatchEvent(new window.Event('resize'));
  await open('a.py'); input('fileEditorText', 'unsaved sidebar resize'); input('prompt', 'keep this message');
  const editor = $('fileEditorText'), tree = $('projectFileTree'), handle = $('sidebarResizeHandle');
  let captured = null;
  handle.setPointerCapture = id => { captured = id; }; handle.hasPointerCapture = id => captured === id; handle.releasePointerCapture = () => { captured = null; };
  const dispatch = (target, type, extra = {}) => { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, extra); target.dispatchEvent(event); };
  const pointer = (type, clientX) => dispatch(handle, type, { pointerId: 1, button: 0, clientX });
  const width = () => Number(handle.getAttribute('aria-valuenow'));
  const initial = width(), requestCount = requests.length;
  pointer('pointerdown', initial); pointer('pointermove', initial + 160);
  assert.equal(width(), initial + 160); assert.equal(captured, 1);
  pointer('pointerup', initial + 160); assert.equal(captured, null);
  const stored = window.localStorage.getItem('lemon:sidebarWidth'); assert.equal(Number(stored), initial + 160);
  pointer('pointerdown', width()); pointer('pointermove', 800);
  dispatch(document, 'keydown', { key: 'Escape' }); assert.equal(width(), Number(stored)); assert.equal(captured, null);
  assert.equal(window.localStorage.getItem('lemon:sidebarWidth'), stored);
  pointer('pointerdown', width()); pointer('pointermove', 1); dispatch(handle, 'pointercancel'); assert.equal(width(), Number(stored));
  dispatch(handle, 'keydown', { key: 'End' }); assert.equal(width(), 640);
  window.innerWidth = 1000; window.dispatchEvent(new window.Event('resize')); assert.equal(width(), 480, 'editor retains at least 520 px');
  window.innerWidth = 1440; window.dispatchEvent(new window.Event('resize')); assert.equal(width(), 640, 'temporary viewport restriction does not overwrite preferred width');
  $('closeSidebar').click(); assert.equal($('appShell').classList.contains('sidebar-collapsed'), true); $('menuButton').click(); assert.equal(width(), 640);
  dispatch(handle, 'dblclick'); assert.equal(width(), initial); assert.equal(window.localStorage.getItem('lemon:sidebarWidth'), null);
  assert.equal($('fileEditorText'), editor); assert.equal($('projectFileTree'), tree);
  assert.equal(editor.value, 'unsaved sidebar resize'); assert.equal($('prompt').value, 'keep this message'); assert.equal(requests.length, requestCount);
});

test('bottom modules keep separate themes and detached result controls follow results without changing task state', async t => {
  const { $, document, window, input, requests, open } = await page(t, {
    'lemon:moduleThemes': JSON.stringify({ editor: 'light', chat: 'dark', terminal: 'dark', results: 'light', tools: 'light' }),
  });
  await open('a.py'); input('fileEditorText', 'unsaved'); input('prompt', 'keep my task');
  $('bottomTabResults').click();
  const toggle = $('bottomPanel').querySelector('.bottom-panel-header > .module-theme-toggle');
  assert.equal($('bottomPanel').dataset.theme, 'light'); assert.equal(toggle.dataset.moduleThemeToggle, 'results');
  const actionsBefore = requests.filter(r => /\/start|\/save|\/send|\/sql\/query/.test(r.route)).length;
  toggle.click(); assert.equal($('sqlResults').dataset.theme, 'dark'); assert.equal($('sqlColumnMenu').dataset.theme, 'dark');
  $('bottomTabTerminal').click(); assert.equal(toggle.dataset.moduleThemeToggle, 'terminal'); toggle.click();
  assert.equal($('bottomTerminal').dataset.theme, 'light'); assert.equal($('sqlResults').dataset.theme, 'dark');
  $('bottomTabResults').click(); assert.equal($('bottomPanel').dataset.theme, 'dark');
  $('sqlLayoutToggle').click();
  assert.equal($('sqlResults').parentElement, document.body); assert.equal($('sqlResultHandle').parentElement, $('sqlResults'));
  $('sqlResultHandle').querySelector('[data-module-theme-toggle=results]').click();
  assert.equal($('sqlResults').dataset.theme, 'light'); assert.equal($('sqlColumnMenu').dataset.theme, 'light');
  $('sqlLayoutToggle').click(); assert.equal($('sqlResultHandle').dataset.theme, 'light');
  assert.equal($('fileEditorText').value, 'unsaved'); assert.equal($('prompt').value, 'keep my task');
  assert.equal(requests.filter(r => /\/start|\/save|\/send|\/sql\/query/.test(r.route)).length, actionsBefore);
  assert.equal(JSON.parse(window.localStorage.getItem('lemon:moduleThemes')).terminal, 'light');
});

test('right-side conversation navigation preserves reading, drafts and running work independently of files', async t => {
  const { $, document, window, settle, input, open, events, thread, requests } = await page(t);
  await open('a.py');
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  const items = [{ id: 'answer', type: 'agentMessage', text: '这里保留已经显示的回复。', turnId: 'turn1' }];
  events.emit('thread', { ...thread, revision: 2, items });
  input('prompt', '保留这条未发送的消息'); input('fileEditorText', 'x=123\n');
  const editor = $('fileEditorText'), composer = $('composer'), message = document.querySelector('.message.assistant');
  $('scrollArea').scrollTop = 73;
  assert.equal($('sidebar').contains($('newThread')), false);
  assert.equal($('sidebar').contains($('threadList')), false);
  assert.equal($('mainPanel').contains($('newThread')), true);
  assert.equal($('mainPanel').contains($('threadList')), true);
  $('chatHistoryButton').click();
  assert.equal($('mainPanel').dataset.chatView, 'history'); assert.equal($('historyPanel').hidden, false);
  assert.equal($('filesPanel').hidden, false); assert.equal($('workSurface').dataset.mode, 'both');
  events.emit('thread', { ...thread, revision: 3, items, busy: true, turnId: 'turn2' });
  assert.equal($('mainPanel').dataset.chatView, 'history');
  assert.equal(document.activeElement.dataset.threadId, 't1', 'streaming updates keep keyboard focus in the list');
  assert.equal(document.querySelector('.message.assistant'), message);
  const reads = requests.filter(r => r.route === '/api/threads/t1').length;
  $('threadList').querySelector('[data-thread-id=t1]').click();
  assert.equal($('mainPanel').dataset.chatView, 'conversation');
  assert.equal($('scrollArea').scrollTop, 73); assert.equal($('composer'), composer);
  assert.equal($('prompt').value, '保留这条未发送的消息'); assert.equal($('fileEditorText'), editor);
  assert.equal(editor.value, 'x=123\n'); assert.equal($('stopButton').hidden, false);
  assert.equal(requests.filter(r => r.route === '/api/threads/t1').length, reads);
  $('chatSearchButton').click(); assert.equal(document.activeElement, $('search'));
  $('search').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($('mainPanel').dataset.chatView, 'conversation'); assert.equal(document.activeElement, $('chatHistoryButton'));
  $('chatHistoryButton').click(); $('newThread').click();
  assert.equal($('mainPanel').dataset.chatView, 'conversation'); assert.equal($('threadTitle').textContent, '新对话');
  assert.equal($('prompt').value, '');
  $('chatHistoryButton').click(); $('threadList').querySelector('[data-thread-id=t1]').click();
  await settle(() => $('prompt').value === '保留这条未发送的消息');
  assert.equal(editor.value, 'x=123\n');
  assert.equal(requests.some(r => /\/send|\/turn|\/stop|\/interrupt|\/sql\/query|\/terminal\/start/.test(r.route)), false);
});

test('AI angle-delimited file citations open project files at the cited line without losing edits or executing SQL', async t => {
  const { $, document, settle, events, thread, files, requests, input } = await page(t);
  const path = 'QSC数仓作业/保险 报表/订单(v2).sql';
  files[path] = Array.from({length: 230}, (_, i) => `-- fictional line ${i + 1}`).join('\n');
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  events.emit('thread', { ...thread, revision: 2, items: [{ id: 'citations', type: 'agentMessage', text: `源码位置：[订单.sql:204](</project/${path}:204>)、[订单.sql:214](</project/${path}:214>)。` }] });
  const links = [...document.querySelectorAll('#messages [data-file-link]')]; assert.equal(links.length, 2);
  assert.equal(requests.filter(r => r.route.startsWith('/api/project/file?')).length, 0, 'rendering links does not read files');
  input('prompt', '保留对话草稿'); links[0].click();
  await settle(() => $('editorFilename').textContent === '订单(v2).sql' && !$('fileEditorText').readOnly);
  const position = line => files[path].split('\n').slice(0, line - 1).reduce((n, text) => n + text.length + 1, 0);
  await settle(() => $('fileEditorText').selectionStart === position(204));
  await settle(() => document.querySelector('.file-main[aria-current=true]')?.dataset.filePath === path);
  assert.equal(document.activeElement, $('fileEditorText'), 'directory reveal must not steal the editor cursor');
  const editor = $('fileEditorText'); input('fileEditorText', editor.value + '\n-- unsaved');
  links[1].click(); await settle(() => editor.selectionStart === position(214));
  assert.equal($('fileEditorText'), editor); assert.ok(editor.value.endsWith('-- unsaved'));
  assert.equal($('editorTabs').querySelectorAll('[role=tab]').length, 1);
  assert.equal($('prompt').value, '保留对话草稿');
  assert.equal(requests.some(r => /\/save|\/sql\/query|\/send|\/terminal\/start/.test(r.route)), false);
});

test('conversation tables have a working copy action in historical and updated replies', async t => {
  const { document, window, settle, events, thread } = await page(t), copied = [];
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async text => copied.push(text) } });
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => document.getElementById('threadTitle').textContent === 'Task');
  const message = '| 状态 | 数量 |\n| --- | --- |\n| 待确认 | 53 |';
  events.emit('thread', { ...thread, revision: 2, items: [{ id: 'table-answer', type: 'agentMessage', text: message }] });
  const button = document.querySelector('.message.agent [data-copy-markdown-table]'); assert.ok(button); button.click();
  await settle(() => copied.length === 1); assert.equal(copied[0], '状态\t数量\n待确认\t53');
  events.emit('thread', { ...thread, revision: 3, items: [{ id: 'table-answer', type: 'agentMessage', text: message + '\n| 已取消 | 2 |' }] });
  document.querySelector('.message.agent [data-copy-markdown-table]').click(); await settle(() => copied.length === 2); assert.match(copied[1], /已取消\t2$/);
});

test('file tab menu copies the chosen tab paths and reveals it without changing editor drafts', async t => {
  const { $, document, window, open, input, settle, requests } = await page(t);
  const copied = []; Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async text => copied.push(text) } });
  await open('a.py'); input('fileEditorText', 'x=123\n'); await open('b.py');
  const a = [...$('editorTabs').querySelectorAll('[role=tab]')].find(button => button.getAttribute('aria-label').startsWith('a.py'));
  a.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 70, cancelable: true }));
  assert.equal($('editorTabMenu').hidden,false); assert.equal($('editorFilename').textContent,'b.py');
  for (const action of ['name','relative','absolute']) { $('editorTabMenu').querySelector(`[data-tab-action=${action}]`).click(); await new Promise(setImmediate); }
  assert.deepEqual(copied,['a.py','a.py','/project/a.py']);
  $('editorTabMenu').querySelector('[data-tab-action=reveal]').click();
  await settle(()=>document.querySelector('.file-main[aria-current=true]')?.dataset.filePath==='a.py');
  assert.equal($('editorFilename').textContent,'a.py'); assert.equal($('fileEditorText').value,'x=123\n'); assert.equal($('editorTabMenu').hidden,true);
  a.dispatchEvent(new window.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));
  assert.equal($('editorTabMenu').hidden,false);
  window.navigator.clipboard.writeText=async()=>{throw new Error('blocked');};
  $('editorTabMenu').querySelector('[data-tab-action=absolute]').click();
  await settle(()=>$('editorTabMenuStatus').textContent.includes('已选中文本'));
  assert.equal($('editorTabMenuPath').value,'/project/a.py'); assert.equal($('editorTabMenuPath').selectionEnd,'/project/a.py'.length);
  $('editorTabMenuPath').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); assert.equal($('editorTabMenu').hidden,true);
  assert.equal(requests.some(r=>/\/save|\/sql\/query|\/send|\/terminal\/start/.test(r.route)),false);
});
