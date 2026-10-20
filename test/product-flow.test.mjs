import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { taskResult, projectPath } from '../public/task-results.js';
import { Workspace } from '../lib/workspace.mjs';
test('schedule settings preserve their form and chat drafts across closing, refresh and navigation', async t => {
  const { $, document, window, input, settle } = await page(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (route, options = {}) => route === '/api/schedules' ? { ok: true, json: async () => ({ jobs: [], connected: true }) } : originalFetch(route, options);
  $('settingsButton').click(); document.querySelector('[data-tab=schedules]').click(); await settle(() => /还没有/.test($('scheduleResults').textContent));
  $('scheduleNew').click(); input('scheduleName', '保留这份任务草稿'); input('scheduleText', '只读检查文件');
  const event = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  input('prompt', '原来的聊天草稿'); $('scheduleRefresh').click(); await new Promise(setImmediate);
  $('closeWorkbench').click(); assert.equal($('workbenchDialog').hidden, true);
  $('settingsButton').click(); document.querySelector('[data-tab=schedules]').click(); await new Promise(setImmediate);
  assert.equal($('scheduleName').value, '保留这份任务草稿'); assert.equal($('scheduleText').value, '只读检查文件'); assert.equal($('prompt').value, '原来的聊天草稿');
  assert.equal($('scheduleForm').hidden, false); assert.equal($('workbenchDialog').classList.contains('schedules-view'), true);
  $('closeWorkbench').click();
});
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
  assert.equal(document.querySelector('.execution-group'),group);assert.equal(group.open,true);assert.equal(group.querySelectorAll('.tool').length,2);
  assert.equal(document.querySelectorAll('.execution-group').length,2);assert.equal(document.querySelectorAll('.execution-group')[1].querySelectorAll('.tool').length,1);
  input('prompt','');[...document.querySelectorAll('.user-message-actions button')].find(button=>button.textContent==='编辑后重发').click();
  assert.equal($('prompt').value,'帮我检查代码');assert.equal(requests.filter(r=>r.route.includes('/turn')).length,0);
});

test('execution stays between the corresponding messages instead of merging the whole turn', async t => {
  const { document, $, settle, events, thread } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  const message = (id, type = 'agentMessage') => ({ id, type, text: id, turnId: 'turn1' });
  const command = (id, exitCode = 0) => ({ id, type: 'commandExecution', title: id, text: `${id} output`, status: exitCode ? 'failed' : 'completed', exitCode, turnId: 'turn1' });
  const items = [message('user', 'userMessage'), message('read'), command('c1'), command('c2', 1), message('check'), command('c3'), message('verify'), command('c4'), message('final')];
  events.emit('thread', { ...thread, revision: 2, items, latestTurnId: 'turn1', completion: 'completed' });
  const groups = [...document.querySelectorAll('.execution-group')];
  assert.equal(groups.length, 3);
  const itemId = node => { const value = JSON.parse(node.dataset.signature); return (Array.isArray(value) ? value[0] : value).id; };
  const order = () => [...$('messages').children].map(node => node.classList.contains('execution-group') ? [...node.querySelectorAll('.tool')].map(itemId).join(',') : itemId(node));
  assert.deepEqual(order(), ['user', 'read', 'c1,c2', 'check', 'c3', 'verify', 'c4', 'final']);
  assert.match(groups[0].firstElementChild.textContent, /1 项需查看/);
  assert.equal(groups[1].textContent.includes('项需查看'), false);
  groups[1].open = true;
  // A fuller snapshot may insert a previously unavailable item in an older segment.
  events.emit('thread', { ...thread, revision: 3, items: [...items.slice(0, 5), command('late'), ...items.slice(5)], latestTurnId: 'turn1', completion: 'completed' });
  assert.deepEqual(order(), ['user', 'read', 'c1,c2', 'check', 'late,c3', 'verify', 'c4', 'final']);
  assert.equal(document.querySelectorAll('.execution-group')[1], groups[1]); assert.equal(groups[1].open, true);
  // Removed segments must not leave a stale group or orphan its adjacent replies.
  events.emit('thread', { ...thread, revision: 4, items: items.filter(item => item.id !== 'c3'), latestTurnId: 'turn1', completion: 'completed' });
  assert.deepEqual(order(), ['user', 'read', 'c1,c2', 'check', 'verify', 'c4', 'final']);
});

