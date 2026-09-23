import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createFileEditor } from '../public/file-editor.js';

async function setup(t) {
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://localhost', pretendToBeVisual: true, virtualConsole });
  const previous = Object.fromEntries(['window', 'document', 'localStorage'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); Object.assign(globalThis, previous); assert.deepEqual(errors, []); });
  const files = new Map([['a.sql', { content: 'SELECT 1;', version: 'v1' }], ['b.sql', { content: 'SELECT 2;', version: 'v2' }]]), calls = [];
  let deferred = null, nextError = null;
  const api = async (route, body) => {
    calls.push({ route, body });
    if (nextError) { const error = nextError; nextError = null; throw error; }
    const url = new URL(route, 'http://localhost'), path = body?.path || url.searchParams.get('path');
    if (route === '/api/project/save') files.set(path, { content: body.content, version: 'saved' });
    const file = { cwd: '/project', path, writable: true, newline: 'LF', ...files.get(path) };
    if (deferred && url.searchParams.has('version')) { const callback = deferred; deferred = null; return new Promise(resolve => callback(() => resolve(file))); }
    return url.searchParams.get('version') === file.version ? { unchanged: true, version: file.version } : file;
  };
  const editor = createFileEditor({ api, onAttach: () => {} }), $ = id => document.getElementById(id);
  const type = text => { $('fileEditorText').value = text; $('fileEditorText').dispatchEvent(new window.Event('input')); };
  return { editor, $, files, calls, type, defer: callback => { deferred = callback; }, fail: error => { nextError = error; } };
}

test('external changes refresh clean buffers and retain cursor, scroll, active file and drafts', async t => {
  const { editor, $, files, calls, type } = await setup(t);
  await editor.open({ cwd: '/project', path: 'a.sql' }); editor.select(4, 6); $('fileEditorText').scrollTop = 44;
  files.set('a.sql', { content: 'SELECT 100;', version: 'v3' }); await editor.refresh();
  assert.equal(editor.current.content, 'SELECT 100;'); assert.equal(editor.current.start, 4); assert.equal(editor.current.end, 6); assert.equal($('fileEditorText').scrollTop, 44);
  assert.equal(editor.dirty, false); assert.equal($('editorStatus').textContent, '已自动同步'); assert.match(calls.at(-1).route, /version=v1/);
  await editor.refresh(); assert.equal(editor.current.content, 'SELECT 100;');
  await editor.open({ cwd: '/project', path: 'b.sql' }); type('SELECT 20;');
  files.set('a.sql', { content: 'SELECT 300;', version: 'v4' }); await editor.refresh({ all: true });
  assert.equal(editor.current.path, 'b.sql'); assert.equal(editor.current.content, 'SELECT 20;');
  assert.equal(editor.inspect({ cwd: '/project', path: 'a.sql' }).content, 'SELECT 300;');
  files.set('b.sql', { content: 'SELECT 900;', version: 'v5' }); await editor.refresh();
  assert.equal(editor.current.content, 'SELECT 20;'); assert.equal(editor.current.version, 'v2'); assert.equal($('fileConflict').hidden, false);
  assert.match($('fileEditorError').textContent, /未保存编辑已保留/);
});

test('auto-sync cannot overwrite typing or a save that began after the version check', async t => {
  const { editor, $, files, type, defer } = await setup(t);
  await editor.open({ cwd: '/project', path: 'a.sql' });
  files.set('a.sql', { content: 'SELECT 500;', version: 'external' });
  let finish; defer(resolve => { finish = resolve; }); const pending = editor.refresh();
  type('SELECT 99;'); finish(); await pending;
  assert.equal(editor.current.content, 'SELECT 99;'); assert.equal(editor.current.version, 'v1'); assert.equal($('fileConflict').hidden, false);
  // A delayed old read must not roll back the baseline of a successful save.
  defer(resolve => { finish = resolve; }); const oldRead = editor.refresh();
  await editor.save(); finish(); await oldRead;
  assert.equal(editor.current.version, 'saved'); assert.equal(editor.current.content, 'SELECT 99;'); assert.equal(editor.dirty, false);
});

