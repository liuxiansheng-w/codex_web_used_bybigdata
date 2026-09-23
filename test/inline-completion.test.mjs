import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createFileEditor } from '../public/file-editor.js';
import { createInlineCompletion } from '../public/editor-tools.js';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t) {
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://localhost', pretendToBeVisual: true, virtualConsole });
  const previous = Object.fromEntries(['window', 'document', 'localStorage'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
  const $ = id => document.getElementById(id), calls = [], completions = [];
  const api = async (route, body, options) => {
    calls.push({ route, body });
    if (route === '/api/project/complete') return new Promise((resolve, reject) => {
      completions.push({ body, signal: options.signal, resolve, reject });
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const name = new URL(route, 'http://localhost').searchParams.get('path');
    return { cwd: '/project', path: name, content: '-- orders(id, amount)\nSELECT ', version: '1', writable: name !== 'readonly.sql', newline: 'LF' };
  };
  let completion;
  const editor = createFileEditor({ api, onAttach() {}, onChange: () => completion?.sync() });
  completion = createInlineCompletion({ editor, api, delay: 15, getConfig: () => ({ available: true, model: $('model').value }) });
  t.after(() => { completion.destroy(); dom.window.close(); Object.assign(globalThis, previous); assert.deepEqual(errors, []); });
  await editor.open({ cwd: '/project', path: 'a.sql' });
  const type = (text, caret = text.length) => { const input = $('fileEditorText'); input.value = text; input.setSelectionRange(caret, caret); input.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const key = (value, options = {}) => { const input = $('fileEditorText'); input.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })); };
  return { $, calls, completions, editor, completion, type, key };
}

test('typing se suggests SELECT and accepting the word schedules a logical continuation without saving or querying', async t => {
  const { $, type, key, editor, calls, completions } = await setup(t);
  type('se'); assert.equal($('editorCompletionList').hidden, false); assert.equal($('sql-word-0').textContent, 'SELECT');
  key('Tab'); assert.equal(editor.current.content, 'SELECT'); assert.equal(editor.current.start, 6);
  await pause(25); assert.equal(completions.length, 1); assert.equal(completions[0].body.before, 'SELECT');
  assert.equal(calls.some(call => /save|sql\/query/.test(call.route)), false);
});

test('multiline AI is preview-only, escaped, and inserts at the exact cursor while preserving suffix', async t => {
  const { $, type, key, editor, completions, calls } = await setup(t);
  const text = '-- orders(id, amount)\nSELECT \nFROM orders;', caret = text.indexOf('\nFROM'); type(text, caret);
  await pause(25); assert.equal(completions.length, 1);
  const suggestion = 'id,\n  CASE WHEN amount < 0 THEN 0 ELSE amount END AS amount';
  completions[0].resolve({ completion: suggestion }); await pause(1);
  assert.equal(editor.current.content, text); assert.equal(document.querySelector('.editor-ai-ghost').textContent, suggestion);
  assert.equal($('editorLineNumbers').textContent, '1\n2\n\n3');
  assert.equal($('editorLineNumbers').style.paddingBottom, $('fileEditorText').style.paddingBottom);
  assert.equal($('editorHighlight').querySelector('script'), null);
  key('Tab'); assert.equal(editor.current.content, text.slice(0, caret) + suggestion + text.slice(caret));
  assert.equal(editor.current.start, caret + suggestion.length); assert.equal(document.querySelector('.editor-ai-ghost'), null);
  assert.equal($('editorLineNumbers').textContent, '1\n2\n3\n4');
  assert.equal(calls.some(call => /save|sql\/query/.test(call.route)), false);
});

test('typing, moving the cursor, switching file and IME invalidate pending AI responses', async t => {
  const { $, type, editor, completions } = await setup(t);
  type('SELECT '); await pause(25); type('SELECT id '); assert.equal(completions[0].signal.aborted, true);
  completions[0].resolve({ completion: 'stale' }); await pause(25);
  assert.equal(completions.length, 2); editor.select(2); assert.equal(completions[1].signal.aborted, true);
  completions[1].resolve({ completion: 'wrong cursor' }); await pause(1); assert.equal(document.querySelector('.editor-ai-ghost'), null);
  type('SELECT id FROM '); await pause(25); await editor.open({ cwd: '/project', path: 'b.sql' });
  assert.equal(completions[2].signal.aborted, true); completions[2].resolve({ completion: 'wrong file' }); await pause(1);
  assert.equal(document.querySelector('.editor-ai-ghost'), null); assert.equal(editor.current.path, 'b.sql');
  $('fileEditorText').dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })); type('中文'); await pause(25);
  assert.equal(completions.length, 3);
});