test('new commands appear after the latest reply while approval and earlier selections stay intact', async t => {
  const { document, $, settle, events, thread, input, requests } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  input('prompt', '不要丢失的草稿');
  const old = { id: 'old', type: 'commandExecution', title: 'first command', text: 'previous output', status: 'completed', turnId: 'live' };
  const items = [{ id: 'user', type: 'userMessage', text: '检查', turnId: 'live' }, { id: 'explain1', type: 'agentMessage', text: '先检查文件', turnId: 'live' }, old];
  const update = (revision, pending = []) => events.emit('thread', { ...thread, revision, busy: true, turnId: 'live', latestTurnId: 'live', items: [...items], requests: pending });
  update(2);
  const previous = document.querySelector('.execution-group'), details = previous.querySelector('details');
  previous.open = true; details.open = true;
  const output = previous.querySelector('.activity-output'), range = document.createRange(); range.selectNodeContents(output.firstChild); document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
  assert.equal(document.getSelection().toString(), 'previous output');
  items.push({ id: 'explain2', type: 'agentMessage', text: '现在执行最新命令', turnId: 'live' }, { id: 'new', type: 'commandExecution', title: 'new command', text: '', status: 'inProgress', turnId: 'live' });
  const pending = [{ key: 'test-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 't1', itemId: 'new', command: 'new command', reason: '模拟审批' } }];
  update(3, pending);
  const current = document.querySelectorAll('.execution-group')[1], approval = document.querySelector('[data-request-key="test-approval"]');
  assert.equal($('messages').lastElementChild, current); assert.match(current.previousElementSibling.textContent, /现在执行最新命令/);
  assert.equal(current.open, true); assert.match(current.firstElementChild.textContent, /等待你处理/); assert.match(previous.firstElementChild.textContent, /已结束/);
  assert.equal(previous.querySelector('.activity-output'), output); assert.equal(document.getSelection().toString(), 'previous output');
  assert.ok(approval); current.open = false;
  items[items.length - 1] = { ...items.at(-1), text: 'fresh output' };
  update(4, pending);
  assert.equal(document.querySelectorAll('.execution-group')[1], current); assert.equal(current.open, false); assert.equal(details.open, true);
  assert.equal(document.querySelector('[data-request-key="test-approval"]'), approval);
  assert.equal($('prompt').value, '不要丢失的草稿');
  assert.equal(document.getSelection().toString(), 'previous output');
  assert.equal(requests.some(request => request.route.includes('/approve') || request.route === '/api/send'), false);
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

test('HTML runtime failures show a readable status while preserving drafts and original task state', async t => {
  const { $, document, settle, requests, events, thread, input, open } = await page(t);
  const error = 'unexpected status 403 Forbidden: <html><head><style>body{font-family:Arial}</style></head><body>private error page</body></html>';
  thread.error = error; thread.completion = 'failed';
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('noticeText').textContent.includes('HTTP 403'));
  assert.doesNotMatch($('noticeText').textContent, /<html|Arial|private error page/);
  await open('a.py'); input('fileEditorText', 'unsaved = 2\n'); input('prompt', '保留未发送内容');
  const editor = $('fileEditorText');
  events.emit('thread', { ...thread, revision: 2, error: 'unexpected status 502 Bad Gateway: <html><body>internal proxy page</body></html>' });
  assert.match($('noticeText').textContent, /HTTP 502/); assert.doesNotMatch($('noticeText').textContent, /internal proxy page/);
  assert.equal(thread.error, error); assert.equal(thread.completion, 'failed');
  assert.equal($('fileEditorText'), editor); assert.equal(editor.value, 'unsaved = 2\n'); assert.equal($('prompt').value, '保留未发送内容');
  assert.equal(requests.some(request => /\/send|\/followup|\/save|\/sql\/query|\/terminal\/start/.test(request.route)), false);
});

test('model catalog automatically adds new models while keeping selection, effort, editor and message drafts', async t => {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now; t.after(() => { Date.now = originalNow; });
  const { $, window, settle, input, open, requests } = await page(t);
  const originalFetch = globalThis.fetch; let calls = 0, failure = false;
  const first = { id: 'model-a', name: 'Model A', efforts: [{ reasoningEffort: 'high' }] };
  let models = [first];
  globalThis.fetch = async (route, options) => {
    if (route !== '/api/models') return originalFetch(route, options);
    calls++; if (failure) throw new Error('catalog offline');
    return { ok: true, json: async () => ({ models }) };
  };
  await open('a.py'); input('fileEditorText', 'keep = 2\n'); input('prompt', '保留对话草稿');
  const editor = $('fileEditorText'), picker = $('model');
  const refresh = () => { now += 60_001; picker.dispatchEvent(new window.Event('pointerdown')); };
  refresh(); await settle(() => picker.options.length === 2);
  picker.value = first.id; picker.dispatchEvent(new window.Event('change')); $('effort').value = 'high';
  models = [first, { id: 'model-b', name: 'New Model B', efforts: [{ reasoningEffort: 'low' }] }];
  refresh(); await settle(() => picker.options.length === 3);
  assert.equal($('model'), picker); assert.equal(picker.value, first.id); assert.equal($('effort').value, 'high');
  assert.equal($('fileEditorText'), editor); assert.equal(editor.value, 'keep = 2\n'); assert.equal($('prompt').value, '保留对话草稿');
  picker.dispatchEvent(new window.Event('focus')); await Promise.resolve(); assert.equal(calls, 2);
  failure = true; refresh(); await settle(() => picker.title.includes('刷新失败'));
  assert.equal(picker.options.length, 3); assert.equal(picker.value, first.id); assert.equal($('effort').value, 'high');
  assert.equal(requests.some(request => request.body), false);
});

test('model retries use running status and recovered thread errors disappear without losing other notices or drafts', async t => {
  const { $, document, settle, requests, events, thread, input, open } = await page(t);
  thread.busy = true; thread.turnId = 'turn'; thread.error = 'Reconnecting... 5/5';
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  assert.match($('runStatusText').textContent, /模型连接正在重试（5\/5）/); assert.equal($('notice').hidden, true);
  await open('a.py'); input('fileEditorText', 'unsaved = 2\n'); input('prompt', '保留这条草稿');
  const editor = $('fileEditorText'); let revision = 1;
  const update = change => events.emit('thread', { ...thread, revision: ++revision, ...change });
  update({ error: null, modelRetry: { turnId: 'turn', message: 'Reconnecting... 2/5' } });
  assert.match($('runStatusText').textContent, /2\/5/); assert.equal($('notice').hidden, true);
  update({ error: null, modelRetry: null }); assert.match($('runStatusText').textContent, /正在处理/);
  update({ error: '最终连接错误', modelRetry: null }); assert.equal($('noticeText').textContent, '最终连接错误');
  update({ busy: false, turnId: null, error: null, modelRetry: null, completion: 'completed' }); assert.equal($('notice').hidden, true);
  update({ error: '一次失败', modelRetry: null });
  // Another operation replaces the thread notice; later recovery must leave it alone.
  const failed = { id: 'photo', type: 'userMessage', text: '附带图片', attachments: [{ kind: 'image', name: '图片.png', unavailable: true }] };
  update({ error: '一次失败', modelRetry: null, items: [failed] });
  [...document.querySelectorAll('.user-message-actions button')].find(button => button.textContent === '编辑后重发').click();
  assert.match($('noticeText').textContent, /附件请重新选择/);
  input('prompt', '保留这条草稿');
  update({ busy: false, turnId: null, error: null, modelRetry: null, items: [failed], completion: 'completed' });
  assert.match($('noticeText').textContent, /附件请重新选择/); assert.equal($('notice').hidden, false);
  assert.equal($('fileEditorText'), editor); assert.equal(editor.value, 'unsaved = 2\n'); assert.equal($('prompt').value, '保留这条草稿');
  assert.equal(requests.some(request => request.body), false);
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

async function page(t, stored = {}, terminalProcesses = [], features = false, appApprovalPersistence = true) {
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
      case '/api/bootstrap': data = { connected: true, csrf: 'test', cwd: '/project', models: [], workbenchFeatures: features, mcpAppApprovalPersistence: appApprovalPersistence, computerUseAppApprovals: true, questionInputs: true, memorySettings: true, auth: { loggedIn: true }, permissions: { options: [{ id: 'workspace-write', enabled: true }] } }; break;
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

test('automatic editor context sends the current unsaved selection, can be disabled and retains failed replacement drafts', async t => {
  const { $, window, settle, input, open, events, thread } = await page(t);
  const originalFetch = globalThis.fetch, sends = []; let fail = false;
  globalThis.fetch = async (route, options) => {
    if (route === '/api/send' || route === '/api/followup') {
      sends.push({ route, body: JSON.parse(options.body) });
      return fail ? { ok: false, status: 409, json: async () => ({ error: '停止结果尚未确认' }) } : { ok: true, json: async () => ({ threadId: 't1' }) };
    }
    return originalFetch(route, options);
  };
  await open('a.py'); input('fileEditorText', 'prefix\nunsaved selection\nsuffix'); $('fileEditorText').setSelectionRange(7, 24);
  input('prompt', '解释这里'); $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => sends.length === 1 && !$('prompt').value);
  assert.equal(sends[0].body.text, '解释这里'); assert.match(sends[0].body.editorContext.text, /unsaved selection/); assert.match(sends[0].body.editorContext.label, /未保存/);
  $('editorContextToggle').click(); input('prompt', '不需要文件'); $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => sends.length === 2 && !$('prompt').value); assert.equal(sends[1].body.editorContext, null);
  events.emit('thread', { ...thread, revision: 5, busy: true, turnId: 'active' }); fail = true;
  $('followupBehavior').value = 'interrupt'; input('prompt', '停止后做这个'); $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => $('noticeText').textContent.includes('停止结果尚未确认'));
  assert.equal(sends[2].body.behavior, 'interrupt'); assert.equal($('prompt').value, '停止后做这个'); assert.equal($('fileEditorText').value, 'prefix\nunsaved selection\nsuffix');
});

test('TODO action preserves the existing prompt and only prepares a draft; stale TODO entries cannot change another file', async t => {
  const { $, document, input, open, requests, files } = await page(t);
  files['a.py'] = '# TODO validate an empty name\nname = ""\n'; await open('a.py'); input('prompt', '已有要求');
  $('editorTodo').click(); assert.equal($('editorTodos').hidden, false);
  $('editorTodos').querySelector('button').click();
  assert.match($('prompt').value, /^已有要求/); assert.match($('prompt').value, /TODO validate an empty name/);
  assert.equal(requests.some(item => ['/api/send', '/api/followup', '/api/project/save'].includes(item.route)), false);
  $('editorTodo').click(); const stale = $('editorTodos').querySelector('button'), before = $('prompt').value;
  await open('b.py'); stale.click(); assert.equal($('prompt').value, before); assert.match($('editorToolStatus').textContent, /变化/);
  assert.equal(document.querySelectorAll('.editor-todos button').length, 1);
});

test('separate review controls send the chosen scope and navigate to the returned review thread', async t => {
  const { $, document, window, settle, input, requests, thread } = await page(t, { 'codex-desk:active': 't1' }, [], true);
  const originalFetch = globalThis.fetch; let review;
  globalThis.fetch = async (route, options) => {
    if (route === '/api/review') { review = JSON.parse(options.body); return { ok: true, json: async () => ({ threadId: 'review1' }) }; }
    if (route === '/api/threads/review1') return { ok: true, json: async () => ({ ...thread, id: 'review1', title: '独立审查', parentThreadId: 't1', mode: 'read-only' }) };
    return originalFetch(route, options);
  };
  await settle(() => $('threadTitle').textContent === 'Task' && !$('parentThreadBack').disabled); input('prompt', '原对话草稿');
  $('workbenchButton').click(); document.querySelector('[data-tab="git"]').click(); $('review-tab-review').click();
  $('reviewTarget').value = 'baseBranch'; $('reviewValue').value = 'main'; $('reviewDelivery').value = 'detached'; $('reviewStart').click();
  await settle(() => $('threadTitle').textContent === '独立审查');
  assert.deepEqual(review, { threadId: 't1', delivery: 'detached', target: { type: 'baseBranch', branch: 'main' } });
  $('parentThreadBack').click(); await settle(() => $('threadTitle').textContent === 'Task' && !$('parentThreadBack').disabled); assert.equal($('prompt').value, '原对话草稿');
  assert.equal(requests.some(item => item.route === '/api/send'), false);
});

test('long text composer sends file references, retains failed drafts and supports attachment-only followups', async t => {
  const { $, document, window, settle, input, events, thread } = await page(t);
  const originalFetch = globalThis.fetch, saved = { File: globalThis.File, FileReader: globalThis.FileReader };
  Object.assign(globalThis, { File: window.File, FileReader: window.FileReader });
  t.after(() => Object.assign(globalThis, saved));
  const sends = [], uploads = []; let failSend = true;
  globalThis.fetch = async (route, options = {}) => {
    if (route === '/api/attachments/upload') {
      uploads.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: 'long-file', name: uploads.at(-1).name, kind: 'file' }) };
    }
    if (route === '/api/send' || route === '/api/followup') {
      sends.push({ route, body: JSON.parse(options.body) });
      return failSend ? { ok: false, status: 503, json: async () => ({ error: '发送暂时失败' }) } : { ok: true, json: async () => ({ threadId: 't1' }) };
    }
    return originalFetch(route, options);
  };
  const text = '测试长文本尾部可读\n'.repeat(12000);
  const paste = () => { const event = new window.Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: () => text } }); $('prompt').dispatchEvent(event); };
  input('prompt', '核对附件完整内容'); paste();
  assert.equal($('sendButton').disabled, true);
  await settle(() => !$('sendButton').disabled);
  assert.equal(Buffer.from(uploads[0].base64, 'base64').toString('utf8'), text);
  $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => $('noticeText').textContent.includes('发送暂时失败'));
  assert.equal($('prompt').value, '核对附件完整内容'); assert.equal(document.querySelectorAll('.pasted-text-chip').length, 1);
  assert.deepEqual(sends[0].body.attachments, ['long-file']); assert.equal(sends[0].body.text, '核对附件完整内容');
  assert.ok(JSON.stringify(sends[0]).length < 1500); assert.equal(sends.length, 1);
  failSend = false; $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => $('threadTitle').textContent === 'Task' && !document.querySelector('.pasted-text-chip'));
  events.emit('thread', { ...thread, revision: 2, busy: true, turnId: 'running' });
  input('prompt', ''); paste(); await settle(() => !$('sendButton').disabled);
  $('composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => sends.length === 3 && !document.querySelector('.pasted-text-chip'));
  assert.equal(sends[2].route, '/api/followup'); assert.match(sends[2].body.text, /读取附加的完整长文本/);
  assert.deepEqual(sends[2].body.attachments, ['long-file']); assert.equal(uploads.length, 2);
});

