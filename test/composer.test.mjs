import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createComposerTools } from '../public/composer.js';
import { createPermissionControl } from '../public/permissions.js';
import { createDraftStore, popupLayout } from '../public/interactions.js';
import { createFileTree } from '../public/file-tree.js';
import { createFileEditor } from '../public/file-editor.js';
import { createEditorWindow } from '../public/editor-window.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const workbenchSource = await readFile(new URL('../public/workbench.js', import.meta.url), 'utf8');
const workbenchIds = [...workbenchSource.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const sqlSource = await readFile(new URL('../public/sql-query.js', import.meta.url), 'utf8');
const sqlIds = [...sqlSource.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

test('every static controller target and entry-point module exists in the page', async () => {
  for (const name of ['app.js', 'composer.js', 'permissions.js', 'file-tree.js', 'file-editor.js', 'project-list.js']) {
    const source = await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(match[1]), `${name} references missing #${match[1]}`);
  }
  assert.match(html, /type="module" src="\/app.js"/);
  assert.match(html, /aria-controls="addMenu"/);
});

// Lightweight controller test double, not a real browser or visual layout test.
function setup(t, withController = true) {
  const elements = [];
  class Element {
    get ownerDocument() { return globalThis.document; }
    constructor(id = '') { elements.push(this); this.id = id; this.value = ''; this.textContent = ''; this.children = []; this.handlers = {}; this.dataset = {}; this.attributes = {}; this.hidden = true; this.disabled = false; this.selectors = new Map(); this.classList = { toggle() {}, add() {}, remove() {} }; this.style = { setProperty() {} }; this.scrollHeight = 300; this.scrollTop = 0; this.scrollLeft = 0; this.clientHeight = 400; }
    addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
    async fire(name, extra = {}) { for (const fn of this.handlers[name] || []) await fn({ preventDefault() {}, stopPropagation() {}, submitter: this, target: this, currentTarget: this, ...extra }); }
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
    before(...items) { if (this.parent) { const index = this.parent.children.indexOf(this); for (const item of items) item.parent = this.parent; this.parent.children.splice(index, 0, ...items); } }
    replaceChildren(...items) { this.children = items; if (['effort', 'model'].includes(this.id)) this.value = items[0]?.value || ''; }
    get options() { return this.children; }
    add(item) { this.children.push(item); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; if (key === 'id') this.id = ''; }
    closest() { return null; }
    setPointerCapture(id) { this.captured = id; }
    hasPointerCapture(id) { return this.captured === id; }
    releasePointerCapture() { this.captured = null; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
    setSelectionRange(start, end, direction = 'none') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
    focus() { globalThis.document.activeElement = this; }
    click() { return this.fire('click'); }
    setRangeText(text, start = 0, end = start) { this.value = this.value.slice(0, start) + text + this.value.slice(end); this.selectionStart = this.selectionEnd = start + text.length; }
    getBoundingClientRect() { return { top: 600, bottom: 634, left: 300, width: 380, height: 420 }; }
    querySelector(selector) { if (!this.selectors.has(selector)) this.selectors.set(selector, new Element()); return this.selectors.get(selector); }
    querySelectorAll() { return []; }
    getContext() { return { fillRect() {} }; }
  }
  const nodes = new Map([...ids, ...workbenchIds, ...sqlIds].map(id => [id, new Element(id)]));
  nodes.get = id => elements.find(element => element.id === id);
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) nodes.get('editorResize' + edge).dataset.edge = edge;
  nodes.get('mode').value = 'workspace-write';
  const previous = { document: globalThis.document, Option: globalThis.Option, window: globalThis.window };
  const events = () => ({ handlers: {}, addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }, async fire(name, event) { for (const handler of this.handlers[name] || []) await handler(event); } });
  globalThis.window = { ...events(), innerWidth: 1440, innerHeight: 900, matchMedia: () => ({ matches: false }), getComputedStyle: () => ({ getPropertyValue: () => '' }) };
  globalThis.Option = class { constructor(text, value) { this.textContent = text; this.value = value; } };
  globalThis.document = { ...events(), defaultView: globalThis.window, documentElement: new Element(), body: new Element(), getElementById: id => nodes.get(id), createElement: () => new Element(), querySelectorAll: () => [], querySelector: () => null };
  t.after(() => { globalThis.document = previous.document; globalThis.Option = previous.Option; globalThis.window = previous.window; });
  const calls = []; const context = { cwd: '/private/tmp', thread: null };
  const catalog = { plugins: [{ key: 'pdf@local', name: 'pdf', title: 'PDF', kind: 'plugin', description: 'PDF tools' }], skills: [{ key: 'review@local', name: 'review', title: 'Review', kind: 'skill', description: 'Code review' }], planSupported: true, warnings: [] };
  const controller = withController ? createComposerTools({
    api: async (route, body) => { calls.push({ route, body }); if (route.startsWith('/api/capabilities')) return catalog; if (route === '/api/goal') return { goal: body.clear ? null : { ...context.thread?.goal, ...body } }; throw new Error(route); },
    notice: message => assert.fail(message), getContext: () => context, onChange() {},
  }) : null;
  return { nodes, calls, context, controller };
}