test('Escape, pause and loss of focus dismiss suggestions without changing the draft', async t => {
  const { $, type, key, editor, completions } = await setup(t);
  type('SELECT '); await pause(25); completions[0].resolve({ completion: 'id FROM orders' }); await pause(1);
  key('Escape'); assert.equal(document.querySelector('.editor-ai-ghost'), null); assert.equal(editor.current.content, 'SELECT ');
  $('editorAIToggle').click(); type('SELECT id '); await pause(25); assert.equal(completions.length, 1);
  $('editorAIToggle').click(); type('SELECT id FROM '); await pause(25);
  $('prompt').focus(); assert.equal(completions[1].signal.aborted, true); completions[1].resolve({ completion: 'orders' }); await pause(1);
  assert.equal(document.querySelector('.editor-ai-ghost'), null);
});

test('keyword context respects strings/comments and resumes after their closing delimiter', async t => {
  const { $, type, key } = await setup(t);
  for (const text of ["SELECT 'se", '-- se', '/* se', 'SELECT `se']) { type(text); assert.equal($('editorCompletionList').hidden, true, text); }
  for (const text of ["SELECT 'ok' AS na, se", '/* comment */ se', '-- comment\nse']) {
    type(text); assert.equal($('editorCompletionList').hidden, false, text); key('Escape');
  }
});

test('model/dialect changes, readonly buffers and hiding the editor prevent stale acceptance', async t => {
  const { $, type, editor, completions } = await setup(t);
  type('SELECT '); await pause(25);
  $('sqlDialect').value = 'hive'; $('sqlDialect').dispatchEvent(new window.Event('change'));
  assert.equal(completions[0].signal.aborted, true); completions[0].resolve({ completion: 'old dialect' });
  type('SELECT id '); await pause(25);
  const option = document.createElement('option'); option.value = 'another-model'; $('model').append(option); $('model').value = option.value;
  $('model').dispatchEvent(new window.Event('change')); assert.equal(completions[1].signal.aborted, true); completions[1].resolve({ completion: 'old model' });
  type('SELECT id FROM '); await pause(25); editor.hide();
  assert.equal(completions[2].signal.aborted, true); completions[2].resolve({ completion: 'hidden' }); await pause(1);
  assert.equal(document.querySelector('.editor-ai-ghost'), null);
  await editor.open({ cwd: '/project', path: 'readonly.sql' }); type('SELECT '); await pause(25); assert.equal(completions.length, 3);
});

test('mouse, keyboard and focus trigger at general cursor positions without SQL keyword rules', async t => {
  const { $, type, completions, editor } = await setup(t);
  const text = '-- describe an expression\nSELECT custom_fn(value), other_value FROM demo;';
  type(text, text.indexOf('value)') + 3); await pause(25);
  const input = $('fileEditorText');
  input.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  input.setSelectionRange(text.indexOf('other_value') + 4, text.indexOf('other_value') + 4);
  input.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await pause(25);
  assert.equal(completions[0].signal.aborted, true); assert.equal(completions.length, 2);
  assert.equal(completions[1].body.before, text.slice(0, editor.current.start));
  assert.equal(completions[1].body.after, text.slice(editor.current.end));
  input.setSelectionRange(12, 12);
  input.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true })); await pause(25);
  assert.equal(completions[1].signal.aborted, true); assert.equal(completions.length, 3);
  $('prompt').focus(); assert.equal(completions[2].signal.aborted, true);
  input.focus(); await pause(25); assert.equal(completions.length, 4);
  input.setSelectionRange(0, 12);
  input.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await pause(25);
  assert.equal(completions[3].signal.aborted, true); assert.equal(completions.length, 4);
});

