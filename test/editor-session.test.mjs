import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createFileEditor, normalizeEditorSession } from '../public/file-editor.js';

const key = 'lemon:openFiles:v1';
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const settle = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('editor did not settle'); };
function browser(t, initial, api) {
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'http://localhost', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom, document = window.document;
  const previous = Object.fromEntries(['window', 'document', 'localStorage'].map(name => [name, globalThis[name]]));
  Object.assign(globalThis, { window, document, localStorage: window.localStorage });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  if (initial) window.localStorage.setItem(key, initial);
  const editor = createFileEditor({ api, onAttach() {} }), $ = id => document.getElementById(id);
  const flush = () => { window.dispatchEvent(new window.Event('pagehide')); return window.localStorage.getItem(key); };
  let closed = false;
  const close = () => { if (closed) return; closed = true; dom.window.close(); Object.assign(globalThis, previous); assert.deepEqual(errors, []); };
  t.after(close);
  return { editor, $, window, document, flush, close };
}
function mockFiles() {
  const calls = [], contents = new Map();
  return { calls, contents, api: async (route, body) => {
    assert.equal(body, undefined, 'restoring navigation never writes or executes anything');
    const url = new URL(route, 'http://localhost'), cwd = url.searchParams.get('cwd'), path = url.searchParams.get('path');
    assert.equal(url.pathname, '/api/project/file'); calls.push([cwd, path]);
    return { cwd, path, content: contents.get(cwd + '/' + path) || 'disk version\n'.repeat(100), version: 'v1', writable: true, newline: 'LF' };
  } };
}

test('refresh restores ordered project tabs and positions, reads fresh disk lazily, and never resurrects closed tabs', async t => {
  const files = mockFiles();
  let page = browser(t, null, files.api), editor = page.editor;
  editor.setProject('/one');
  await editor.open({ cwd: '/one', path: 'a.sql' });
  await editor.open({ cwd: '/one', path: 'b.py' });
  await editor.open({ cwd: '/one', path: 'a.sql' });
  page.$('fileEditorText').setSelectionRange(8, 15, 'backward');
  page.$('fileEditorText').scrollTop = 88; page.$('fileEditorText').scrollLeft = 24;
  page.$('editorLanguage').value = 'text'; page.$('editorLanguage').dispatchEvent(new page.window.Event('change'));
  editor.setProject('/two'); await editor.open({ cwd: '/two', path: 'a.sql' }); editor.hide(); editor.setProject('/one');
  let stored = page.flush();
  assert.deepEqual(JSON.parse(stored).files.map(file => [file.cwd, file.path]), [['/one', 'a.sql'], ['/one', 'b.py'], ['/two', 'a.sql']]);
  assert.doesNotMatch(stored, /disk version|content|baseline|version.*v1/);
  page.close();
  files.calls.length = 0; files.contents.set('/one/a.sql', 'fresh disk version\n'.repeat(100));
  page = browser(t, stored, files.api); editor = page.editor;
  assert.equal(files.calls.length, 0); assert.equal(editor.tabs.length, 3);
  editor.setProject('/one'); await settle(() => editor.current && !editor.current.loading);
  assert.deepEqual(files.calls, [['/one', 'a.sql']], 'only the selected file loads on startup');
  assert.equal(editor.current.path, 'a.sql'); assert.match(editor.current.content, /^fresh disk/);
  assert.equal(editor.current.start, 8); assert.equal(editor.current.end, 15); assert.equal(page.$('fileEditorText').selectionDirection, 'backward');
  assert.equal(page.$('fileEditorText').scrollTop, 88); assert.equal(page.$('fileEditorText').scrollLeft, 24); assert.equal(editor.current.language, 'text');
  editor.setProject('/two'); await settle(() => editor.current?.cwd === '/two'); assert.equal(editor.visible, false, 'a deliberately hidden editor stays hidden');
  await editor.open({ cwd: '/two', path: 'a.sql' }); await editor.close();
  editor.setProject('/one'); await editor.closeTab(editor.tabs.find(tab => tab.path === 'b.py').id);
  stored = page.flush(); assert.deepEqual(JSON.parse(stored).files.map(file => [file.cwd, file.path]), [['/one', 'a.sql']]);
  page.close(); page = browser(t, stored, files.api); page.editor.setProject('/one');
  await settle(() => page.editor.current); assert.equal(page.editor.tabs.length, 1); assert.equal(page.editor.current.path, 'a.sql');
});

test('failed or late restored reads retain useful tabs without taking over a newer selection', async t => {
  const initial = JSON.stringify({ version: 1, files: [{ cwd: '/one', path: 'slow.txt' }, { cwd: '/one', path: 'good.txt' }, { cwd: '/one', path: 'missing.txt' }], projects: [{ cwd: '/one', active: 'slow.txt', visible: true }] });
  let finish;
  const page = browser(t, initial, async route => {
    const url = new URL(route, 'http://localhost'), path = url.searchParams.get('path');
    if (path === 'missing.txt') throw new Error('文件已移动或不存在');
    const file = { cwd: '/one', path, content: 'disk', version: 'v1', writable: true };
    return path === 'slow.txt' ? new Promise(resolve => { finish = () => resolve(file); }) : file;
  });
  const { editor, $ } = page; editor.setProject('/one'); await settle(() => finish);
  await editor.open({ cwd: '/one', path: 'good.txt' });
  await editor.closeTab(editor.tabs.find(tab => tab.path === 'slow.txt').id); finish(); await new Promise(setImmediate);
  assert.equal(editor.current.path, 'good.txt'); assert.equal(editor.tabs.length, 2);
  assert.equal(await editor.open({ cwd: '/one', path: 'missing.txt' }), false);
  assert.equal(editor.tabs.length, 2); assert.match($('fileEditorError').textContent, /不存在/);
  await editor.open({ cwd: '/one', path: 'good.txt' }); assert.equal(editor.current.path, 'good.txt');
  assert.ok(!JSON.parse(page.flush()).files.some(file => file.path === 'slow.txt'));
});