test('plus menu loads real plugins, selects native plan and effort, and clears sent chips', async t => {
  const { nodes, controller } = setup(t);
  nodes.get('model').value = 'gpt-6-astra';
  controller.setModels([{ id: 'gpt-6-astra', efforts: [{ reasoningEffort: 'xhigh' }] }]);
  assert.deepEqual(nodes.get('effort').options.map(o => o.value), ['', 'xhigh']);
  nodes.get('effort').value = 'xhigh';
  await nodes.get('addButton').fire('click');
  await new Promise(setImmediate);
  assert.equal(nodes.get('addMenu').hidden, false);
  await nodes.get('pluginMenu').children[0].fire('click');
  assert.equal(nodes.get('addMenu').hidden, false, 'multi-select keeps menu open');
  await nodes.get('togglePlan').fire('click');
  const payload = controller.payload();
  assert.equal(payload.plan, true); assert.equal(payload.effort, 'xhigh');
  assert.deepEqual(payload.capabilities, ['pdf@local']);
  assert.equal(nodes.get('contextChips').children.length, 2);
  controller.sent(payload);
  assert.deepEqual(controller.payload().capabilities, []);
  assert.equal(controller.payload().plan, true);
  controller.reset(); assert.equal(controller.payload().plan, false);
});

test('app boots, switches conversations without leaking drafts, and submits through the existing API', async t => {
  const dom = new JSDOM(html, { url: 'http://localhost:4318', pretendToBeVisual: true });
  const priorDOM = { window: globalThis.window, document: globalThis.document, Option: globalThis.Option };
  const { window } = dom; Object.assign(globalThis, { window, document: window.document, Option: window.Option });
  window.matchMedia = () => ({ matches: false }); window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {} });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.HTMLElement.prototype.fire = async function (name) { this.dispatchEvent(new window.Event(name, { bubbles: true, cancelable: true })); await new Promise(setImmediate); };
  const nodes = { get: id => window.document.getElementById(id) };
  t.after(() => { Object.assign(globalThis, priorDOM); window.close(); });
  const previous = { fetch: globalThis.fetch, EventSource: globalThis.EventSource, localStorage: globalThis.localStorage, requestAnimationFrame: globalThis.requestAnimationFrame, setTimeout: globalThis.setTimeout };
  const timers = new Set();
  globalThis.setTimeout = (...args) => { const timer = previous.setTimeout(...args); timers.add(timer); return timer; };
  t.after(() => { for (const timer of timers) clearTimeout(timer); Object.assign(globalThis, previous); });
  const requests = [], saved = new Map();
  const thread = id => ({ id, cwd: '/project', title: id, revision: 1, items: [], requests: [], busy: false, mode: 'workspace-write', plan: id === 'A', model: 'test-model', effort: 'high' });
  globalThis.localStorage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  globalThis.requestAnimationFrame = fn => fn();
  let source;
  globalThis.EventSource = class {
    constructor() { source = this; this.listeners = new Map(); }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    close() {}
    emit(name, value) { return this.listeners.get(name)?.({ data: JSON.stringify(value) }); }
  };
  let releaseB;
  globalThis.fetch = async (route, options = {}) => {
    requests.push({ route, body: options.body && JSON.parse(options.body) });
    let data;
    if (route === '/api/bootstrap') data = { connected: true, csrf: 'test-csrf', cwd: '/project', auth: { loggedIn: true }, models: [{ id: 'test-model', efforts: [{ reasoningEffort: 'high' }] }], permissions: { options: [{ id: 'workspace-write', enabled: true }] } };
    else if (route.startsWith('/api/threads?')) data = { cwd: '/project', threads: [thread('A'), thread('B'), thread('C')], nextCursor: null };
    else if (route === '/api/threads/B') data = await new Promise(resolve => { releaseB = () => resolve(thread('B')); });
    else if (route.startsWith('/api/threads/')) data = thread(route.split('/').at(-1));
    else if (route.startsWith('/api/project/files')) data = { cwd: '/project', path: '', entries: [{ name: 'sample.txt', path: 'sample.txt', kind: 'file' }], nextOffset: null };
    else if (route.startsWith('/api/project/file?')) data = { cwd: '/project', path: 'sample.txt', content: 'file content', writable: true, version: 'a'.repeat(64), newline: 'LF' };
    else if (route === '/api/project/attach') data = { id: 'project-file', name: 'sample.txt', kind: 'file', projectRoot: '/project', projectPath: 'sample.txt' };
    else if (route === '/api/send') data = { threadId: 'sent' };
    else throw new Error(`Unexpected route: ${route}`);
    return { ok: true, json: async () => data };
  };
  await import(`../public/app.js?flow=${Date.now()}`);
  await new Promise(setImmediate);
  assert.ok(source, nodes.get('noticeText').textContent || 'App did not start its stream');
  await source.emit('open'); await source.emit('snapshot', { connected: true, threads: [] });
  await new Promise(setImmediate);
  const fileButton = () => nodes.get('projectFileTree').children[0].children[0].children[1];
  await nodes.get('projectFileTree').children[0].children[0].children[0].fire('click');
  assert.equal(nodes.get('fileEditorText').value, 'file content');
  assert.equal(nodes.get('contextChips').children.length, 0, 'opening file does not attach it');
  await fileButton().fire('click');
  assert.equal(nodes.get('contextChips').children.length, 1);
  assert.equal(fileButton().disabled, true, 'already attached file cannot be duplicated');
  const select = id => [...nodes.get('threadList').querySelectorAll('[data-thread-id]')].find(button => button.dataset.threadId === id).fire('click');
  nodes.get('prompt').value = 'new conversation draft'; await nodes.get('prompt').fire('input');
  await select('A');
  assert.equal(nodes.get('prompt').value, '');
  assert.equal(nodes.get('contextChips').children.length, 1, 'only native plan, no file from new draft');
  assert.equal(fileButton().disabled, false);
  assert.equal(nodes.get('permissionLabel').textContent, '只读 · 计划模式', 'history restores native plan without blank startup draft');
  nodes.get('prompt').value = 'draft A'; await nodes.get('prompt').fire('input');
  const slowB = select('B');
  await select('C'); releaseB(); await slowB;
  assert.equal(nodes.get('threadTitle').textContent, 'C', 'late history response never changes active thread');
  assert.equal(nodes.get('prompt').value, '');
  await select('A'); assert.equal(nodes.get('prompt').value, 'draft A');
  await nodes.get('newThread').fire('click'); assert.equal(nodes.get('prompt').value, 'new conversation draft');
  assert.equal(fileButton().disabled, true, 'restored draft also restores tree selection');
  await nodes.get('newThread').fire('click'); assert.equal(nodes.get('prompt').value, 'new conversation draft', 'new from new preserves the unsent draft');
  nodes.get('prompt').value = 'A scoped implementation task'; await nodes.get('prompt').fire('input');
  assert.equal(fileButton().disabled, true, 'repeated new keeps the attachment selected');
  assert.equal(nodes.get('sendButton').disabled, false);
  await nodes.get('composer').fire('submit');
  const sent = requests.find(request => request.route === '/api/send').body;
  assert.equal(sent.text, 'A scoped implementation task');
  assert.equal(sent.mode, 'workspace-write'); assert.equal(sent.fullAccessConfirmed, false);
  assert.deepEqual(sent.attachments, ['project-file']);
  assert.equal(nodes.get('prompt').value, ''); assert.equal(nodes.get('threadTitle').textContent, 'sent');
});