test('accepting a multiline suggestion continues with the new prefix and unchanged suffix', async t => {
  const { type, key, completions, editor, calls } = await setup(t);
  const text = '-- demo(id, amount)\nWITH totals AS (\n  SELECT \n)\nSELECT * FROM totals;', caret = text.indexOf('\n)');
  type(text, caret); await pause(25);
  const first = 'id, SUM(amount) AS total_amount\n  FROM demo';
  completions[0].resolve({ completion: first }); await pause(1); key('Tab'); await pause(25);
  assert.equal(completions.length, 2);
  assert.equal(completions[1].body.before, text.slice(0, caret) + first);
  assert.equal(completions[1].body.after, text.slice(caret));
  const next = '\n  GROUP BY id'; completions[1].resolve({ completion: next }); await pause(1);
  assert.equal(editor.current.content, text.slice(0, caret) + first + text.slice(caret));
  key('Tab'); assert.equal(editor.current.content, text.slice(0, caret) + first + next + text.slice(caret));
  assert.equal(calls.some(call => /save|sql\/query/.test(call.route)), false);
});

test('typing through ghost text preserves the remaining preview without another model call', async t => {
  const { type, key, completions, editor } = await setup(t);
  const text = '-- demo(id, amount)\nSELECT \nFROM demo;', caret = text.indexOf('\nFROM');
  const suggestion = 'CASE WHEN amount IS NULL THEN 0 ELSE amount END AS value';
  type(text, caret); await pause(25); completions[0].resolve({ completion: suggestion }); await pause(1);
  for (const consumed of [1, 4, 10]) {
    type(text.slice(0, caret) + suggestion.slice(0, consumed) + text.slice(caret), caret + consumed);
    assert.equal(document.querySelector('.editor-ai-ghost')?.textContent, suggestion.slice(consumed));
    await pause(25); assert.equal(completions.length, 1);
  }
  key('Tab'); assert.equal(editor.current.content, text.slice(0, caret) + suggestion + text.slice(caret));
});

test('backspacing reuses an exact cached suggestion but changed suffix and dialect require new inference', async t => {
  const { $, type, completions } = await setup(t);
  const text = 'SELECT \nFROM demo;', caret = 7;
  type(text, caret); await pause(25); completions[0].resolve({ completion: 'amount' }); await pause(1);
  type('SELECT x\nFROM demo;', caret + 1); await pause(25); assert.equal(completions.length, 2);
  type(text, caret); await pause(25);
  assert.equal(completions[1].signal.aborted, true); assert.equal(completions.length, 2);
  assert.equal(document.querySelector('.editor-ai-ghost')?.textContent, 'amount');
  type('SELECT \nFROM other_demo;', caret); assert.equal(document.querySelector('.editor-ai-ghost'), null);
  await pause(25); assert.equal(completions.length, 3);
  $('sqlDialect').value = 'hive'; $('sqlDialect').dispatchEvent(new window.Event('change'));
  type(text, caret); await pause(25); assert.equal(completions.length, 4);
  assert.equal(completions[3].body.dialect, 'hive');
});

test('Escape suppresses the same suggestion on refocus and click, while manual retry bypasses dismissal', async t => {
  const { $, type, key, completions } = await setup(t);
  type('SELECT '); await pause(25); completions[0].resolve({ completion: 'id' }); await pause(1); key('Escape');
  $('prompt').focus(); $('fileEditorText').focus(); $('fileEditorText').click(); await pause(25);
  assert.equal(document.querySelector('.editor-ai-ghost'), null); assert.equal(completions.length, 1);
  key('\\', { code: 'Backslash', altKey: true }); assert.equal(completions.length, 2);
  completions[1].resolve({ completion: 'amount' }); await pause(1);
  assert.equal(document.querySelector('.editor-ai-ghost')?.textContent, 'amount');
});

