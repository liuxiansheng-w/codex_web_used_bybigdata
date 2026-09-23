import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createProjectList } from '../public/project-list.js';
import { createFileEditor } from '../public/file-editor.js';

async function page(t) {
  const errors = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://127.0.0.1:4318', pretendToBeVisual: true, virtualConsole: console });
  const { window } = dom, document = window.document;
  window.matchMedia = () => ({ matches: false }); window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {} });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const saved = Object.fromEntries(['window', 'document', 'Option', 'localStorage', 'requestAnimationFrame', 'EventSource', 'fetch', 'confirm', 'setTimeout'].map(key => [key, globalThis[key]]));
  const timers = new Set();
  Object.assign(globalThis, { window, document, Option: window.Option, localStorage: window.localStorage, requestAnimationFrame: fn => { fn(); return 0; }, confirm: () => true, setTimeout: (...args) => { const id = saved.setTimeout(...args); timers.add(id); return id; } });
  t.after(() => { for (const timer of timers) clearTimeout(timer); Object.assign(globalThis, saved); window.close(); assert.deepEqual(errors.map(error => error.message), []); });
  const $ = id => document.getElementById(id);
  const settle = async condition => { for (let n = 0; n < 300; n++) { if (condition()) return; await new Promise(resolve => saved.setTimeout(resolve, 1)); } assert.fail(`UI did not settle: ${$('noticeText').textContent}; ${$('projectPickerError').textContent}`); };
  return { $, window, document, settle, input(id, value) { $(id).value = value; $(id).dispatchEvent(new window.Event('input', { bubbles: true })); }, submit(id) { $(id).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); } };
}

test('sidebar project actions target the chosen project without switching and dismiss safely', async t => {
  const { $, document, window } = await page(t);
  const opened = [], selected = [];
  const registry = createProjectList({ api: async () => { throw new Error('Menu must not fetch files'); }, onSelect: cwd => selected.push(cwd), onGit: cwd => opened.push(cwd), getContext: () => ({ cwd: '/one' }), notice: assert.fail });
  registry.remember('/one'); registry.remember('/two');
  const trigger = document.querySelector('.project-more[data-cwd="/two"]'), popup = document.getElementById('projectActionsPopup');
  assert.equal(document.querySelectorAll('.project-more').length, 2);
  trigger.click(); assert.equal(popup.hidden, false); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(popup.parentElement, document.body, 'scrollable project rows cannot clip the menu');
  assert.equal(document.activeElement, popup.firstChild);
  popup.firstChild.click(); assert.deepEqual(opened, ['/two']); assert.deepEqual(selected, []);
  assert.equal(document.activeElement, trigger); assert.equal(popup.hidden, true);
  trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  popup.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(popup.hidden, true); assert.equal(document.activeElement, trigger);
  trigger.click(); document.body.click(); assert.equal(popup.hidden, true);
  trigger.click(); $('projectList').dispatchEvent(new window.Event('scroll')); assert.equal(popup.hidden, true);
  trigger.click(); registry.refresh(); assert.equal(popup.hidden, true);
  registry.setBusy(true); assert.ok([...document.querySelectorAll('.project-more')].every(button => button.disabled));
});

