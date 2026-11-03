import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFileManager } from '../public/workbench.js';

async function fixture(t) {
  const dom = new JSDOM('<section id="manager"></section>', { url: 'http://localhost', pretendToBeVisual: true });
  const previous = Object.fromEntries(['window', 'document', 'confirm'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, confirm: () => true });
  t.after(() => { dom.window.close(); Object.assign(globalThis, previous); });
  let cwd = '/project', readGate, writeGate, failure, visible = true;
  const root = document.getElementById('manager'), files = new Map([['nested/original.sql', 'fictional text'], ['root.txt', 'example']]), folders = new Set(['nested', 'destination', 'destination/child']);
  const calls = [], opened = [], previews = [], editor = { tabs: [] }; let refreshed = 0;
  const list = folder => {
    const result = new Map(), prefix = folder ? folder + '/' : '';
    for (const [path, kind] of [...folders].map(path => [path, 'folder']).concat([...files.keys()].map(path => [path, 'file']))) {
      if (!path.startsWith(prefix)) continue;
      const tail = path.slice(prefix.length); if (!tail || tail.includes('/')) continue;
      result.set(path, { name: tail, path, kind });
    }
    return [...result.values()];
  };
  const manager = createFileManager({ root, getContext: () => ({ cwd }), editor, isVisible: () => visible,
    openFile: entry => { opened.push(entry); }, previewFile: entry => { previews.push(entry); }, refreshFiles: () => { refreshed++; },
    api: async (route, body) => {
      calls.push({ route, body }); const url = new URL(route, 'http://localhost');
      if (url.pathname === '/api/project/files') return { cwd, entries: list(url.searchParams.get('path') || ''), nextOffset: null };
      if (url.pathname === '/api/project/file') { if (readGate) await readGate; return { version: 'a'.repeat(64) }; }
      if (body) {
        if (writeGate) await writeGate;
        if (failure) throw failure;
        if (body.action === 'move') {
          if (files.has(body.target)) throw new Error('目标已存在，未覆盖。');
          files.set(body.target, files.get(body.path)); files.delete(body.path);
        } else if (body.action === 'createFile') files.set(body.path, '');
        else if (body.action === 'createFolder') folders.add(body.path);
        else if (body.action === 'trash') files.delete(body.path);
        return { path: body.target || body.path, recovery: body.action === 'move' || body.action === 'trash' ? '/mock-trash/recoverable-file.sql' : undefined };
      }
      throw new Error('Unexpected route: ' + route);
    },
  });
  const $ = id => root.querySelector('#' + id), rows = () => [...$('manageList').querySelectorAll('[data-path]')], row = path => rows().find(node => node.dataset.path === path);
  const submit = () => $('manageNameForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const key = (target, name, options = {}) => { const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: name, ...options }); target.dispatchEvent(event); return event; };
  const settle = async condition => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setImmediate(resolve)); } assert.fail('File manager did not settle: ' + $('manageNotice').textContent); };
  await manager.show({ cwd, path: 'nested/original.sql', kind: 'file' });
  return { $, manager, root, files, folders, calls, opened, previews, editor, row, rows, submit, key, settle, get refreshed() { return refreshed; },
    setProject(value) { cwd = value; manager.reset(); }, setVisible(value) { visible = value; if (!value) manager.hide(); }, setReadGate(value) { readGate = value; }, setWriteGate(value) { writeGate = value; }, fail(error) { failure = error; } };
}

test('Return renames only the basename, preserves the extension selection and writes once through the existing API', async t => {
  const f = await fixture(t); f.row('nested/original.sql').click();
  f.key(f.row('nested/original.sql'), 'Enter');
  assert.equal(f.$('manageNameForm').hidden, false); assert.equal(f.$('manageNewName').value, 'original.sql'); assert.equal(f.$('manageNewName').selectionEnd, 8);
  f.$('manageNewName').value = 'new-name.sql'; f.submit(); await f.settle(() => !f.manager.pending);
  const writes = f.calls.filter(call => call.body); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { cwd: '/project', path: 'nested/original.sql', action: 'move', target: 'nested/new-name.sql', version: 'a'.repeat(64), confirmed: true });
  assert.equal(f.files.get('nested/new-name.sql'), 'fictional text'); assert.equal(f.$('manageNotice').textContent, '名称已更新。');
  assert.equal(f.$('manageRecovery').hidden, false); assert.equal(f.$('manageRecovery').closest('details').open, false); assert.equal(f.refreshed, 1);
});

test('move browses real destination folders and only mutates after the explicit move button; cancel restores the source folder', async t => {
  const f = await fixture(t); f.$('manageMove').click(); await f.settle(() => !f.$('manageUp').disabled);
  assert.equal(f.$('manageMoveBanner').hidden, false); assert.equal(f.$('manageMoveApply').disabled, true); assert.equal(f.calls.filter(call => call.body).length, 0);
  f.$('manageUp').click(); await f.settle(() => !!f.row('destination'));
  assert.ok(f.rows().every(row => row.dataset.path !== 'root.txt'));
  f.row('destination').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })); await f.settle(() => f.$('manageDestination').textContent === '目标：destination' && !f.$('manageMoveApply').disabled);
  f.$('manageMoveApply').click(); await f.settle(() => !f.manager.pending);
  assert.equal(f.calls.filter(call => call.body).length, 1); assert.equal(f.files.get('destination/original.sql'), 'fictional text');
  assert.equal(f.$('manageSelection').textContent, 'original.sql'); assert.equal(f.$('manageMoveBanner').hidden, true);
  f.$('manageMove').click(); await f.settle(() => !f.manager.pending && !f.$('manageMoveCancel').disabled); f.$('manageMoveCancel').click();
  await f.settle(() => f.$('manageMoveBanner').hidden); assert.equal(f.calls.filter(call => call.body).length, 1);
  await f.manager.show({ cwd: '/project', path: 'root.txt', kind: 'file' }); f.$('manageMove').click();
  await f.settle(() => !!f.row('destination'));
  f.row('destination').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  await f.settle(() => f.$('manageDestination').textContent === '目标：destination' && !f.$('manageMoveApply').disabled);
  f.$('manageMoveCancel').click(); await f.settle(() => !!f.row('root.txt'));
  assert.equal(f.$('manageUp').disabled, true); assert.equal(f.$('manageSelection').textContent, 'root.txt'); assert.equal(f.calls.filter(call => call.body).length, 1);
});