test('session records whitelist navigation, sanitize malformed positions and keep PDF and worksheet reading locations', () => {
  const result = normalizeEditorSession({ version: 1, files: [null, { cwd: '/one', path: '../private.txt' }, { cwd: 'relative', path: 'a' }, { cwd: '/one', path: 'book.xlsx', content: 'private text', baseline: 'private', token: 'secret', start: -5, end: Infinity, preview: { sheet: 2, sheets: { 2: { page: 3, top: 240, left: 18, query: 'sensitive filter', filters: [{ value: 'secret' }] } } } }, { cwd: '/one', path: 'report.pdf', preview: { page: 7, zoom: '1.5', top: 320, query: 'private words' } }], projects: [{ cwd: '/one', active: '../bad', visible: false }] });
  assert.equal(result.files.length, 2); assert.equal(result.files[0].start, 0); assert.equal(result.files[0].end, 0);
  assert.equal(result.files[0].preview.sheet, 2); assert.deepEqual(result.files[0].preview.sheets['2'], { page: 3, top: 240, left: 18 });
  assert.equal(result.files[1].preview.page, 7); assert.equal(result.files[1].preview.zoom, '1.5');
  assert.equal(result.projects[0].active, null); assert.doesNotMatch(JSON.stringify(result), /private|secret|sensitive|token|baseline|content/);
  assert.deepEqual(normalizeEditorSession({ files: [] }).files, []);
});

test('cross-project references keep separate read-only tabs and preserve the owning project draft', async t => {
  const files = mockFiles(), page = browser(t, null, files.api), { editor, $ } = page;
  editor.setProject('/two'); await editor.open({ cwd: '/two', path: 'a.sql' });
  $('fileEditorText').value = 'unsaved owner draft'; $('fileEditorText').dispatchEvent(new page.window.Event('input'));
  const ownerId = editor.current.id;
  editor.setProject('/one'); await editor.open({ cwd: '/one', path: 'a.sql' });
  const entry = { cwd: '/two', path: 'a.sql', viewCwd: '/one' };
  await editor.open(entry);
  assert.equal(editor.visible, true); assert.equal(editor.current.cwd, '/two'); assert.equal(editor.cwd, '/one');
  assert.notEqual(editor.current.id, ownerId); assert.match(editor.current.content, /^disk version/);
  assert.equal(editor.current.external, true); assert.equal(editor.current.writable, false); assert.equal($('fileEditorText').readOnly, true);
  assert.match($('editorStatus').textContent, /其他项目.*只读/); assert.equal($('editorAttach').disabled, true);
  assert.equal(await editor.save(), false); assert.equal(await editor.saveFile(entry), false);
  assert.equal(editor.snapshots().length, 1); assert.equal(editor.snapshots()[0].content, 'unsaved owner draft');
  const id = editor.current.id; await editor.open(entry); assert.equal(editor.current.id, id, 'repeated clicks reuse the reference');
  await editor.closeTab(); assert.equal(editor.current.cwd, '/one');
  editor.setProject('/two'); assert.equal(editor.current.id, ownerId); assert.equal(editor.current.content, 'unsaved owner draft');
  assert.equal(editor.current.writable, true); assert.equal($('fileEditorText').readOnly, false);
  assert.equal(editor.inspect({ cwd: '/two', path: 'a.sql' }).content, 'unsaved owner draft');
});

test('refresh restores the exact cross-project tab even when several projects use the same file name', async t => {
  const files = mockFiles(); let page = browser(t, null, files.api);
  page.editor.setProject('/one'); await page.editor.open({ cwd: '/one', path: 'a.sql' });
  await page.editor.open({ cwd: '/two', path: 'a.sql', viewCwd: '/one' });
  page.$('fileEditorText').setSelectionRange(4, 7);
  const stored = page.flush(); assert.doesNotMatch(stored, /disk version|content|baseline/); page.close();
  files.calls.length = 0; page = browser(t, stored, files.api); page.editor.setProject('/one');
  await settle(() => page.editor.current?.cwd === '/two');
  assert.equal(page.editor.current.external, true); assert.equal(page.editor.current.writable, false);
  assert.equal(page.editor.current.start, 4); assert.equal(page.editor.current.end, 7);
  assert.deepEqual(files.calls, [['/two', 'a.sql']]);
  assert.equal(page.$('editorTabs').querySelectorAll('[role=tab]').length, 2);
  await page.editor.closeTab(); const next = page.flush(); page.close();
  page = browser(t, next, files.api); page.editor.setProject('/one'); await settle(() => page.editor.current?.cwd === '/one');
  assert.equal(page.editor.tabs.length, 1, 'closing a reference does not resurrect it after refresh');
});