test('sync failures preserve content and recover without a page refresh', async t => {
  const { editor, $, fail, files } = await setup(t);
  await editor.open({ cwd: '/project', path: 'a.sql' }); fail(new Error('network unavailable')); await editor.refresh();
  assert.equal(editor.current.content, 'SELECT 1;'); assert.equal($('editorStatus').textContent, '自动同步暂不可用');
  files.set('a.sql', { content: 'SELECT 4;', version: 'new' }); await editor.refresh();
  assert.equal(editor.current.content, 'SELECT 4;'); assert.equal($('editorStatus').textContent, '已自动同步');
});

test('non-overlapping disk changes merge into drafts with updated save version, cursor and no automatic write', async t => {
  const { editor, $, files, calls, type } = await setup(t);
  const base = 'SELECT\n  old_column\nFROM demo\nWHERE enabled = 1\nORDER BY id;\n';
  files.set('a.sql', { content: base, version: 'base' });
  await editor.open({ cwd: '/project', path: 'a.sql' });
  const draft = base.replace('ORDER BY id;', 'ORDER BY new_id;'); type(draft);
  $('fileEditorText').setSelectionRange(draft.indexOf('new_id'), draft.indexOf('new_id') + 6);
  $('editorFind').focus(); const focus = document.activeElement;
  const disk = base.replace('SELECT\n', '-- newly added\nSELECT\n').replace('old_column', 'new_column');
  files.set('a.sql', { content: disk, version: 'disk-v2' }); await editor.refresh();
  const combined = disk.replace('ORDER BY id;', 'ORDER BY new_id;');
  assert.equal(editor.current.content, combined); assert.equal(editor.current.version, 'disk-v2'); assert.equal(editor.dirty, true);
  assert.equal(editor.current.content.slice(editor.current.start, editor.current.end), 'new_id'); assert.equal(document.activeElement, focus);
  assert.equal($('fileConflict').hidden, true); assert.match($('editorStatus').textContent, /已合并磁盘更新/); assert.equal($('undoFileSync').hidden, false);
  assert.equal(calls.some(call => call.route === '/api/project/save'), false);
  await editor.save(); assert.equal(calls.at(-1).body.version, 'disk-v2'); assert.equal(calls.at(-1).body.content, combined);
  assert.equal(editor.dirty, false); assert.equal($('undoFileSync').hidden, true);
});

test('undo merge restores the exact earlier draft and prevents the same disk update being merged again', async t => {
  const { editor, $, files, type } = await setup(t);
  const base = 'one\ntwo\nthree\nfour\n'; files.set('a.sql', { content: base, version: 'base' });
  await editor.open({ cwd: '/project', path: 'a.sql' }); type(base.replace('one', 'local'));
  files.set('a.sql', { content: base.replace('four', 'disk'), version: 'disk-v2' }); await editor.refresh();
  const merged = editor.current.content; type(merged + 'new typing');
  assert.equal($('undoFileSync').disabled, true); $('undoFileSync').click(); assert.equal(editor.current.content, merged + 'new typing');
  type(merged); $('undoFileSync').click();
  assert.equal(editor.current.content, base.replace('one', 'local')); assert.equal(editor.current.version, 'base');
  await editor.refresh(); assert.equal(editor.current.content, base.replace('one', 'local')); assert.equal($('fileConflict').hidden, false);
  assert.equal($('fileEditorError').hidden, true, 'one compact conflict prompt instead of two alert blocks');
});

test('latest-code view reads fresh disk content and never replaces or saves the conflicting draft', async t => {
  const { editor, $, files, type, calls } = await setup(t);
  await editor.open({ cwd: '/project', path: 'a.sql' }); type('SELECT local_value;');
  files.set('a.sql', { content: 'SELECT remote_value;', version: 'remote' }); await editor.refresh();
  assert.equal($('fileConflict').hidden, false); assert.equal($('fileEditorError').hidden, true);
  files.set('a.sql', { content: 'SELECT latest_value;', version: 'latest' }); $('viewLatestFile').click();
  for (let i = 0; i < 50 && !$('fileConflictDialog').open; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal($('fileConflictDialog').open, true); assert.equal($('fileConflictDialog').classList.contains('latest-only'), true);
  assert.equal($('diskFileVersion').value, 'SELECT latest_value;'); assert.equal($('localFileVersion').value, 'SELECT local_value;');
  assert.equal(editor.current.content, 'SELECT local_value;'); assert.equal(editor.current.version, 'v1');
  assert.equal(calls.some(call => call.route === '/api/project/save'), false);
  $('keepLocalVersion').click(); assert.equal($('fileConflictDialog').open, false); assert.equal(editor.dirty, true);
});