test('Git pull entry uses current editor drafts to block updates and preserves the conversation', async t => {
  const { $, document, window, settle, input, open } = await page(t);
  const original = globalThis.fetch, writes = [];
  globalThis.fetch = async (route, options = {}) => {
    if (route.startsWith('/api/git/submit')) {
      if (options.body) writes.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ cwd: '/project', head: 'abc12345', branch: 'main', tracking: 'origin/main', version: 'v1', files: [], pullAvailable: true, pullBlocked: '', fetchUrl: '/fictional/remote.git' }) };
    }
    return original(route, options);
  };
  await open('a.py'); input('fileEditorText', 'keep this editor draft'); input('prompt', 'keep this conversation draft');
  const editor = $('fileEditorText');
  const button = [...document.querySelectorAll('.project-git-entry')].find(item => item.textContent.includes('拉取'));
  button.click(); await settle(() => document.querySelector('[data-ui=status]').textContent.includes('未保存草稿'));
  assert.equal(document.querySelector('[data-ui=pull]').disabled, true); assert.equal(writes.length, 0);
  assert.equal($('fileEditorText'), editor); assert.equal(editor.value, 'keep this editor draft'); assert.equal($('prompt').value, 'keep this conversation draft');
});

test('app authorization settings list native grants, confirm one revoke and preserve unrelated drafts', async t => {
  const { $, document, settle, input, open } = await page(t), originalFetch = globalThis.fetch;
  const record = { available: true, initialized: true, revision: 'a'.repeat(64), apps: [{ appId: 'com.example.Test', name: 'Test <img src=x>', scope: 'always' }, { appId: 'com.example.Keep', name: 'Keep', scope: 'always' }] };
  const calls = []; let release;
  globalThis.fetch = async (route, options = {}) => {
    if (route === '/api/computer-use/approvals') { calls.push({ route }); return { ok: true, json: async () => structuredClone(record) }; }
    if (route === '/api/computer-use/approvals/revoke') { calls.push({ route, body: JSON.parse(options.body) }); return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ...record, revision: 'b'.repeat(64), apps: [record.apps[1]], revokedAppId: 'com.example.Test' }) }); }); }
    return originalFetch(route, options);
  };
  await open('a.py'); input('fileEditorText', 'x=9 # preserved'); input('prompt', '保持聊天草稿');
  $('settingsButton').click(); $('workbench-tab-appApprovals').click(); await settle(() => $('appApprovalsList').children.length === 2);
  assert.equal(calls.length, 1); assert.equal($('appApprovalsList').querySelector('img'), null);
  let confirmed = false; globalThis.confirm = message => { assert.match(message, /com.example.Test/); return confirmed; };
  const revoke = $('appApprovalsList').querySelector('button'); revoke.click(); assert.equal(calls.length, 1);
  confirmed = true; revoke.click(); revoke.click(); await settle(() => !!release);
  assert.equal(calls.filter(call => call.body).length, 1); assert.deepEqual(calls.at(-1).body, { appId: 'com.example.Test', revision: 'a'.repeat(64), confirmed: true });
  assert.equal($('appApprovalsRefresh').disabled, true); release(); await settle(() => $('appApprovalsList').children.length === 1);
  assert.match($('appApprovalsList').textContent, /Keep/); assert.match($('appApprovalsHint').textContent, /已撤销/);
  assert.equal($('fileEditorText').value, 'x=9 # preserved'); assert.equal($('prompt').value, '保持聊天草稿');
});

