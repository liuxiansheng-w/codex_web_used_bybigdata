import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Workspace } from '../lib/workspace.mjs';
import { ThreadReads } from '../lib/thread-reads.mjs';
import { isThreadUnread } from '../public/thread-reads.js';
import { createChatFind } from '../public/chat-find.js';
import { createApplication } from '../server.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-chat-search-')));
  const a = path.join(root, 'project-a'), b = path.join(root, 'project-b'), stateDir = path.join(root, 'state');
  await mkdir(a); await mkdir(b); await mkdir(stateDir);
  return { root, a, b, stateDir };
}

test('cross-project title and content search use the native global cursor without changing projects', async () => {
  const { a, b } = await fixture(), calls = [], bridge = new EventEmitter();
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') return params.cursor
      ? { data: [{ id: 'third', cwd: b, name: 'Third', updatedAt: 3 }], nextCursor: null }
      : { data: [{ id: 'first', cwd: a, name: 'First', updatedAt: 2 }, { id: 'second', cwd: b, name: 'Second', updatedAt: 1 }], nextCursor: 'next' };
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: params.threadId === 'first' ? a : b,
      turns: [{ items: [{ type: 'agentMessage', text: params.threadId === 'second' ? 'match in other project' : 'something else' }] }] } };
    throw new Error('Unexpected runtime operation: ' + method);
  };
  const workspace = new Workspace(bridge, a);
  const all = await workspace.list(a, null, { allProjects: true, search: 'match', scope: 'content' });
  assert.equal(all.cwd, a); assert.equal(all.allProjects, true); assert.equal(all.nextCursor, 'next');
  assert.deepEqual(all.threads.map(thread => [thread.id, thread.cwd]), [['second', b]]);
  assert.equal(calls[0].params.cwd, undefined);
  const page = await workspace.list(a, 'next', { allProjects: true });
  assert.deepEqual(page.threads.map(thread => thread.id), ['third']); assert.equal(page.nextCursor, null);
  assert.equal(calls.filter(call => call.method === 'thread/read').length, 2);
  assert.ok(calls.every(call => ['thread/list', 'thread/read'].includes(call.method)));
});

test('read markers persist, honor scope, reject stale writes and keep corrupted state', async () => {
  const { a, b, stateDir } = await fixture();
  const reads = new ThreadReads(stateDir, { verifyThread: async (id, cwd) => id === 'first' && cwd === a || id === 'second' && cwd === b });
  let state = await reads.list();
  assert.equal(isThreadUnread({ id: 'first', cwd: a, updatedAt: state.baseline - 1 }, state), false);
  assert.equal(isThreadUnread({ id: 'first', cwd: a, updatedAt: state.baseline + 1000 }, state), true);
  state = await reads.action({ action: 'unread', cwd: a, threadId: 'first', revision: state.revision });
  state = await reads.action({ action: 'unread', cwd: b, threadId: 'second', revision: state.revision });
  assert.equal(isThreadUnread({ id: 'first', cwd: a }, state), true);
  assert.equal(isThreadUnread({ id: 'second', cwd: b }, state), true);
  await assert.rejects(reads.action({ action: 'read', cwd: b, threadId: 'first', seenAt: Date.now(), revision: state.revision }), /不属于/);
  await assert.rejects(reads.action({ action: 'all-read', cwd: a, seenAt: Date.now(), revision: state.revision - 1 }), /已变化/);
  state = await reads.action({ action: 'all-read', cwd: a, seenAt: Date.now(), revision: state.revision });
  assert.equal(isThreadUnread({ id: 'first', cwd: a }, state), false);
  assert.equal(isThreadUnread({ id: 'second', cwd: b }, state), true);
  const restarted = new ThreadReads(stateDir, { verifyThread: async () => true });
  assert.equal(isThreadUnread({ id: 'second', cwd: b }, await restarted.list()), true);
  const filename = path.join(stateDir, 'thread-reads/state.json'); await writeFile(filename, '{broken');
  await assert.rejects(restarted.list(), /读取失败/); assert.equal(await readFile(filename, 'utf8'), '{broken');
});