test('empty replies are visible and briefly cached; malformed replies cannot be accepted', async t => {
  const { $, type, key, completions, editor } = await setup(t);
  type('SELECT '); await pause(25); completions[0].resolve({ completion: '' }); await pause(1);
  assert.match($('editorAIStatus').textContent, /暂无续写建议/);
  $('fileEditorText').click(); await pause(25); assert.equal(completions.length, 1);
  key('\\', { code: 'Backslash', altKey: true }); completions[1].resolve({ completion: '```sql\nSELECT 1' }); await pause(1);
  assert.match($('editorAIStatus').textContent, /格式不可用/);
  assert.equal(document.querySelector('.editor-ai-ghost'), null); assert.equal(editor.current.content, 'SELECT ');
});

test('context is bounded to the current buffer, including unsaved changes on both sides', async t => {
  const { type, completions } = await setup(t);
  const text = '-- fictional context\n' + ' '.repeat(14000) + 'SELECT ' + ' '.repeat(6000), caret = text.length - 6000;
  type(text, caret); await pause(25);
  assert.equal(completions[0].body.before, text.slice(caret - 12000, caret));
  assert.equal(completions[0].body.after, text.slice(caret, caret + 4000));
  assert.equal(completions[0].body.header, text.slice(0, caret - 12000));
  assert.equal(completions[0].body.path, 'a.sql');
});

test('Enter after a subquery alias requests the next line and displays the returned join preview', async t => {
  const { $, type, key, completions, editor } = await setup(t);
  const sql = '-- demo_people(user_id), demo_policies(user_id)\nSELECT aa.user_id FROM demo_people aa\nLEFT JOIN (SELECT user_id FROM demo_policies) bb';
  type(sql); key('Enter'); await pause(25);
  assert.equal(completions.length, 1); assert.equal(completions[0].body.before, sql + '\n');
  assert.equal(completions[0].body.after, ''); assert.match($('editorAIToggle').textContent, /续写中/);
  const text = 'ON aa.user_id = bb.user_id'; completions[0].resolve({ completion: text }); await pause(1);
  assert.equal(document.querySelector('.editor-ai-ghost')?.textContent, text);
  assert.equal(editor.current.content, sql + '\n'); key('Tab'); assert.equal(editor.current.content, sql + '\n' + text);
});

test('slow and timed out requests remain visible beside the AI control and can be retried with the keyboard', async t => {
  const { $, type, completions, editor, calls } = await setup(t);
  type('SELECT '); await pause(25);
  assert.match($('editorAIToggle').textContent, /续写中 · 0 秒/); assert.equal($('editorAIToggle').getAttribute('aria-busy'), 'true');
  await pause(1050); assert.match($('editorAIToggle').textContent, /续写中 · 1 秒/);
  completions[0].reject(Object.assign(new Error('Server timeout'), { status: 504 })); await pause(1);
  assert.match($('editorAIStatus').textContent, /续写超时/); assert.equal($('editorAIToggle').textContent, '✦ 续写失败');
  assert.equal($('editorAIToggle').getAttribute('aria-busy'), 'false'); assert.equal($('editorAIRetry').hidden, false);
  $('editorAIRetry').focus(); assert.equal($('editorAIRetry').hidden, false);
  $('editorAIRetry').click(); assert.equal(completions.length, 2); assert.equal(document.activeElement, $('fileEditorText'));
  assert.equal($('editorAIRetry').hidden, true); completions[1].resolve({ completion: 'id FROM demo' }); await pause(1);
  assert.equal(document.querySelector('.editor-ai-ghost')?.textContent, 'id FROM demo');
  assert.equal(editor.current.content, 'SELECT '); assert.equal(calls.some(call => /save|sql\/query/.test(call.route)), false);
});

test('empty results are visible beside the editor and retry bypasses the empty cache', async t => {
  const { $, type, completions } = await setup(t);
  type('SELECT '); await pause(25); completions[0].resolve({ completion: '' }); await pause(1);
  assert.equal($('editorAIToggle').textContent, '✦ 暂无建议'); assert.equal($('editorAIRetry').hidden, false);
  $('editorAIRetry').click(); assert.equal(completions.length, 2);
  type('SELECT id '); assert.equal(completions[1].signal.aborted, true);
  $('editorAIToggle').click(); assert.equal($('editorAIToggle').textContent, 'AI 已暂停');
  assert.equal($('editorAIRetry').hidden, true); await pause(25); assert.equal(completions.length, 2);
});
