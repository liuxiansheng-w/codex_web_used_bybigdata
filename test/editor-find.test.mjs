import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createFileEditor } from '../public/file-editor.js';
import { createEditorTools } from '../public/editor-tools.js';
import { findCodeMatches, highlightCode, markCodeMatches } from '../public/code-highlight.js';

async function setup(t, files = {}) {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://localhost', pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'localStorage', 'confirm'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, confirm: () => true });
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 10)); dom.window.close(); Object.assign(globalThis, saved); });
  const calls = [], source = 'SELECT fee, fee\nFROM demo\nWHERE fee > 0;\n-- Fee';
  const editor = createFileEditor({ api: async route => {
    calls.push(route); const path = new URL(route, 'http://localhost').searchParams.get('path');
    return { cwd: '/project', path, content: files[path] ?? source, version: 'v1', writable: path !== 'readonly.sql', newline: 'LF' };
  }, onAttach() {} });
  createEditorTools({ editor, api: () => assert.fail('find must not call an API'), notice() {}, onContext() {}, onPreview() {} });
  await editor.open({ cwd: '/project', path: 'a.sql' });
  const $ = id => document.getElementById(id);
  const key = (id, name, options = {}) => { const event = new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...options }); $(id).dispatchEvent(event); return event; };
  const query = text => { $('editorFind').value = text; $('editorFind').dispatchEvent(new window.Event('input', { bubbles: true })); };
  $('editorFindToggle').click();
  return { editor, $, key, query, calls, source, window: dom.window };
}

test('live find highlights all visible literal matches; Enter/Shift+Enter wrap while focus stays in find', async t => {
  const { editor, $, key, query, calls, source } = await setup(t);
  query('fee');
  assert.equal($('editorFindCount').textContent, '1 / 3');
  assert.equal($('editorHighlight').querySelectorAll('mark').length, 3);
  assert.equal($('editorHighlight').querySelector('[data-search-current]').textContent, 'fee');
  assert.equal(document.activeElement, $('editorFind'));
  const starts = findCodeMatches(source, 'fee');
  for (const [shift, expected] of [[false, 1], [false, 2], [false, 0], [true, 2]]) {
    assert.equal(key('editorFind', 'Enter', { shiftKey: shift }).defaultPrevented, true);
    assert.equal(editor.current.start, starts[expected]); assert.equal(editor.current.end, starts[expected] + 3);
    assert.equal($('editorFindCount').textContent, `${expected + 1} / 3`);
    assert.equal(document.activeElement, $('editorFind'));
  }
  $('editorFindNext').click(); assert.equal(editor.current.start, starts[0]);
  $('editorFindPrevious').click(); assert.equal(editor.current.start, starts[2]);
  assert.equal(editor.current.content, source); assert.equal(editor.dirty, false); assert.equal(calls.length, 1);
  query('missing'); assert.equal($('editorFindCount').textContent, '无匹配');
  assert.equal($('editorFindNext').disabled, true); assert.equal($('editorHighlight').querySelectorAll('mark').length, 0);
  key('editorFind', 'Escape'); assert.equal($('editorFindBar').hidden, true); assert.equal(document.activeElement, $('fileEditorText'));
});

test('find refreshes after edits and file changes, handles plain text and IME, and clears decorations on close', async t => {
  const { editor, $, key, query, window } = await setup(t, { 'note.txt': 'needle needle <img src=x>' });
  query('fee'); $('editorFind').dispatchEvent(new window.CompositionEvent('compositionstart'));
  query('needle'); key('editorFind', 'Enter', { isComposing: true }); assert.equal($('editorFindCount').textContent, '1 / 3');
  $('editorFind').dispatchEvent(new window.CompositionEvent('compositionend')); assert.equal($('editorFindCount').textContent, '无匹配');
  await editor.open({ cwd: '/project', path: 'note.txt' });
  assert.equal($('editorFindCount').textContent, '1 / 2'); assert.equal($('editorHighlight').querySelectorAll('mark').length, 2);
  assert.equal($('editorHighlight').querySelector('img'), null);
  $('fileEditorText').value += ' needle'; $('fileEditorText').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.match($('editorFindCount').textContent, /\/ 3$/); assert.equal($('editorHighlight').querySelectorAll('mark').length, 3);
  const changed = editor.current.content; $('editorFindClose').click();
  assert.equal($('editorHighlight').querySelectorAll('mark').length, 0); assert.equal($('fileEditor').classList.contains('has-highlight'), false);
  assert.equal(editor.current.content, changed); assert.equal(editor.dirty, true);
  key('fileEditorText', 'f', { metaKey: true }); assert.equal($('editorFindBar').hidden, false); assert.equal($('editorFind').value, 'needle');
});

test('replacement stays explicit and literal, updates search counts, and respects readonly files', async t => {
  const { editor, $, key, query, calls, source } = await setup(t);
  query('fee'); $('editorReplace').value = '$&';
  key('editorReplace', 'Enter'); assert.equal(editor.current.content, source, 'Enter must never replace all');
  $('editorReplaceAll').click();
  assert.equal(editor.current.content, source.replaceAll('fee', '$$&'));
  assert.equal($('editorFindCount').textContent, '无匹配'); assert.equal(editor.dirty, true); assert.equal(calls.length, 1);
  await editor.open({ cwd: '/project', path: 'readonly.sql' }); query('fee');
  assert.equal($('editorFindNext').disabled, false); assert.equal($('editorReplaceAll').disabled, true);
});

test('search decorations cross syntax boundaries without changing or interpreting source; large files paint bounded visible matches', t => {
  const dom = new JSDOM('<pre></pre>'); t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('pre'), text = "SELECT '<img src=x>' & '<img src=x>';";
  root.innerHTML = highlightCode(text, 'sql').html;
  const query = "SELECT '<img", positions = findCodeMatches(text, query);
  markCodeMatches(root, positions, query.length, 0);
  assert.equal(root.textContent, text); assert.equal(root.querySelector('img'), null);
  assert.equal([...root.querySelectorAll('[data-search-current]')].map(el => el.textContent).join(''), query);
  assert.ok(root.querySelector('.syntax-keyword')); assert.ok(root.querySelector('.syntax-string'));
  const large = 'needle\n'.repeat(40000); root.innerHTML = highlightCode(large, 'sql').html;
  const hits = findCodeMatches(large, 'needle'); markCodeMatches(root, hits, 6, hits.at(-1), 0, 200);
  assert.equal(hits.length, 40000); assert.ok(root.querySelectorAll('mark').length < 40); assert.equal(root.textContent, large);
  assert.equal(root.querySelector('[data-search-current]').textContent, 'needle');
});