test('chat find covers unmounted earlier messages, treats symbols literally and preserves the draft', async t => {
  const dom = new JSDOM('<main id="mainPanel" data-chat-view="conversation"><div class="conversation-heading"><button id="chatSearchButton"></button></div><div id="scrollArea"><section id="messages"></section></div><textarea id="prompt">keep draft</textarea></main><textarea id="editor"></textarea>', { url: 'http://localhost/', pretendToBeVisual: true });
  const { window: win } = dom, doc = win.document, elements = new Map(), highlighted = new Map();
  Object.defineProperty(win, 'CSS', { value: { highlights: highlighted }, configurable: true });
  win.Highlight = class extends Array { constructor(...ranges) { super(...ranges); } };
  t.after(() => win.close());
  let thread = { id: 'chat-a', items: [{ id: 'old', type: 'userMessage', text: 'older a+b match' }, { id: 'new', type: 'agentMessage', text: '**A+B** later' }] };
  function mount(item) {
    const article = doc.createElement('article');
    if (item.type === 'userMessage') { article.className = 'message user'; article.append(doc.createElement('div')); const body = doc.createElement('div'); body.textContent = item.text; article.append(body); }
    else { article.className = 'message agent'; const body = doc.createElement('div'); body.className = 'message-body'; body.innerHTML = '<p><strong>A+B</strong> later</p>'; article.append(body); }
    doc.getElementById('messages').append(article); elements.set(item.id, article);
  }
  mount(thread.items[1]); const revealed = [];
  const find = createChatFind({ document: doc, getThread: () => thread, elementFor: id => elements.get(id), userText: item => item.text,
    ensureVisible: index => { revealed.push(index); if (!elements.has(thread.items[index].id)) mount(thread.items[index]); } });
  const prompt = doc.getElementById('prompt'); prompt.focus();
  prompt.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }));
  const input = doc.querySelector('.chat-find input'); assert.equal(doc.activeElement, input);
  input.value = 'a+b'; input.dispatchEvent(new win.Event('input', { bubbles: true }));
  await new Promise(resolve => win.setTimeout(resolve, 250));
  assert.match(doc.querySelector('.chat-find-count').textContent, /1 \/ 2/);
  assert.deepEqual(revealed, [0]); assert.equal(prompt.value, 'keep draft');
  assert.equal(highlighted.get('lemon-chat-find').length, 2);
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(doc.querySelector('.chat-find').hidden, true); assert.equal(highlighted.size, 0);
  doc.getElementById('editor').focus();
  const event = new win.KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true });
  doc.getElementById('editor').dispatchEvent(event); assert.equal(event.defaultPrevented, false);
  find.open(); input.value = 'old'; thread = { id: 'chat-b', items: [] }; find.update(); assert.equal(input.value, '');
});

test('read and cross-project HTTP routes require session and CSRF and reject foreign ownership', async t => {
  const { a, b, stateDir } = await fixture(), bridge = new EventEmitter(), calls = [];
  bridge.ready = true; bridge.start = async () => {}; bridge.close = () => {};
  bridge.request = async (method, params) => {
    calls.push(method);
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: params.threadId === 'other' ? b : a } };
    if (method === 'thread/list') return { data: [{ id: 'own', cwd: a, name: 'Own' }, { id: 'other', cwd: b, name: 'Other' }], nextCursor: null };
    throw new Error('Unexpected runtime operation: ' + method);
  };
  const app = createApplication({ cwd: a, stateDir, bridge }); app.workspace.bootstrap = async () => ({ connected: true, cwd: a, models: [] });
  await app.start(0); t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port, page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  const boot = await (await fetch(base + '/api/bootstrap', { headers: { cookie } })).json();
  assert.equal(boot.threadReads, true); assert.equal(boot.allProjectChatSearch, true); assert.equal(boot.browserAnnotations, true);
  assert.equal((await fetch(base + '/api/thread-reads')).status, 401);
  assert.equal((await fetch(base + '/api/thread-reads', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-codex-csrf': boot.csrf };
  const initial = await (await fetch(base + '/api/thread-reads', { headers: { cookie } })).json();
  const payload = { action: 'unread', cwd: a, threadId: 'own', revision: initial.revision };
  const saved = await fetch(base + '/api/thread-reads', { method: 'POST', headers, body: JSON.stringify(payload) }); assert.equal(saved.status, 200);
  const state = await saved.json(); assert.equal(isThreadUnread({ id: 'own', cwd: a }, state), true);
  assert.equal((await fetch(base + '/api/thread-reads', { method: 'POST', headers, body: JSON.stringify(payload) })).status, 409);
  assert.equal((await fetch(base + '/api/thread-reads', { method: 'POST', headers, body: JSON.stringify({ ...payload, revision: state.revision, threadId: 'other' }) })).status, 409);
  const all = await (await fetch(base + '/api/threads?cwd=' + encodeURIComponent(a) + '&allProjects=1', { headers: { cookie } })).json();
  assert.deepEqual(all.threads.map(thread => thread.cwd), [a, b]); assert.equal(all.allProjects, true);
  assert.ok(calls.every(method => ['thread/read', 'thread/list'].includes(method)));
});