test('file tree lazily expands folders, filters loaded paths, separates edit/attach and preserves history access', async t => {
  const { nodes } = setup(t, false); const calls = [], attachments = new Set(), opened = [];
  const tree = createFileTree({
    api: async route => {
      const params = new URL(route, 'http://localhost').searchParams; const relative = params.get('path'); calls.push(relative);
      return { entries: relative === '' ? [{ name: 'src', path: 'src', kind: 'folder' }, { name: 'README.md', path: 'README.md', kind: 'file' }] : [{ name: 'index.js', path: 'src/index.js', kind: 'file' }], nextOffset: null };
    },
    hasAttachment: (cwd, path) => attachments.has(`${cwd}:${path}`),
    onOpen: async entry => opened.push(entry),
    onAttach: async ({ cwd, path }) => { attachments.add(`${cwd}:${path}`); }, notice: message => assert.fail(message),
  });
  tree.setProject('/project'); await new Promise(setImmediate);
  assert.deepEqual(calls, ['']);
  let folderButton = nodes.get('projectFileTree').children[0].children[0].children[0];
  await folderButton.fire('click');
  assert.deepEqual(calls, ['', 'src']);
  const nestedFile = nodes.get('projectFileTree').children[0].children[1].children[0].children[0].children[0];
  await nestedFile.fire('click'); assert.deepEqual(opened, [{ cwd: '/project', path: 'src/index.js' }]);
  assert.equal(attachments.size, 0);
  const nestedAdd = nodes.get('projectFileTree').children[0].children[1].children[0].children[0].children[1];
  await nestedAdd.fire('click'); assert.ok(attachments.has('/project:src/index.js'));
  assert.equal(nestedAdd.disabled, true); assert.equal(nestedFile.disabled, false, 'attached files remain editable');
  nodes.get('fileSearch').value = 'index'; await nodes.get('fileSearch').fire('input');
  assert.equal(nodes.get('projectFileTree').children.length, 1);
  await nodes.get('collapseFiles').fire('click');
  assert.equal(nodes.get('fileSearch').value, '');
  assert.equal(nodes.get('projectFileTree').children[0].children.length, 1);
  await nodes.get('projectFileTree').children[0].children[0].children[1].fire('click');
  assert.ok(attachments.has('/project:src'));
  assert.equal(tree.showHistory, undefined, 'file navigation does not own conversation navigation');
});

test('file tree ignores stale project loads, renders errors with retry, and blocks attachment while sending', async t => {
  const { nodes } = setup(t, false); let releaseOld, shouldFail = true, attached = 0;
  const tree = createFileTree({
    api: async route => {
      const cwd = new URL(route, 'http://localhost').searchParams.get('cwd');
      if (cwd === '/old') return new Promise(resolve => { releaseOld = resolve; });
      if (shouldFail) throw new Error('目录读取失败');
      return { entries: [{ name: 'new.txt', path: 'new.txt', kind: 'file' }], nextOffset: null };
    },
    hasAttachment: () => false, onAttach: async () => { attached++; }, notice: message => assert.fail(message),
  });
  tree.setProject('/old'); tree.setProject('/new'); await new Promise(setImmediate);
  assert.equal(nodes.get('projectFileTree').children[0].children[0].textContent, '目录读取失败');
  shouldFail = false; await nodes.get('projectFileTree').children[0].children[1].fire('click');
  releaseOld({ entries: [{ name: 'old.txt', path: 'old.txt', kind: 'file' }], nextOffset: null }); await new Promise(setImmediate);
  const button = nodes.get('projectFileTree').children[0].children[0].children[1];
  assert.match(button.attributes['aria-label'], /new.txt/);
  tree.setBusy(true); await button.fire('click'); assert.equal(attached, 0);
  tree.setBusy(false); await button.fire('click'); assert.equal(attached, 1);
});