test('project picker browses folders, validates paths, paginates, ignores stale loads and persists canonical roots', async t => {
  const { $, document, input, submit, settle } = await page(t);
  let cwd = '/one', slow, selected = 0;
  const notices = [];
  const api = async route => {
    const url = new URL(route, 'http://localhost'), path = url.searchParams.get('cwd');
    if (path === '/missing') throw new Error('目录不存在');
    if (path === '/slow') return new Promise(resolve => { slow = () => resolve({ cwd: path, entries: [], nextOffset: null }); });
    if (path === '/') return { cwd: '/', entries: url.searchParams.has('offset') ? [{ kind: 'folder', name: 'three' }] : [{ kind: 'folder', name: 'two' }, { kind: 'file', name: 'not-a-folder.txt' }], nextOffset: url.searchParams.has('offset') ? null : 200 };
    return { cwd: path === '/alias' ? '/two' : path, entries: [], nextOffset: null };
  };
  const registry = createProjectList({ api, onSelect: async path => { selected++; cwd = path; return true; }, getContext: () => ({ cwd }), notice: text => notices.push(text) }); registry.remember('/one');
  $('addProjectButton').click(); await settle(() => !$('chooseProject').disabled);
  assert.equal(document.querySelectorAll('.project-folder').length, 1); assert.equal($('projectUp').disabled, true);
  $('projectMore').click(); await settle(() => document.querySelectorAll('.project-folder').length === 2);
  document.querySelector('.project-folder').click(); await settle(() => $('projectChosenPath').textContent === '/two');
  $('chooseProject').click(); await settle(() => !$('projectPicker').open); assert.equal(selected, 1); assert.equal(cwd, '/two'); assert.deepEqual(registry.list(), ['/one', '/two']);
  $('addProjectButton').click(); await settle(() => !$('chooseProject').disabled);
  input('projectLocation', '/missing'); assert.equal($('chooseProject').disabled, true); submit('projectLocationForm'); await settle(() => $('projectPickerError').textContent.includes('目录不存在'));
  assert.equal($('chooseProject').disabled, true); assert.equal(cwd, '/two'); assert.deepEqual(registry.list(), ['/one', '/two']);
  input('projectLocation', '/slow'); submit('projectLocationForm'); await settle(() => slow);
  input('projectLocation', '/alias'); submit('projectLocationForm'); await settle(() => $('projectLocation').value === '/two'); slow(); await new Promise(setImmediate);
  assert.equal($('projectLocation').value, '/two'); $('chooseProject').click(); await settle(() => !$('projectPicker').open); assert.equal(registry.list().length, 2);
  assert.throws(() => registry.forget('/two'), /先切换/); registry.forget('/one'); assert.deepEqual(JSON.parse(localStorage.getItem('codex-desk:projects')), ['/two']);
  registry.setBusy(true); assert.equal($('addProjectButton').disabled, true); assert.equal(document.querySelector('.project-select').disabled, true);
  assert.deepEqual(notices, []);
});