test('creation uses the browsed folder, while Escape cancels without closing the surrounding panel', async t => {
  const f = await fixture(t); f.$('manageCreateFolder').click(); f.$('manageNewName').value = 'reports'; f.submit(); await f.settle(() => !f.manager.pending);
  assert.ok(f.folders.has('nested/reports')); assert.equal(f.$('manageSelection').textContent, 'reports');
  f.$('manageCreateFile').click(); f.$('manageNewName').value = '../escape.sql'; f.submit(); assert.match(f.$('manageNotice').textContent, /路径分隔符/); assert.equal(f.calls.filter(call => call.body).length, 1);
  let bubbled = false; document.body.addEventListener('keydown', () => { bubbled = true; });
  const event = f.key(f.$('manageNewName'), 'Escape'); assert.equal(event.defaultPrevented, true); assert.equal(bubbled, false); assert.equal(f.$('manageNameForm').hidden, true);
  f.$('manageCreateFile').click(); f.$('manageNewName').value = 'notes.sql'; f.submit(); await f.settle(() => !f.manager.pending);
  assert.ok(f.files.has('nested/notes.sql')); assert.deepEqual(f.opened, [{ cwd: '/project', path: 'nested/notes.sql' }]);
});

test('open editor tabs block mutations; failed writes preserve the typed name and repeated submits cannot duplicate a request', async t => {
  const f = await fixture(t); f.editor.tabs.push({ cwd: '/project', path: 'nested/original.sql' });
  f.$('manageRename').click(); f.$('manageNewName').value = 'kept.sql'; f.submit(); await f.settle(() => !f.manager.pending);
  assert.match(f.$('manageNotice').textContent, /关闭/); assert.equal(f.calls.filter(call => call.body).length, 0); assert.equal(f.$('manageNewName').value, 'kept.sql');
  f.editor.tabs.length = 0; let release; f.setWriteGate(new Promise(resolve => { release = resolve; })); f.fail(new Error('目标已存在，未覆盖。'));
  f.submit(); await f.settle(() => f.calls.some(call => call.body)); f.submit(); f.submit(); assert.equal(f.calls.filter(call => call.body).length, 1);
  release(); await f.settle(() => !f.manager.pending); assert.equal(f.$('manageNewName').value, 'kept.sql'); assert.equal(f.$('manageNameForm').hidden, false); assert.match(f.$('manageNotice').textContent, /未覆盖/);
});

test('switching projects during preflight cannot submit an old file operation', async t => {
  const f = await fixture(t); let release; f.setReadGate(new Promise(resolve => { release = resolve; }));
  f.$('manageRename').click(); f.$('manageNewName').value = 'stale.sql'; f.submit();
  f.setProject('/other'); await f.manager.show(); release(); await f.settle(() => !f.manager.pending);
  assert.equal(f.calls.filter(call => call.body).length, 0); assert.equal(f.$('manageNotice').textContent, ''); assert.equal(f.$('manageNameForm').hidden, true);
});

test('closing during preflight cannot commit a move that has not been submitted', async t => {
  const f = await fixture(t); let release; f.setReadGate(new Promise(resolve => { release = resolve; }));
  f.$('manageRename').click(); f.$('manageNewName').value = 'not-applied.sql'; f.submit(); f.setVisible(false);
  release(); await f.settle(() => !f.manager.pending);
  assert.equal(f.calls.filter(call => call.body).length, 0); assert.ok(f.files.has('nested/original.sql'));
});

test('an already submitted operation cannot overwrite a newer file selection when its response arrives', async t => {
  const f = await fixture(t); let release; f.setWriteGate(new Promise(resolve => { release = resolve; }));
  f.$('manageRename').click(); f.$('manageNewName').value = 'completed.sql'; f.submit(); await f.settle(() => f.calls.some(call => call.body));
  await f.manager.show({ cwd: '/project', path: 'root.txt', kind: 'file' }); release(); await f.settle(() => !f.manager.pending);
  assert.equal(f.$('manageSelection').textContent, 'root.txt'); assert.equal(f.$('manageNotice').textContent, ''); assert.ok(f.files.has('nested/completed.sql')); assert.equal(f.refreshed, 1);
});

test('dragging a file to a folder prepares a visible destination without writing immediately', async t => {
  const f = await fixture(t); f.$('manageUp').click(); await f.settle(() => !!f.row('root.txt'));
  const start = new window.Event('dragstart', { bubbles: true }), transfer = { setData() {}, effectAllowed: '', dropEffect: '' }; Object.defineProperty(start, 'dataTransfer', { value: transfer }); f.row('root.txt').dispatchEvent(start);
  const drop = new window.Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: transfer }); f.row('destination').dispatchEvent(drop);
  await f.settle(() => f.$('manageDestination').textContent === '目标：destination' && !f.$('manageMoveApply').disabled);
  assert.match(f.$('manageMoveName').textContent, /root.txt/); assert.equal(f.calls.filter(call => call.body).length, 0);
  f.$('manageMoveApply').click(); await f.settle(() => !f.manager.pending); assert.equal(f.files.get('destination/root.txt'), 'example');
});