test('project attachment locks submission, deduplicates, and refuses a late result after a context change', async t => {
  const { nodes, context } = setup(t, false); let finish;
  const controller = createComposerTools({
    api: async () => new Promise(resolve => { finish = resolve; }), notice: () => {}, getContext: () => context, onChange() {},
  });
  const first = controller.addProjectReference({ cwd: context.cwd, path: 'test.txt' });
  assert.equal(controller.uploading, true);
  await assert.rejects(controller.addProjectReference({ cwd: context.cwd, path: 'test.txt' }), /稍后/);
  finish({ id: 'f1', name: 'test.txt', kind: 'file', projectRoot: context.cwd, projectPath: 'test.txt' });
  await first; assert.equal(controller.uploading, false);
  assert.equal(await controller.addProjectReference({ cwd: context.cwd, path: 'test.txt' }), false);
  assert.equal(nodes.get('contextChips').children.length, 1);
  const late = controller.addProjectReference({ cwd: context.cwd, path: 'other.txt' });
  context.thread = { id: 'another-thread' };
  finish({ id: 'f2', name: 'other.txt', kind: 'file', projectRoot: context.cwd, projectPath: 'other.txt' });
  await assert.rejects(late, /会话已切换/);
  assert.deepEqual(controller.payload().attachments, ['f1']);
  controller.restoreDraft({ files: Array.from({ length: 30 }, (_, index) => ({ id: String(index), name: 'item', kind: 'file' })) });
  await assert.rejects(controller.addProjectReference({ cwd: context.cwd, path: 'too-many.txt' }), /最多添加 30/);
});

function editorSetup(t, handler) {
  const { nodes } = setup(t, false), requests = [], attached = [];
  const disk = { cwd: '/project', path: 'sample.txt', content: 'original\n', version: 'a'.repeat(64), writable: true, newline: 'LF', bom: false };
  const editor = createFileEditor({
    api: async (route, body) => {
      requests.push({ route, body });
      if (handler) return handler(route, body, disk);
      if (body) { disk.path = body.path; disk.content = body.content; disk.version = 'b'.repeat(64); }
      else disk.path = new URL(route, 'http://localhost').searchParams.get('path');
      return { ...disk };
    },
    onAttach: async entry => attached.push(entry),
  });
  editor.setProject('/project');
  return { nodes, editor, disk, requests, attached };
}

test('editor opens without attaching, tracks lines/dirty state, saves by shortcut, and attaches explicitly', async t => {
  const { nodes, editor, requests, attached } = editorSetup(t);
  assert.equal(await editor.open({ cwd: '/project', path: 'sample.txt' }), true);
  assert.equal(editor.visible, true); assert.equal(attached.length, 0);
  assert.equal(nodes.get('fileEditorText').value, 'original\n');
  nodes.get('fileEditorText').value = 'changed\nsecond'; await nodes.get('fileEditorText').fire('input');
  assert.equal(editor.dirty, true); assert.equal(nodes.get('editorSave').disabled, false);
  assert.equal(nodes.get('editorLineNumbers').textContent, '1\n2');
  let prevented = false;
  await document.fire('keydown', { key: 's', metaKey: true, preventDefault() { prevented = true; } }); await new Promise(setImmediate);
  assert.equal(prevented, true); assert.equal(editor.dirty, false);
  assert.deepEqual(requests.at(-1).body, { cwd: '/project', path: 'sample.txt', version: 'a'.repeat(64), content: 'changed\nsecond' });
  await nodes.get('editorAttach').fire('click'); assert.deepEqual(attached, [{ cwd: '/project', path: 'sample.txt' }]);
  assert.equal(await editor.close(), true); assert.equal(editor.visible, false);
});