test('app switches projects offline without closing buffers, mixing same-name files, drafts or permissions', async t => {
  const { $, document, input, submit, settle } = await page(t);
  const requests = [], files = new Map([['/one', 'one disk\n'], ['/two', 'two disk\n']]);
  let events, finishSlow;
  localStorage.setItem('codex-desk:projects', JSON.stringify(['/one', '/two', '/missing', '/slow']));
  globalThis.EventSource = class { constructor() { this.listeners = {}; events = this; } addEventListener(name, fn) { this.listeners[name] = fn; } close() {} emit(name, data) { return this.listeners[name]?.({ data: JSON.stringify(data) }); } };
  globalThis.fetch = async (route, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined, url = new URL(route, 'http://localhost'), cwd = url.searchParams.get('cwd'); requests.push({ route, body });
    let data;
    if (url.pathname === '/api/bootstrap') data = { connected: true, csrf: 'test', cwd: '/one', auth: { loggedIn: true }, models: [], permissions: { options: ['workspace-write', 'read-only', 'danger-full-access'].map(id => ({ id, enabled: true })) } };
    else if (url.pathname === '/api/threads') data = { cwd, threads: [], nextCursor: null };
    else if (url.pathname === '/api/project/files') {
      if (cwd === '/missing') return { ok: false, status: 404, json: async () => ({ error: '目录不存在' }) };
      if (cwd === '/slow') await new Promise(resolve => { finishSlow = resolve; });
      data = { cwd, entries: [{ name: 'same.py', path: 'same.py', kind: 'file' }], nextOffset: null };
    } else if (url.pathname === '/api/project/file') data = { cwd, path: 'same.py', content: files.get(cwd), writable: true, version: 'a'.repeat(64), newline: 'LF' };
    else if (url.pathname === '/api/project/save') { files.set(body.cwd, body.content); data = { ...body, writable: true, newline: 'LF' }; }
    else if (url.pathname === '/api/capabilities') data = { skills: [], plugins: [], planSupported: true };
    else throw new Error(`Unmocked ${route}`);
    return { ok: true, json: async () => structuredClone(data) };
  };
  await import(`../public/app.js?projects=${Date.now()}`); await events.emit('open'); await settle(() => document.querySelector('.file-main'));
  const select = cwd => document.querySelector(`.project-select[data-cwd="${cwd}"]`).click();
  document.querySelector('.file-main').click(); await settle(() => $('fileEditorText').value === 'one disk\n');
  const firstInput = $('fileEditorText'); input('fileEditorText', 'one unsaved\n'); firstInput.setSelectionRange(4, 7); input('prompt', 'one message');
  $('permissionButton').click(); document.querySelector('[data-mode="danger-full-access"]').click(); $('fullAccessAcknowledged').checked = true; submit('fullAccessForm'); assert.equal($('mode').value, 'danger-full-access');
  select('/two'); await settle(() => $('breadcrumbWorkspace').title === '/two' && !$('addProjectButton').disabled);
  assert.equal($('prompt').value, ''); assert.equal($('mode').value, 'workspace-write'); assert.equal($('fileEditor').hidden, true); assert.equal(firstInput.value, 'one unsaved\n');
  await settle(() => document.querySelector('.file-main') && !document.querySelector('.file-main').disabled); document.querySelector('.file-main').click(); await settle(() => $('fileEditorText').value === 'two disk\n');
  input('fileEditorText', 'two unsaved\n'); input('prompt', 'two message');
  assert.equal(document.querySelectorAll('.editor-tab:not([hidden])').length, 1); assert.match($('projectList').textContent, /1 个文件未保存/);
  $('editorSaveAll').click(); await settle(() => files.get('/two') === 'two unsaved\n' && !$('addProjectButton').disabled); assert.equal(files.get('/one'), 'one disk\n');
  select('/missing'); await settle(() => $('noticeText').textContent.includes('目录不存在')); assert.equal($('breadcrumbWorkspace').title, '/two'); assert.equal($('prompt').value, 'two message');
  select('/one'); await settle(() => $('breadcrumbWorkspace').title === '/one' && !$('addProjectButton').disabled);
  assert.equal($('fileEditorText'), firstInput); assert.equal(firstInput.value, 'one unsaved\n'); assert.equal(firstInput.selectionStart, 4); assert.equal($('prompt').value, 'one message'); assert.equal($('mode').value, 'workspace-write');
  $('editorSaveAll').click(); await settle(() => files.get('/one') === 'one unsaved\n' && !$('addProjectButton').disabled); assert.equal(files.get('/two'), 'two unsaved\n');
  await events.emit('connection', { connected: false });
  const threadLoads = requests.filter(item => item.route.startsWith('/api/threads?')).length;
  select('/two'); await settle(() => $('breadcrumbWorkspace').title === '/two' && !$('addProjectButton').disabled);
  assert.equal($('prompt').value, 'two message'); assert.equal($('fileEditorText').readOnly, false);
  assert.equal(requests.filter(item => item.route.startsWith('/api/threads?')).length, threadLoads, 'offline project switching does not depend on model APIs');
  select('/slow'); await settle(() => finishSlow); assert.equal($('addProjectButton').disabled, true); assert.equal($('prompt').readOnly, true); assert.equal($('newThread').disabled, true);
  select('/one'); assert.equal($('breadcrumbWorkspace').title, '/two'); finishSlow(); await settle(() => $('breadcrumbWorkspace').title === '/slow' && !$('addProjectButton').disabled);
  assert.ok(!requests.some(item => /send|followup/.test(item.route)), 'project navigation never triggers a model turn');
});

test('multi-project draft recovery and close-all stay scoped while unload protection includes hidden projects', async t => {
  const { $, window, input } = await page(t);
  const writes = [];
  const editor = createFileEditor({ api: async (route, body) => { const url = new URL(route, 'http://localhost'); if (body) writes.push(body); return { cwd: body?.cwd || url.searchParams.get('cwd'), path: body?.path || url.searchParams.get('path'), content: body?.content || 'disk', writable: true, version: 'a'.repeat(64), newline: 'LF' }; }, onAttach() {} });
  editor.setProject('/one');
  await editor.restore(['/one', '/two'].map(cwd => ({ cwd, path: 'same.py', content: `${cwd} recovered`, baseline: 'disk', version: 'a'.repeat(64) })));
  assert.equal(editor.current.cwd, '/one'); assert.equal(editor.current.content, '/one recovered'); assert.equal(editor.tabs.length, 2);
  assert.equal(await editor.saveAll(), true); assert.deepEqual(writes.map(body => body.cwd), ['/one']); assert.equal(editor.dirty, true);
  assert.equal(await editor.close(), true); assert.equal(editor.tabs.length, 1); assert.equal(editor.visible, false);
  const event = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
  editor.setProject('/two'); assert.equal(editor.current.content, '/two recovered'); input('fileEditorText', 'edited again'); assert.equal(await editor.save(), true); assert.equal(editor.dirty, false); assert.equal($('editorSaveAll').disabled, true);
});