test('extended plugin cards use metadata fields and preserve choices and drafts until explicit validated submission', async t => {
  const { $, document, window, settle, events, thread, requests } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  const schema = { type: 'object', required: ['choice'], properties: { choice: { type: 'array', minItems: 1, items: { anyOf: [{ const: 'one', title: '第一项', description: '模拟选择' }, { const: 'two', title: '第二项' }] } }, note: { type: 'string', default: '初始草稿' } } };
  const request = { key: 'extended', method: 'mcpServer/elicitation/request', params: { threadId: 't1', serverName: 'demo', mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { 'openai/elicitation': { requestedSchema: schema } } } };
  events.emit('thread', { ...thread, revision: 2, requests: [request] });
  const card = document.querySelector('[data-request-key=extended]'), note = card.querySelector('textarea'), choice = card.querySelector('input[value=two]');
  assert.equal(note.value, '初始草稿'); assert.match(card.textContent, /第一项|模拟选择/);
  assert.equal(requests.filter(request => request.route === '/api/respond').length, 0);
  const submit = () => card.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  submit(); assert.match(card.querySelector('.field-error').textContent, /多选/); assert.equal(requests.filter(request => request.route === '/api/respond').length, 0);
  choice.click(); note.value = '正在编辑的草稿'; note.focus();
  events.emit('thread', { ...thread, revision: 3, requests: [request], busy: true });
  assert.equal(card.querySelector('textarea'), note); assert.equal(note.value, '正在编辑的草稿'); assert.equal(document.activeElement, note); assert.equal(choice.checked, true);
  submit(); submit(); await settle(() => !document.querySelector('[data-request-key=extended]'));
  assert.deepEqual(requests.filter(request => request.route === '/api/respond').map(request => request.body), [{ key: 'extended', decision: 'accept', content: { choice: ['two'], note: '正在编辑的草稿' } }]);
});