test('editor automatically highlights SQL/Python, supports manual language and syncs scroll without altering saved text', async t => {
  const { nodes, editor, disk, requests } = editorSetup(t);
  disk.content = '-- 测试\nSELECT sum(value) FROM sample WHERE n > 3;\n';
  await editor.open({ cwd: '/project', path: 'query.sql' });
  assert.equal(nodes.get('editorLanguageStatus').textContent, 'SQL');
  assert.match(nodes.get('editorHighlight').innerHTML, /syntax-keyword">SELECT/);
  const input = nodes.get('fileEditorText');
  input.value += 'SELECT \'<img onerror=x>\';\n'; await input.fire('input');
  assert.doesNotMatch(nodes.get('editorHighlight').innerHTML, /<img/);
  input.scrollTop = 70; input.scrollLeft = 45; input.clientWidth = 620;
  await input.fire('scroll');
  assert.equal(nodes.get('editorHighlight').scrollTop, 70); assert.equal(nodes.get('editorHighlight').scrollLeft, 45);
  assert.equal(nodes.get('editorLineNumbers').scrollTop, 70); assert.equal(nodes.get('editorHighlight').style.width, '620px');
  const original = input.value; await editor.save();
  assert.equal(requests.at(-1).body.content, original); assert.equal(input.value, original);
  nodes.get('editorLanguage').value = 'text'; await nodes.get('editorLanguage').fire('change');
  assert.equal(nodes.get('editorHighlight').innerHTML, ''); assert.equal(input.value, original);
  disk.content = 'def run():\n  print("hello")\n';
  await editor.open({ cwd: '/project', path: 'task.py' });
  assert.equal(nodes.get('editorLanguageStatus').textContent, 'Python');
  assert.match(nodes.get('editorHighlight').innerHTML, /syntax-function">run/);
  assert.equal(nodes.get('fileEditorText').scrollLeft, 0);
  assert.equal(input.scrollLeft, 45, 'the previous tab keeps its own scroll offset');
  nodes.get('editorLanguage').value = 'sql'; await nodes.get('editorLanguage').fire('change');
  assert.equal(nodes.get('editorLanguageStatus').textContent, 'SQL'); assert.equal(editor.dirty, false);
});

test('floating editor supports drag, cancel, keyboard sizing, maximize/restore and viewport bounds', async t => {
  const { nodes } = setup(t, false), pane = nodes.get('fileEditor'), handle = nodes.get('editorDragHandle');
  const maximize = nodes.get('editorMaximize'), reset = nodes.get('editorResetWindow'), corner = nodes.get('editorResizese');
  const floating = createEditorWindow({ pane, handle, maximize, reset, resizeHandles: [corner] });
  floating.show();
  const initial = { ...pane.style };
  await handle.fire('pointerdown', { pointerId: 1, button: 0, clientX: 600, clientY: 75 });
  await handle.fire('pointermove', { pointerId: 1, clientX: 300, clientY: 120 });
  assert.equal(parseFloat(pane.style.left), parseFloat(initial.left) - 300);
  await document.fire('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(pane.style.left, initial.left); assert.equal(handle.captured, null);
  await handle.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(parseFloat(pane.style.left), parseFloat(initial.left) - 10);
  await handle.fire('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.equal(parseFloat(pane.style.width), parseFloat(initial.width) - 10);
  await reset.fire('click'); assert.equal(pane.style.left, initial.left);
  await handle.fire('pointerdown', { pointerId: 2, button: 0, clientX: 600, clientY: 75, target: { closest: () => maximize } });
  await handle.fire('pointermove', { pointerId: 2, clientX: 20, clientY: 20 });
  assert.equal(pane.style.left, initial.left, 'window controls do not start dragging');
  await corner.fire('pointerdown', { pointerId: 3, button: 0, clientX: 900, clientY: 600 });
  await corner.fire('pointermove', { pointerId: 3, clientX: 810, clientY: 490 });
  await corner.fire('pointerup', { pointerId: 3 });
  assert.equal(parseFloat(pane.style.width), parseFloat(initial.width) - 90);
  const resizedWidth = pane.style.width;
  await handle.fire('dblclick'); assert.equal(maximize.attributes['aria-pressed'], 'true'); assert.equal(pane.style.left, '8px');
  // The pointer events generated before dblclick must not prematurely restore.
  await handle.fire('pointerdown', { pointerId: 4, button: 0, clientX: 600, clientY: 25 });
  await handle.fire('pointerup', { pointerId: 4 });
  assert.equal(maximize.attributes['aria-pressed'], 'true');
  await handle.fire('dblclick'); assert.equal(pane.style.width, resizedWidth);
  await maximize.fire('click');
  await handle.fire('pointerdown', { pointerId: 5, button: 0, clientX: 600, clientY: 25 });
  await handle.fire('pointermove', { pointerId: 5, clientX: 610, clientY: 65 });
  await handle.fire('pointerup', { pointerId: 5 });
  assert.equal(maximize.attributes['aria-pressed'], 'false'); assert.equal(pane.style.width, resizedWidth);
  window.innerWidth = 375; window.innerHeight = 560; await window.fire('resize');
  assert.equal(pane.style.left, '8px'); assert.equal(pane.style.width, '359px');
  assert.ok(parseFloat(pane.style.top) + parseFloat(pane.style.height) <= 552);
});

test('editor protects all dirty tabs while switching freely, closing one, reloading and exiting', async t => {
  const { nodes, editor } = editorSetup(t);
  await editor.open({ cwd: '/project', path: 'sample.txt' });
  nodes.get('fileEditorText').value = 'local draft'; await nodes.get('fileEditorText').fire('input');
  const unload = { prevented: false, preventDefault() { this.prevented = true; } };
  await window.fire('beforeunload', unload); assert.equal(unload.prevented, true);
  const closing = editor.close(); assert.equal(nodes.get('unsavedDialog').open, true);
  await nodes.get('cancelFileChange').fire('click'); assert.equal(await closing, false);
  assert.equal(nodes.get('fileEditorText').value, 'local draft');
  assert.equal(await editor.open({ cwd: '/project', path: 'other.txt' }), true);
  assert.equal(nodes.get('unsavedDialog').open, false, 'switching never discards or prompts');
  assert.equal(nodes.get('editorFilename').textContent, 'other.txt');
  nodes.get('fileEditorText').value = 'new draft'; await nodes.get('fileEditorText').fire('input');
  const reloading = nodes.get('editorReload').fire('click');
  await nodes.get('unsavedDialog').fire('cancel'); await reloading;
  assert.equal(nodes.get('fileEditorText').value, 'new draft');
  const saveAndClose = editor.closeTab(); await nodes.get('saveBeforeLeave').fire('click');
  assert.equal(await saveAndClose, true); assert.equal(editor.visible, true);
  assert.equal(nodes.get('fileEditorText').value, 'local draft');
  const closeAll = editor.close(); await nodes.get('saveBeforeLeave').fire('click');
  assert.equal(await closeAll, true); assert.equal(editor.visible, false);
});

test('editor preserves newer typing during save and dirty drafts across project changes and read errors', async t => {
  let finish;
  const { nodes, editor } = editorSetup(t, async (route, body, disk) => {
    if (body) return new Promise(resolve => { finish = () => resolve({ ...disk, content: body.content, version: 'b'.repeat(64) }); });
    if (route.includes('missing')) throw new Error('读取失败');
    return { ...disk };
  });
  await editor.open({ cwd: '/project', path: 'sample.txt' });
  nodes.get('fileEditorText').value = 'first edit'; await nodes.get('fileEditorText').fire('input');
  const saving = editor.save();
  assert.equal(nodes.get('fileEditorText').readOnly, false);
  nodes.get('fileEditorText').value = 'newer edit'; await nodes.get('fileEditorText').fire('input');
  finish(); assert.equal(await saving, false); assert.equal(editor.dirty, true);
  assert.equal(nodes.get('fileEditorText').value, 'newer edit');
  editor.setProject('/other'); assert.equal(nodes.get('editorSave').disabled, true); assert.equal(editor.current, null); assert.equal(editor.visible, false); assert.equal(editor.dirty, true);
  editor.setProject('/project'); assert.equal(nodes.get('editorSave').disabled, false);
  assert.equal(await editor.open({ cwd: '/project', path: 'missing.txt' }), false);
  assert.match(nodes.get('fileEditorError').textContent, /读取失败/);
  await editor.open({ cwd: '/project', path: 'sample.txt' });
  assert.equal(nodes.get('fileEditorText').value, 'newer edit', 'failed file read never touches another tab');
});

test('editor handles save conflicts without overwriting or discarding edits and explicitly loads comparison', async t => {
  let reads = 0;
  const { nodes, editor } = editorSetup(t, async (route, body, disk) => {
    if (body) throw Object.assign(new Error('外部修改'), { status: 409 });
    return ++reads > 1 ? { ...disk, content: 'external version', version: 'c'.repeat(64) } : { ...disk };
  });
  await editor.open({ cwd: '/project', path: 'sample.txt' });
  nodes.get('fileEditorText').value = 'my unsaved version'; await nodes.get('fileEditorText').fire('input');
  assert.equal(await editor.save(), false); assert.equal(nodes.get('fileConflict').hidden, false);
  await nodes.get('compareFileVersions').fire('click');
  assert.equal(nodes.get('localFileVersion').value, 'my unsaved version'); assert.equal(nodes.get('diskFileVersion').value, 'external version');
  const loadingDisk = nodes.get('loadDiskVersion').fire('click');
  assert.equal(nodes.get('unsavedDialog').open, true);
  await nodes.get('discardFileChanges').fire('click'); await loadingDisk;
  assert.equal(nodes.get('fileEditorText').value, 'external version'); assert.equal(editor.dirty, false);
});

test('file tabs keep separate buffers, selection, language and scroll; duplicate opens do not reread', async t => {
  const { nodes, editor, requests } = editorSetup(t, async (route, body, disk) => ({ ...disk, path: body?.path || new URL(route, 'http://localhost').searchParams.get('path'), content: body?.content || 'original\nsecond\nthird' }));
  await editor.open({ cwd: '/project', path: 'one/query.sql' });
  const first = nodes.get('fileEditorText'); first.value = 'SELECT 1;\n-- unsaved'; first.setSelectionRange(3, 8); first.scrollTop = 80; first.scrollLeft = 32; await first.fire('input');
  nodes.get('editorLanguage').value = 'python'; await nodes.get('editorLanguage').fire('change');
  await editor.open({ cwd: '/project', path: 'two/query.sql' });
  const second = nodes.get('fileEditorText'); second.value = 'SELECT 2;'; await second.fire('input');
  assert.notEqual(first, second, 'native editing and undo buffers are not shared');
  assert.equal(editor.tabs.length, 2); assert.ok(editor.tabs.every(tab => tab.dirty));
  assert.equal(nodes.get('editorTabs').children[0].children[0].children[1].textContent, 'one');
  const requestCount = requests.length;
  await editor.open({ cwd: '/project', path: 'one/query.sql' });
  assert.equal(requests.length, requestCount); assert.equal(nodes.get('fileEditorText'), first);
  assert.equal(first.value, 'SELECT 1;\n-- unsaved'); assert.equal(first.selectionStart, 3); assert.equal(first.selectionEnd, 8);
  assert.equal(first.scrollTop, 80); assert.equal(first.scrollLeft, 32); assert.equal(nodes.get('editorLanguage').value, 'python');
  await editor.save(); assert.equal(requests.at(-1).body.path, 'one/query.sql');
  await document.fire('keydown', { key: 'PageDown', ctrlKey: true, preventDefault() {} });
  assert.equal(nodes.get('fileEditorText'), second); assert.equal(nodes.get('editorLanguage').value, 'auto');
  await nodes.get('editorTabs').children[1].children[0].fire('keydown', { key: 'Home' });
  assert.equal(nodes.get('fileEditorText'), first);
});

test('late reads and saves stay with their file, and closing a loading tab ignores its result', async t => {
  const pending = new Map();
  const { nodes, editor } = editorSetup(t, (route, body, disk) => {
    const path = body?.path || new URL(route, 'http://localhost').searchParams.get('path');
    if (body || path === 'slow.py') return new Promise(resolve => pending.set(body ? 'save' : 'read', () => resolve({ ...disk, path, content: body?.content || 'slow result' })));
    return { ...disk, path };
  });
  const slow = editor.open({ cwd: '/project', path: 'slow.py' });
  await editor.open({ cwd: '/project', path: 'fast.sql' });
  const fast = nodes.get('fileEditorText'); fast.value = 'new fast'; await fast.fire('input');
  pending.get('read')(); await slow;
  assert.equal(nodes.get('fileEditorText'), fast); assert.equal(fast.value, 'new fast');
  const saving = editor.save();
  fast.value = 'even newer fast'; await fast.fire('input');
  await editor.open({ cwd: '/project', path: 'slow.py' });
  assert.equal(nodes.get('fileEditorText').value, 'slow result');
  pending.get('save')(); assert.equal(await saving, false);
  assert.equal(nodes.get('fileEditorText').value, 'slow result');
  assert.equal(editor.tabs.find(tab => tab.path === 'fast.sql').dirty, true);
  await editor.closeTab();
  const loading = editor.open({ cwd: '/project', path: 'slow.py' });
  assert.equal(await editor.closeTab(), true);
  pending.get('read')(); assert.equal(await loading, false);
  assert.equal(editor.tabs.length, 1); assert.equal(nodes.get('fileEditorText'), fast);
});

test('canceling close-all preserves drafts already marked discard; save-all stops at the conflicting file', async t => {
  const writes = [];
  const { nodes, editor } = editorSetup(t, async (route, body, disk) => {
    const path = body?.path || new URL(route, 'http://localhost').searchParams.get('path');
    if (body) { writes.push(body); if (path === 'b.py') throw Object.assign(new Error('b conflict'), { status: 409 }); }
    return { ...disk, path, content: body?.content || 'original' };
  });
  for (const path of ['a.sql', 'b.py', 'c.sql']) {
    await editor.open({ cwd: '/project', path }); nodes.get('fileEditorText').value = `draft ${path}`; await nodes.get('fileEditorText').fire('input');
  }
  const closing = editor.close();
  await nodes.get('discardFileChanges').fire('click'); await new Promise(setImmediate);
  assert.match(nodes.get('unsavedFilename').textContent, /b.py/);
  await nodes.get('cancelFileChange').fire('click'); assert.equal(await closing, false);
  assert.equal(editor.tabs.length, 3); assert.ok(editor.tabs.every(tab => tab.dirty));
  assert.equal(await editor.saveAll(), false);
  assert.deepEqual(writes.map(item => item.path), ['a.sql', 'b.py']);
  assert.equal(editor.tabs.find(tab => tab.path === 'a.sql').dirty, false);
  assert.equal(editor.tabs.find(tab => tab.path === 'c.sql').dirty, true);
  assert.equal(nodes.get('editorFilename').textContent, 'b.py'); assert.equal(nodes.get('fileConflict').hidden, false);
  await editor.open({ cwd: '/project', path: 'a.sql' });
  assert.equal(nodes.get('fileConflict').hidden, true, 'errors belong to their own tab');
  const unload = { preventDefault() { this.blocked = true; } }; await window.fire('beforeunload', unload);
  assert.equal(unload.blocked, true, 'background dirty tabs also protect browser exit');
});

test('canonical paths deduplicate without losing existing edits and clean inactive tabs close independently', async t => {
  const { nodes, editor } = editorSetup(t, async (route, body, disk) => ({ ...disk, path: body?.path || new URL(route, 'http://localhost').searchParams.get('path') }));
  await editor.open({ cwd: '/project', path: 'same.sql' });
  const first = nodes.get('fileEditorText'); first.value = 'keep me'; await first.fire('input');
  await editor.open({ cwd: '/project-alias', path: 'same.sql' });
  assert.equal(editor.tabs.length, 1); assert.equal(nodes.get('fileEditorText'), first); assert.equal(first.value, 'keep me');
  await editor.open({ cwd: '/project', path: 'clean.py' });
  const cleanId = editor.tabs.find(tab => tab.path === 'clean.py').id;
  await editor.open({ cwd: '/project', path: 'same.sql' });
  assert.equal(await editor.closeTab(cleanId), true); assert.equal(nodes.get('fileEditorText'), first);
  editor.setProject('/different'); assert.equal(first.readOnly, true);
  assert.equal(editor.current, null); assert.equal(await editor.closeTab(), false); assert.equal(editor.tabs.length, 1);
  editor.setProject('/project'); assert.equal(nodes.get('fileEditorText'), first); assert.equal(first.value, 'keep me');
  const closing = editor.closeTab(); assert.equal(nodes.get('saveBeforeLeave').disabled, false);
  await nodes.get('cancelFileChange').fire('click'); assert.equal(await closing, false);
});

test('catalog tabs, cross-category search, and keyboard completion preserve chosen tools', async t => {
  const { nodes, controller } = setup(t);
  await nodes.get('addButton').fire('click'); await new Promise(setImmediate);
  await nodes.get('pluginsTab').fire('keydown', { key: 'ArrowRight' });
  assert.equal(nodes.get('skillsPanel').hidden, false);
  assert.equal(nodes.get('pluginsPanel').hidden, true);
  await nodes.get('skillMenu').children[0].fire('click');
  assert.deepEqual(controller.payload().capabilities, ['review@local']);
  nodes.get('capabilitySearch').value = 'PDF'; await nodes.get('capabilitySearch').fire('input');
  assert.equal(nodes.get('pluginsPanel').hidden, false);
  assert.equal(nodes.get('pluginMenu').children[0].children[1].children[0].textContent, 'PDF');
  let prevented = false;
  await nodes.get('capabilitySearch').fire('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'search Enter never submits chat');
  await nodes.get('closeTools').fire('click');
  assert.equal(nodes.get('addMenu').hidden, true);
  assert.equal(document.activeElement, nodes.get('prompt'));
});

test('composer drafts restore attachments, selected tools, plans and effort without cross-thread leakage', async t => {
  const { controller } = setup(t);
  controller.setModels([{ id: 'model', isDefault: true, efforts: [{ reasoningEffort: 'high' }] }]);
  const draft = { files: [{ id: 'file-1', name: 'draft.txt', kind: 'file' }], chosen: [['pdf@local', { key: 'pdf@local', title: 'PDF' }]], plan: true, draftGoal: { objective: 'Draft goal' }, effort: 'high' };
  controller.restoreDraft(draft);
  const snapshot = controller.snapshot();
  controller.restore({ plan: false, effort: '' });
  assert.deepEqual(controller.payload(), { effort: '', plan: false, attachments: [], capabilities: [] });
  controller.restoreDraft(snapshot);
  assert.deepEqual(controller.payload(), { effort: 'high', plan: true, attachments: ['file-1'], capabilities: ['pdf@local'], goal: { objective: 'Draft goal' } });
  controller.reset();
  assert.deepEqual(snapshot.files, draft.files, 'reset does not mutate saved draft');
});

test('page-local drafts are isolated by project and thread, and cloned on both boundaries', () => {
  const store = createDraftStore(); const draft = { text: 'draft', context: { files: ['a'] } };
  store.save('/one', null, draft); draft.context.files.push('b');
  assert.equal(store.read('/two', null), null); assert.equal(store.read('/one', 'thread'), null);
  const restored = store.read('/one', null); restored.context.files.push('c');
  assert.deepEqual(store.read('/one', null).context.files, ['a']);
  store.clear('/one', null); assert.equal(store.read('/one', null), null);
});

test('popovers remain anchored and inside desktop, mobile and short viewports', () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 480 }]) {
    for (const top of [40, viewport.height - 80]) {
      const anchor = { top, bottom: top + 34, left: viewport.width - 80 };
      const result = popupLayout(anchor, viewport, 380, 580);
      assert.ok(result.left >= 12); assert.ok(result.left + result.width <= viewport.width - 12);
      assert.ok(result.top >= 12); assert.ok(result.top + Math.min(580, result.maxHeight) <= viewport.height - 12);
      assert.ok(result.maxHeight >= 0);
    }
  }
});

test('permission picker requires affirmative full-access consent and forgets it on thread change', async t => {
  const { nodes } = setup(t); const notices = [];
  const control = createPermissionControl({ onChange() {}, notice: message => notices.push(message) });
  control.setAvailability({ options: ['workspace-write', 'auto-review', 'danger-full-access', 'read-only'].map(id => ({ id, enabled: true })) });
  const rows = nodes.get('permissionOptions').children;
  await nodes.get('permissionButton').fire('click');
  assert.equal(nodes.get('permissionMenu').hidden, false);
  assert.equal(globalThis.document.activeElement, rows[0]);
  await nodes.get('permissionOptions').fire('keydown', { key: 'ArrowDown' });
  assert.equal(globalThis.document.activeElement, rows[1]);
  await rows[1].fire('click');
  assert.equal(control.payload().mode, 'auto-review');
  await rows[2].fire('click');
  assert.equal(nodes.get('fullAccessDialog').open, true);
  assert.equal(control.payload().mode, 'auto-review');
  await nodes.get('fullAccessForm').fire('submit');
  assert.equal(control.payload().fullAccessConfirmed, false);
  await nodes.get('cancelFullAccess').fire('click');
  assert.equal(nodes.get('fullAccessDialog').open, false);
  assert.equal(control.payload().mode, 'auto-review');
  await rows[2].fire('click');
  nodes.get('fullAccessAcknowledged').checked = true;
  await nodes.get('fullAccessAcknowledged').fire('change');
  assert.equal(nodes.get('confirmFullAccess').disabled, false);
  await nodes.get('fullAccessForm').fire('submit');
  assert.deepEqual(control.payload(), { mode: 'danger-full-access', fullAccessConfirmed: true });
  assert.equal(nodes.get('fullAccessNotice').hidden, false);
  control.restore({ mode: 'danger-full-access' });
  assert.equal(control.payload().mode, 'workspace-write');
  assert.equal(control.payload().fullAccessConfirmed, false);
  assert.match(notices[0], /重新选择并确认/);
  control.reset(); assert.equal(nodes.get('fullAccessNotice').hidden, true);
});

test('permission picker respects policy, busy state, and explicit plan-mode lock', async t => {
  const { nodes } = setup(t);
  const control = createPermissionControl({ onChange() {}, notice() {} });
  control.setAvailability({ options: [{ id: 'workspace-write', enabled: true }, { id: 'auto-review', enabled: false, reason: 'Blocked by policy' }, { id: 'danger-full-access', enabled: true }] });
  const rows = nodes.get('permissionOptions').children;
  assert.equal(rows[1].disabled, true);
  assert.equal(rows[1].querySelector('small').textContent, 'Blocked by policy');
  await rows[1].fire('click'); assert.equal(control.payload().mode, 'workspace-write');
  control.setBusy(true); await rows[2].fire('click'); assert.ok(!nodes.get('fullAccessDialog').open);
  control.setBusy(false, true);
  assert.equal(nodes.get('permissionButton').disabled, true);
  assert.equal(nodes.get('permissionLabel').textContent, '只读 · 计划模式');
  control.setBusy(false, false); assert.equal(nodes.get('permissionButton').disabled, false);
});

test('new-thread goals stay drafts until send; existing goals pause and clear via API', async t => {
  const { nodes, controller, calls, context } = setup(t);
  nodes.get('goalObjective').value = 'Finish feature'; nodes.get('goalBudget').value = '2000';
  await nodes.get('goalForm').fire('submit');
  assert.deepEqual(controller.payload().goal, { objective: 'Finish feature', tokenBudget: 2000 });
  assert.equal(calls.length, 0);
  context.thread = { id: 'test-thread', goal: { objective: 'Finish feature', status: 'active' } };
  controller.restore(context.thread);
  await nodes.get('pauseGoal').fire('click');
  assert.equal(context.thread.goal.status, 'paused');
  assert.equal(calls.at(-1).body.status, 'paused');
  await nodes.get('clearGoal').fire('click');
  assert.equal(context.thread.goal, null);
  assert.equal(nodes.get('goalBanner').hidden, true);
  await nodes.get('recordSkill').fire('click');
  assert.equal(nodes.get('recordingDialog').open, true);
});