test('Computer Use app cards preserve risk, explicit scope, duplicate protection and ordinary form drafts', async t => {
  const { $, document, window, settle, events, thread, requests } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  const app = (key, persist = ['session', 'always']) => ({ key, method: 'mcpServer/elicitation/request', params: { threadId: 't1', mode: 'form', serverName: 'cua_repl', message: 'Allow Computer Use?', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', tool_params: { app: 'com.example.Browser' }, tool_params_display: [{ name: 'app', value: 'Test Browser <img src=x>' }], riskLevel: 'high', subtitle: 'Test warning', persist } } });
  const form = { key: 'ordinary', method: 'mcpServer/elicitation/request', params: { mode: 'form', serverName: 'demo', requestedSchema: { type: 'object', properties: { note: { type: 'string' } } } } };
  const offered = [app('session'), app('always'), app('restricted', ['session']), app('once', []), app('deny'), form];
  events.emit('thread', { ...thread, revision: 2, requests: offered });
  const card = key => document.querySelector(`[data-request-key="${key}"]`), buttons = key => [...card(key).querySelectorAll('button')].map(button => button.textContent);
  assert.deepEqual(buttons('session'), ['拒绝', '始终允许', '允许此会话']);
  assert.deepEqual(buttons('restricted'), ['拒绝', '允许此会话']); assert.deepEqual(buttons('once'), ['拒绝', '允许一次']);
  assert.equal(card('session').querySelector('img'), null); assert.match(card('session').textContent, /Test Browser <img src=x>/);
  assert.match(card('session').textContent, /较高风险 · Test warning/); assert.equal($('approvalToolbar').hidden, true);
  const note = card('ordinary').querySelector('input'); note.value = 'keep form draft';
  assert.equal(requests.filter(r => r.route === '/api/respond').length, 0);
  const first = card('session'); first.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); first.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle(() => !card('session'));
  assert.deepEqual(requests.filter(r => r.route === '/api/respond').map(r => r.body), [{ key: 'session', decision: 'accept', content: {}, persist: 'session' }]);
  events.emit('thread', { ...thread, revision: 3, requests: offered });
  assert.equal(card('session'), null, 'stale stream update cannot resubmit a resolved request');
  assert.equal(card('ordinary').querySelector('input'), note); assert.equal(note.value, 'keep form draft');
  [...card('always').querySelectorAll('button')].find(button => button.textContent === '始终允许').click(); await settle(() => !card('always'));
  assert.deepEqual(requests.filter(r => r.route === '/api/respond').at(-1).body, { key: 'always', decision: 'accept', content: {}, persist: 'always' });
  card('deny').querySelector('button').click(); await settle(() => !card('deny'));
  assert.deepEqual(requests.filter(r => r.route === '/api/respond').at(-1).body, { key: 'deny', decision: 'decline' });
  card('ordinary').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(() => !card('ordinary'));
  assert.deepEqual(requests.filter(r => r.route === '/api/respond').at(-1).body, { key: 'ordinary', decision: 'accept', content: { note: 'keep form draft' } });
});

test('Computer Use scope controls wait for backend support during deployment', async t => {
  const { document, settle, events, thread } = await page(t, {}, [], false, false);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => document.getElementById('threadTitle').textContent === 'Task');
  events.emit('thread', { ...thread, revision: 2, requests: [{ key: 'app', method: 'mcpServer/elicitation/request', params: { mode: 'form', serverName: 'cua_repl', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', tool_params: { app: 'com.example.Browser' }, persist: ['session', 'always'] } } }] });
  assert.deepEqual([...document.querySelectorAll('[data-request-key=app] button')].map(button => button.textContent), ['拒绝', '允许一次']);
});

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

test('async question cards preserve drafts and continue through answer or skip without starting another turn', async t => {
  const { $, document, window, settle, events, thread, requests, input } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  input('prompt', '未发送的聊天草稿');
  const question = { key: 'async-question', method: 'item/agentMessage/answer', params: { threadId: 't1', turnId: 'live', isBlocking: false, questions: [{ id: 'color', header: '颜色', question: '选择虚构颜色', isOther: true, options: [{ label: '蓝色', description: '建议' }, { label: '银色', description: '备选' }] }] } };
  events.emit('thread', { ...thread, revision: 2, busy: true, turnId: 'live', requests: [question] });
  assert.match($('runStatusText').textContent, /正在处理，你可以补充回答/);
  const card = document.querySelector('[data-request-key=async-question]'), answer = card.querySelector('[name=color]');
  answer.value = '自己的颜色'; answer.dispatchEvent(new window.Event('input')); answer.focus();
  events.emit('thread', { ...thread, revision: 3, busy: true, turnId: 'live', items: [{ id: 'progress', type: 'agentMessage', text: '仍在处理其他工作' }], requests: [question] });
  assert.equal(document.querySelector('[name=color]'), answer); assert.equal(document.activeElement, answer);
  assert.equal(requests.filter(r => r.route === '/api/respond').length, 0);
  card.dispatchEvent(new window.Event('submit', { cancelable: true })); card.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle(() => !document.querySelector('[data-request-key=async-question]'));
  assert.deepEqual(requests.filter(r => r.route === '/api/respond').map(r => r.body), [{ key: 'async-question', answers: { color: '自己的颜色' } }]);
  const skipped = { ...question, key: 'skip-question' };
  events.emit('thread', { ...thread, revision: 4, busy: true, turnId: 'live', requests: [skipped] });
  document.querySelector('[data-request-key=skip-question] .secondary-button').click();
  await settle(() => !document.querySelector('[data-request-key=skip-question]'));
  assert.deepEqual(requests.filter(r => r.route === '/api/respond').at(-1).body, { key: 'skip-question', decision: 'skip' });
  assert.equal($('prompt').value, '未发送的聊天草稿');
  assert.equal(requests.some(r => ['/api/send', '/api/followup', '/api/interrupt'].includes(r.route)), false);
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

test('generated images stay in conversation order, survive later failures and update without replacing loaded previews', async t => {
  const { $, document, window, settle, events, thread, input, requests } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  input('prompt', '保留图片任务草稿');
  const attachment = n => ({ kind: 'image', name: '生成的图片.png', previewUrl: '/api/attachments/images/12345678-1234-1234-1234-123456789ab' + n });
  const items = [
    { id: 'reply1', type: 'agentMessage', text: '正在生成第一张', turnId: 'turn' },
    { id: 'image1', type: 'imageGeneration', status: 'inProgress', turnId: 'turn' },
  ];
  let revision = 1;
  const update = (busy = true) => events.emit('thread', { ...thread, revision: ++revision, busy, turnId: 'turn', latestTurnId: 'turn', completion: busy ? null : 'failed', items: structuredClone(items) });
  update();
  const card = document.querySelector('.generated-image');
  assert.match(card.textContent, /正在生成图片/); assert.equal(card.querySelector('.attachment-image'), null);
  items[1] = { ...items[1], status: 'completed', attachment: attachment(1) }; update();
  const thumbnail = card.querySelector('.attachment-image img'), button = card.querySelector('.attachment-image-button');
  assert.equal(thumbnail.getAttribute('src'), attachment(1).previewUrl);
  button.click();
  const dialog = document.querySelector('.image-preview-dialog'); assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('a').download, '生成的图片.png');
  assert.equal(dialog.querySelector('a').getAttribute('href'), attachment(1).previewUrl);
  dialog.querySelector('button.text-button').click(); assert.ok(dialog.querySelector('.original-size'));
  items.push({ id: 'reply2', type: 'agentMessage', text: '继续生成后面的图片', turnId: 'turn' });
  for (const n of [2, 3]) items.push({ id: 'image' + n, type: 'imageGeneration', status: 'completed', attachment: attachment(n), turnId: 'turn' });
  items.push({ id: 'image4', type: 'imageGeneration', status: 'failed', turnId: 'turn' });
  update(false); update(false);
  assert.equal(document.querySelectorAll('.generated-image').length, 4);
  assert.equal(document.querySelectorAll('.generated-image .attachment-image img').length, 3);
  assert.equal(document.querySelector('.generated-image'), card); assert.equal(card.querySelector('.attachment-image img'), thumbnail);
  assert.equal(document.querySelector('.image-preview-dialog'), dialog); assert.equal(dialog.open, true); assert.ok(dialog.querySelector('.original-size'));
  const order = [...$('messages').children].filter(node => node.dataset.signature).map(node => { const item = JSON.parse(node.dataset.signature); return (Array.isArray(item) ? item[0] : item).id; });
  assert.deepEqual(order, ['reply1', 'image1', 'reply2', 'image2', 'image3', 'image4']);
  assert.equal(document.querySelector('.execution-group .generated-image'), null);
  assert.match(document.querySelectorAll('.generated-image')[3].textContent, /图片生成失败，未返回图片/);
  dialog.querySelector('[aria-label="关闭图片预览"]').click(); assert.equal(document.activeElement, button);
  thumbnail.dispatchEvent(new window.Event('error')); assert.match(card.textContent, /图片已失效或无法读取/);
  assert.equal($('prompt').value, '保留图片任务草稿');
  assert.equal(requests.some(request => request.body), false, 'viewing and updating images must not submit any action');
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

test('chat shows a file summary without restoring the result dashboard, and review remains available', async t => {
  const { $, document, settle, events, thread, requests, input } = await page(t, {}, [], true);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  events.emit('thread', { ...thread, revision: 2, latestTurnId: 'done', completion: 'completed', turnTimings: [{ id: 'done', status: 'completed', durationMs: 246000 }], items: [
    { id: 'reply', turnId: 'done', type: 'agentMessage', text: '[结果](a.py)', timestamp: 1789635363000, timestampSource: 'native' },
    { id: 'check', turnId: 'done', type: 'commandExecution', title: 'node --test', status: 'completed', exitCode: 1, text: 'first attempt failed' },
    { id: 'file', turnId: 'done', type: 'fileChange', title: '修改文件', status: 'completed', changes: [{ path: 'a.py', diff: '@@ -1 +1 @@\n-x=1\n+x=2' }] },
  ] });
  assert.equal($('taskResult'), null); assert.equal($('workbenchDialog').hidden, true);
  const summary = document.querySelector('.change-summary'); assert.ok(summary); assert.equal($('messages').lastElementChild, summary);
  assert.match(summary.textContent, /已编辑 1 个文件/); assert.match(summary.textContent, /\+1 −1/);
  summary.querySelector('.change-summary-review').click(); await settle(() => !$('workbenchDialog').hidden);
  assert.match($('turnChanges').textContent, /a\.py/); assert.match($('turnChanges').textContent, /撤销这次改动/);
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

test('file summaries follow each completed turn and never collect files from the running turn', async t => {
  const { $, document, settle, events, thread, requests, open, input } = await page(t);
  await open('a.py'); input('fileEditorText', 'x=8 # unsaved'); const editor = $('fileEditorText');
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  const make = (turnId, path) => [
    { id: `file-${turnId}`, turnId, type: 'fileChange', status: 'completed', changes: [{ path, kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }] },
    { id: `reply-${turnId}`, turnId, type: 'agentMessage', text: `done-${turnId}` },
  ];
  const items = [...make('old', 'a.py'), { id: 'user-new', turnId: 'new', type: 'userMessage', text: 'next' }, ...make('new', 'b.py')];
  events.emit('thread', { ...thread, revision: 2, items, busy: true, turnId: 'new', latestTurnId: 'new', turnTimings: [{ id: 'old', status: 'completed' }] });
  const old = document.querySelector('.change-summary'); assert.equal(document.querySelectorAll('.change-summary').length, 1); assert.match(old.previousElementSibling.textContent, /done-old/);
  assert.doesNotMatch(old.textContent, /b\.py/); old.querySelector('.change-summary-path').click(); await settle(() => $('fileEditorText') === editor);
  assert.equal(editor.value, 'x=8 # unsaved');
  events.emit('thread', { ...thread, revision: 3, items, busy: false, latestTurnId: 'new', completion: 'completed', turnTimings: [{ id: 'old', status: 'completed' }, { id: 'new', status: 'completed' }] });
  assert.equal(document.querySelector('.change-summary'), old); assert.equal(document.querySelectorAll('.change-summary').length, 2);
  const latest = $('messages').lastElementChild; assert.match(latest.textContent, /b\.py/); assert.doesNotMatch(latest.textContent, /a\.py/);
  old.querySelector('.change-summary-review').click(); await settle(() => !$('workbenchDialog').hidden);
  assert.match($('turnChanges').textContent, /a\.py/); assert.doesNotMatch($('turnChanges').textContent, /b\.py/);
  assert.equal(requests.some(request => request.route.includes('/apply') || request.route === '/api/send'), false);
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

test('native message citations open Excel only on click and followups preserve drafts without sending', async t => {
  const { $, document, settle, events, thread, requests, open, input } = await page(t);
  const path = 'AIdata/20260924/报表 明细.xlsx', previews = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (route, options = {}) => {
    const url = new URL(route, 'http://localhost');
    if (url.pathname === '/api/project/artifact') {
      previews.push({ route, path: url.searchParams.get('path') });
      return { ok: true, json: async () => ({ cwd: '/project', path, name: '报表 明细.xlsx', extension: '.xlsx', base64: '', version: 'v1', stamp: 's1' }) };
    }
    if (url.pathname === '/api/project/spreadsheet') {
      previews.push({ route, ...JSON.parse(options.body) });
      return { ok: true, json: async () => ({ sheets: ['Sheet1'], sheet: 0, columns: ['A', 'B'], rows: [['服务状态', '记录数'], ['待确认', 53]], totalRows: 2, totalColumns: 2, limited: false }) };
    }
    return originalFetch(route, options);
  };
  await open('a.py'); input('fileEditorText', 'x=7 # unsaved'); const editor = $('fileEditorText');
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task');
  const citation = `:codex-file-citation{path="/project/${path}" purpose="source" artifact_kind="workbook" sheet="Sheet1" range="A1:B2"}`;
  const suggestion = '进一步查看 use_state 的分布';
  const text = `完整结果见：${citation}\n\n- :codex-followup[查看明细]{prompt="${suggestion}"}`;
  events.emit('thread', { ...thread, revision: 2, items: [{ id: 'native', type: 'agentMessage', text: citation.slice(0, -1) }] });
  assert.equal(document.querySelectorAll('#messages .file-citation').length, 0);
  events.emit('thread', { ...thread, revision: 3, items: [{ id: 'native', type: 'agentMessage', text }] });
  assert.equal(document.querySelectorAll('#messages .file-citation').length, 1); assert.equal(previews.length, 0);
  assert.doesNotMatch($('messages').textContent, /codex-file-citation|codex-followup|\/project\/AIdata/);
  input('prompt', '保留已有草稿'); document.querySelector('#messages .message-followup').click();
  assert.equal($('prompt').value, `保留已有草稿\n\n${suggestion}`); assert.equal(document.activeElement, $('prompt'));
  events.emit('thread', { ...thread, revision: 4, items: [{ id: 'native', type: 'agentMessage', text: text + '\n\n结束。' }] });
  document.querySelector('#messages .message-followup').click();
  assert.equal($('prompt').value, `保留已有草稿\n\n${suggestion}\n\n${suggestion}`, 'stream updates must not duplicate click listeners');
  document.querySelector('#messages .file-citation').click();
  await settle(() => document.querySelector('.sheet-scroll table')?.textContent.includes('待确认'));
  assert.equal(previews.length, 2); assert.ok(previews.every(request => request.path === path));
  assert.equal(document.querySelector('.sheet-tabs [aria-selected=true]').textContent, 'Sheet1');
  [...$('editorTabs').querySelectorAll('[role=tab]')].find(tab => tab.textContent.includes('a.py')).click();
  assert.equal($('fileEditorText'), editor); assert.equal(editor.value, 'x=7 # unsaved');
  assert.equal(requests.some(request => /\/send|\/followup|\/save|\/sql\/query|\/terminal\/start/.test(request.route)), false);
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


test('memory settings and previews use native APIs, preserve drafts, reject stale saves and never cache memory content', async t => {
  const { $, document, window, settle, input, open, requests } = await page(t);
  await open('a.py'); input('fileEditorText', '未保存编辑草稿'); input('prompt', '未发送聊天草稿');
  let record = { settings: { enabled: true, generate: true, use: true, allowExternal: true }, runtimeEnabled: true, revision: 'a'.repeat(64), writable: true, managedEnabled: null, files: [{ id: 'summary', label: '虚构记忆摘要', bytes: 100, modifiedAt: 1 }] };
  let finishSave, failRead = false; const saved = globalThis.fetch, memoryCalls = [];
  globalThis.fetch = async (route, options = {}) => {
    if (!route.startsWith('/api/memories')) return saved(route, options);
    const body = options.body && JSON.parse(options.body); memoryCalls.push({ route, body });
    if (route === '/api/memories/settings') return new Promise(resolve => { finishSave = () => { record = { ...record, settings: body.settings, revision: 'b'.repeat(64) }; resolve({ ok: true, json: async () => structuredClone(record) }); }; });
    if (route.startsWith('/api/memories/file')) return { ok: true, json: async () => ({ id: 'summary', content: '<img src=x onerror=alert(1)>虚构记忆', truncated: true }) };
    if (failRead) return { ok: false, status: 503, json: async () => ({ error: '模拟读取失败' }) };
    return { ok: true, json: async () => structuredClone(record) };
  };
  $('settingsButton').click(); await settle(() => !$('workbenchDialog').hidden);
  $('workbench-tab-memories').click(); await settle(() => !$('memoriesSave').disabled);
  assert.equal($('memoriesEnabled').checked, true); assert.equal(memoryCalls.length, 1);
  document.querySelector('#memoriesFiles button').click(); await settle(() => $('memoriesPreviewContent').textContent.includes('虚构记忆'));
  assert.equal($('memoriesPreviewContent').querySelector('img'), null); assert.match($('memoriesPreviewHint').textContent, /256 KB/);
  $('memoriesUse').click(); $('memorySettingsForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  $('memorySettingsForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.equal(memoryCalls.filter(call => call.body).length, 1); assert.equal($('memoriesSave').disabled, true);
  assert.deepEqual(memoryCalls.at(-1).body, { revision: 'a'.repeat(64), settings: { enabled: true, use: false, generate: true, allowExternal: true } });
  finishSave(); await settle(() => !$('memoriesSave').disabled); assert.match($('memoriesStatus').textContent, /设置已保存/);
  assert.equal($('fileEditorText').value, '未保存编辑草稿'); assert.equal($('prompt').value, '未发送聊天草稿');
  assert.equal(Object.values(window.localStorage).some(value => String(value).includes('虚构记忆')), false);
  failRead = true; $('memoriesRefresh').click(); await settle(() => $('memoriesStatus').textContent.includes('模拟读取失败'));
  assert.equal($('memoriesSave').disabled, true);
  $('memorySettingsForm').dispatchEvent(new window.Event('submit', { cancelable: true })); assert.equal(memoryCalls.filter(call => call.body).length, 1);
  assert.equal(requests.some(request => request.route === '/api/send'), false);
});

test('execution motion pauses on disconnect and matching approvals while preserving selected logs and drafts', async t => {
  const { $, document, settle, events, thread, input, requests } = await page(t);
  document.querySelector('[data-thread-id=t1]').click(); await settle(() => $('threadTitle').textContent === 'Task'); input('prompt', '保留动效验收草稿');
  const running = { ...thread, revision: 2, busy: true, turnId: 'motion', latestTurnId: 'motion', items: [{ id: 'motion-command', type: 'commandExecution', turnId: 'motion', title: '示例命令', status: 'inProgress', text: '保留这一段输出' }] };
  events.emit('thread', running);
  const group = document.querySelector('.execution-group'), activity = group.querySelector('.activity'), details = activity.querySelector('details'), output = activity.querySelector('.activity-output'); details.open = true;
  const range = document.createRange(); range.selectNodeContents(output.firstChild); document.getSelection().removeAllRanges(); document.getSelection().addRange(range);
  assert.equal(document.getSelection().toString(), '保留这一段输出');
  assert.equal(group.dataset.executionState, 'running'); assert.equal(activity.dataset.executionState, 'running');
  events.emit('connection', { connected: false }); assert.equal(group.dataset.executionState, 'unknown'); assert.equal(activity.dataset.executionState, 'unknown'); assert.match(group.textContent, /状态待同步/);
  assert.equal(activity.querySelector('details'), details); assert.equal(details.open, true); assert.equal(document.getSelection().toString(), '保留这一段输出');
  events.emit('snapshot', { connected: true, threads: [{ ...running, revision: 3 }] }); assert.equal(group.dataset.executionState, 'running'); assert.equal(activity.dataset.executionState, 'running');
  const approval = { key: 'motion-approval', method: 'item/commandExecution/requestApproval', params: { threadId: 't1', itemId: 'motion-command', command: '示例命令' } };
  events.emit('thread', { ...running, revision: 4, requests: [approval] }); assert.equal(group.dataset.executionState, 'waiting'); assert.equal(activity.dataset.executionState, 'waiting');
  events.emit('thread', { ...running, revision: 5, busy: false, turnId: null, completion: 'interrupted', items: [{ ...running.items[0], status: 'inProgress' }] });
  assert.equal(group.dataset.executionState, 'interrupted'); assert.equal(activity.dataset.executionState, 'interrupted'); assert.equal(details.open, true); assert.equal($('prompt').value, '保留动效验收草稿'); assert.equal(requests.some(request => request.body), false);
});
