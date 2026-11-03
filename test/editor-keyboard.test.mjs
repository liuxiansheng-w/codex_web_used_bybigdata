import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createFileEditor, lineEdit, indentationColumns, columnEdit } from '../public/file-editor.js';

test('indent guides use tab stops and continue through empty lines only within a shared block', () => {
  assert.deepEqual([...indentationColumns('SELECT\n  nested\n    value\n\n    other\nFROM demo')], [0, 2, 4, 4, 4, 0]);
  assert.deepEqual([...indentationColumns('\n    a\n\n  b\n', 2)], [0, 4, 2, 2, 0]);
  assert.deepEqual([...indentationColumns(' \tvalue\n\t  other\n    ', 4)], [4, 6, 4]);
  assert.deepEqual([...indentationColumns('')], [0]);
});

const apply = (content, edit) => edit ? content.slice(0, edit.from) + edit.text + content.slice(edit.to) : content;
test('indent/outdent handles selections, next-line boundaries, tabs and reversed selections', () => {
  const sql = 'SELECT\n  amount\nFROM demo';
  const end = sql.indexOf('FROM');
  const indent = lineEdit(sql, 0, end, 'sql', 'indent');
  const indented = apply(sql, indent);
  assert.equal(indented, '  SELECT\n    amount\nFROM demo');
  assert.equal(indented.slice(indent.start, indent.end), 'SELECT\n    amount\n');
  assert.equal(apply(indented, lineEdit(indented, indent.start, indent.end, 'sql', 'outdent')), sql);
  const text = ' \talpha\n\tbeta\n gamma';
  assert.equal(apply(text, lineEdit(text, 0, text.length, 'sql', 'outdent')), '\talpha\nbeta\ngamma');
  assert.equal(lineEdit('SELECT', 3, 3, 'sql', 'outdent'), null);
  const caret = lineEdit('  SELECT', 1, 1, 'sql', 'outdent');
  assert.equal(apply('  SELECT', caret), 'SELECT'); assert.equal(caret.start, 0); assert.equal(caret.end, 0);
  assert.equal(apply('x', lineEdit('x', 0, 0, 'python', 'indent')), '    x');
  assert.equal(apply('\nx', lineEdit('\nx', 0, 1, 'sql', 'indent')), '  \nx');
});

test('line comments round-trip SQL/Python while retaining blank lines, indentation and partial selections', () => {
  for (const [language, source, expected] of [
    ['sql', '  SELECT x,\n    y\n\nFROM demo', '  -- SELECT x,\n    -- y\n\n-- FROM demo'],
    ['python', 'def foo():\n    return 1', '# def foo():\n    # return 1'],
  ]) {
    const edit = lineEdit(source, 1, source.length, language, 'comment'), commented = apply(source, edit);
    assert.equal(commented, expected);
    assert.equal(apply(commented, lineEdit(commented, edit.start, edit.end, language, 'comment')), source);
  }
  assert.equal(apply('-- x\n--y', lineEdit('-- x\n--y', 0, 8, 'sql', 'comment')), 'x\ny');
  assert.equal(apply('SELECT\nFROM x', lineEdit('SELECT\nFROM x', 2, 7, 'sql', 'comment')), '-- SELECT\nFROM x');
  assert.equal(apply('', lineEdit('', 0, 0, 'sql', 'comment')), '-- ');
  assert.equal(lineEdit('some text', 0, 2, 'text', 'comment'), null);
});

async function setup(t) {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), {url:'http://localhost',pretendToBeVisual:true});
  const previous = Object.fromEntries(['window','document','localStorage'].map(key=>[key,globalThis[key]]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage});
  t.after(async()=>{await new Promise(resolve=>setTimeout(resolve,10));dom.window.close();Object.assign(globalThis,previous);});
  const calls=[], editor=createFileEditor({api:async(route,body)=>{
    calls.push({route,body}); const file=new URL(route,'http://localhost').searchParams.get('path');
    return {cwd:'/project',path:file,content:'  SELECT x\n    FROM demo',version:'v1',writable:file!=='readonly.sql',newline:'LF'};
  },onAttach(){}});
  await editor.open({cwd:'/project',path:'demo.sql'});
  const $=id=>document.getElementById(id), key=(name,options={})=>{
    const event=new window.KeyboardEvent('keydown',{key:name,bubbles:true,cancelable:true,...options});
    $('fileEditorText').dispatchEvent(event); return event;
  };
  return {editor,$,key,calls};
}

test('column edits preserve intervening text, distribute paste rows and never delete line boundaries or split graphemes', () => {
  const source = 'xxabcYY\nzzdefZZ\nqqghiWW', ranges = [2, 10, 18].map(start => ({ start, end: start + 3 }));
  let edit = columnEdit(source, ranges, 'Q');
  assert.equal(apply(source, edit), 'xxQYY\nzzQZZ\nqqQWW');
  assert.deepEqual(edit.ranges.map(range => range.start), [3, 9, 15]);
  assert.equal(apply(source, columnEdit(source, ranges, ['A', 'B', 'C'])), 'xxAYY\nzzBZZ\nqqCWW');
  const unicode = 'a👩‍💻Z\nb中Z', carets = [unicode.indexOf('Z'), unicode.lastIndexOf('Z')].map(start => ({ start, end: start }));
  assert.equal(apply(unicode, columnEdit(unicode, carets, '', 'backward')), 'aZ\nbZ');
  assert.equal(apply('a\nb', columnEdit('a\nb', [{ start: 0, end: 0 }, { start: 2, end: 2 }], '', 'backward')), 'a\nb');
  assert.equal(apply('a\nb', columnEdit('a\nb', [{ start: 1, end: 1 }, { start: 3, end: 3 }], '', 'forward')), 'a\nb');
  assert.equal(apply('a\nlong', columnEdit('a\nlong', [{ start: 1, end: 1, pad: 3 }, { start: 6, end: 6 }], 'X')), 'a   X\nlongX');
  edit = columnEdit('a\nb', [{ start: 1, end: 1, pad: 3 }, { start: 3, end: 3 }], '', 'backward');
  assert.equal(apply('a\nb', edit), 'a\n'); assert.equal(edit.ranges[0].pad, 2);
});

function columnFixture({ $, editor }, source) {
  const input = $('fileEditorText');
  Object.assign(input.style, { fontFamily: 'monospace', fontSize: '10px', lineHeight: '22px', paddingTop: '16px', paddingLeft: '14px', tabSize: '4' });
  Object.defineProperty(input, 'clientWidth', { configurable: true, value: 640 });
  Object.defineProperty(input, 'clientHeight', { configurable: true, value: 220 });
  input.getBoundingClientRect = () => ({ left: 100, top: 60, right: 740, bottom: 280, width: 640, height: 220 });
  input.value = source; input.setSelectionRange(0, 0); input.dispatchEvent(new window.Event('input', { bubbles: true })); input.focus();
  const pointer = (type, line, column, options = {}) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 114 + column * 6 - input.scrollLeft, clientY: 87 + line * 22 - input.scrollTop, shiftKey: true, altKey: true, ...options });
    Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: 'mouse' } });
    (type === 'pointerdown' ? input : document).dispatchEvent(event); return event;
  };
  const drag = (from, to) => { pointer('pointerdown', ...from); pointer('pointermove', ...to); pointer('pointerup', ...to); };
  const textInput = value => {
    const event = new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }); input.dispatchEvent(event); return event;
  };
  const clipboard = (type, text = '') => {
    const values = new Map([['text/plain', text]]), event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: key => values.get(key) || '', setData: (key, value) => values.set(key, value) } });
    input.dispatchEvent(event); return { event, text: values.get('text/plain') };
  };
  return { input, pointer, drag, textInput, clipboard, selected: () => editor.current.selections?.map(range => input.value.slice(range.start, range.end)) };
}

test('Shift+Option mouse drag selects actual columns and copies, replaces and deletes all rows without saving', async t => {
  const state = await setup(t), { editor, $, key, calls } = state;
  const { input, pointer, drag, textInput, clipboard, selected } = columnFixture(state, 'xxabcYY\nzzdefZZ\nqqghiWW');
  pointer('pointerdown', 0, 2); pointer('pointerup', 0, 2);
  for (const name of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight']) key(name, { altKey: true, shiftKey: true });
  assert.deepEqual(selected(), ['abc', 'def', 'ghi']); key('Escape');
  drag([0, 2], [2, 5]);
  assert.equal(editor.current.columnSelection, true); assert.deepEqual(selected(), ['abc', 'def', 'ghi']);
  assert.match($('editorCursor').textContent, /列选择 3 行/);
  assert.equal(clipboard('copy').text, 'abc\ndef\nghi');
  clipboard('paste', ''); assert.equal(input.value, 'xxabcYY\nzzdefZZ\nqqghiWW', 'non-text and empty clipboard contents cannot erase the selected columns');
  input.maxLength = input.value.length + 1; textInput('too-long');
  assert.equal(input.value, 'xxabcYY\nzzdefZZ\nqqghiWW'); assert.equal(editor.current.columnSelection, true); assert.match($('editorToolStatus').textContent, /大小上限/); input.maxLength = 20 * 1024 * 1024;
  assert.equal(textInput('Q').defaultPrevented, true); assert.equal(input.value, 'xxQYY\nzzQZZ\nqqQWW');
  assert.equal(editor.current.columnSelection, true); assert.deepEqual(selected(), ['', '', '']);
  key('Backspace'); assert.equal(input.value, 'xxYY\nzzZZ\nqqWW');
  assert.equal(clipboard('paste', 'A\r\nB\r\nC').event.defaultPrevented, true); assert.equal(input.value, 'xxAYY\nzzBZZ\nqqCWW');
  assert.equal(key('Escape').defaultPrevented, true); assert.equal(editor.current.columnSelection, false);
  assert.equal(input.parentElement.querySelector('.editor-column-layer').hidden, true); assert.equal(calls.length, 1);
});

test('column drag supports tabs, wide characters, reversed drags and one native undo command per edit', async t => {
  const state = await setup(t), { editor, $ } = state;
  const { input, drag, clipboard, textInput, selected } = columnFixture(state, '\t中ab\n    中xy');
  drag([1, 8], [0, 6]); assert.deepEqual(selected(), ['ab', 'xy']); assert.equal(editor.current.start, 2);
  assert.equal(clipboard('copy').text, 'ab\nxy');
  const commands = [];
  document.execCommand = (command, ui, text) => {
    commands.push({ command, text }); input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' })); return true;
  };
  textInput('z'); assert.equal(input.value, '\t中z\n    中z'); assert.equal(commands.length, 1);
  assert.equal(commands[0].command, 'insertText'); assert.equal(commands[0].text, 'z\n    中z');
  assert.equal($('editorLineNumbers').textContent, '1\n2');
});

test('column selections render only visible rows and remain aligned after scrolling', async t => {
  const state = await setup(t), { editor, $ } = state;
  const { input, drag } = columnFixture(state, Array(150).fill('xxabcYY').join('\n'));
  drag([0, 2], [149, 5]); assert.equal(editor.current.selections.length, 150);
  input.scrollTop = 50 * 22; input.scrollLeft = 10; input.dispatchEvent(new window.Event('scroll'));
  const layer = input.parentElement.querySelector('.editor-column-layer'), rows = [...layer.children];
  assert.ok(rows.length <= 12); assert.equal(layer.getAttribute('aria-hidden'), 'true');
  assert.ok(rows.every(row => Number(row.dataset.line) >= 50 && Number(row.dataset.line) <= 60));
  assert.ok(rows.every(row => row.style.left === '16px' && row.style.width === '18px'));
  assert.ok(rows.every(row => row.style.top === `${16 + (Number(row.dataset.line) - 1) * 22 - 1100}px`));
  assert.match($('editorCursor').textContent, /150 行/);
});

test('ordinary mouse selection, IME, readonly documents and file changes keep column edits isolated', async t => {
  const state = await setup(t), { editor, $, key, calls } = state;
  let fixture = columnFixture(state, 'xxabcYY\nzzdefZZ');
  assert.equal(fixture.pointer('pointerdown', 0, 2, { altKey: false }).defaultPrevented, false);
  assert.equal(editor.current.columnSelection, false);
  fixture.drag([0, 2], [1, 5]); fixture.input.dispatchEvent(new window.CompositionEvent('compositionstart'));
  assert.equal(editor.current.columnSelection, false); assert.equal(editor.current.composing, true); key('Backspace', { isComposing: true });
  assert.equal(fixture.input.value, 'xxabcYY\nzzdefZZ'); fixture.input.dispatchEvent(new window.CompositionEvent('compositionend'));
  await editor.open({ cwd: '/project', path: 'readonly.sql' }); fixture = columnFixture(state, 'xxabcYY\nzzdefZZ');
  fixture.drag([0, 2], [1, 5]); fixture.textInput('Q'); fixture.clipboard('cut');
  assert.equal(fixture.input.value, 'xxabcYY\nzzdefZZ'); assert.equal(fixture.clipboard('copy').text, 'abc\ndef');
  fixture.pointer('pointerdown', 0, 2); await editor.open({ cwd: '/project', path: 'other.sql' });
  const other = $('fileEditorText'), before = other.value; fixture.pointer('pointermove', 1, 5); fixture.pointer('pointerup', 1, 5);
  assert.equal(editor.current.columnSelection, false); assert.equal(other.value, before); assert.equal(calls.filter(call => call.body).length, 0);
});

test('indent guides paint only the viewport and track both scroll axes without changing code or selection', async t => {
  const { editor, $, calls } = await setup(t), input = $('fileEditorText');
  input.style.lineHeight = '22px'; input.style.paddingTop = '16px'; input.style.paddingLeft = '14px'; input.style.tabSize = '4';
  Object.defineProperty(input, 'clientWidth', { configurable: true, value: 640 });
  Object.defineProperty(input, 'clientHeight', { configurable: true, value: 220 });
  input.value = Array.from({ length: 5000 }, (_, line) => ' '.repeat((line % 3 + 1) * 4) + `SELECT ${line}`).join('\n');
  input.setSelectionRange(12, 18, 'backward'); input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.scrollTop = 500 * 22 + 16; input.scrollLeft = 73; input.dispatchEvent(new window.Event('scroll'));
  const source = input.value, root = input.parentElement.querySelector('.editor-indent-guides'), content = root.firstElementChild;
  const rows = [...root.querySelectorAll('.editor-indent-row')];
  assert.equal(root.getAttribute('aria-hidden'), 'true'); assert.equal(root.style.width, '640px'); assert.equal(root.style.height, '220px');
  assert.equal(root.style.getPropertyValue('--editor-indent-step'), '4ch');
  assert.equal(content.style.transform, 'translate(-73px, -11016px)');
  assert.ok(rows.length <= 16); assert.ok(rows.every(row => Number(row.dataset.line) >= 499 && Number(row.dataset.line) <= 514));
  assert.ok(rows.every(row => row.style.top === `${(Number(row.dataset.line) - 1) * 22}px`));
  assert.equal(input.selectionStart, 12); assert.equal(input.selectionEnd, 18); assert.equal(input.selectionDirection, 'backward');
  input.scrollTop = 0; input.dispatchEvent(new window.Event('scroll'));
  assert.ok([...root.querySelectorAll('.editor-indent-row')].every(row => Number(row.dataset.line) <= 16));
  assert.equal(editor.current.content, source); assert.equal(calls.length, 1);
  await editor.open({ cwd: '/project', path: 'other.sql' });
  assert.notEqual($('fileEditorText').parentElement.querySelector('.editor-indent-guides'), root);
  await editor.open({ cwd: '/project', path: 'demo.sql' });
  assert.equal($('fileEditorText'), input); assert.equal(input.value, source);
});

test('editor shortcuts preserve selection direction and scrolling, stay local, and allow Esc then Tab to leave', async t=>{
  const {editor,$,key,calls}=await setup(t), input=$('fileEditorText');
  input.setSelectionRange(0,input.value.length,'backward'); input.scrollTop=44; input.scrollLeft=24;
  assert.equal(key('Tab',{shiftKey:true}).defaultPrevented,true);
  assert.equal(editor.dirty,true);
  assert.equal(editor.current.content,'SELECT x\n  FROM demo'); assert.equal(input.selectionDirection,'backward'); assert.equal(input.scrollTop,44); assert.equal(input.scrollLeft,24);
  key('Tab'); assert.equal(editor.current.content,'  SELECT x\n    FROM demo');
  key('/',{metaKey:true,code:'Slash'}); assert.equal(editor.current.content,'  -- SELECT x\n    -- FROM demo');
  key('/',{ctrlKey:true,code:'Slash'}); assert.equal(editor.current.content,'  SELECT x\n    FROM demo');
  assert.equal(calls.length,1);assert.equal(editor.dirty,false);
  key('Escape'); assert.equal(key('Tab',{shiftKey:true}).defaultPrevented,false);
  assert.equal(key('Tab',{ctrlKey:true}).defaultPrevented,false);
  assert.equal(key('?',{shiftKey:true,code:'Slash'}).defaultPrevented,false);
});

test('readonly buffers, IME and open dialogs are not modified by editing shortcuts', async t=>{
  const {editor,$,key}=await setup(t), original=editor.current.content;
  key('Tab',{shiftKey:true,isComposing:true}); assert.equal(editor.current.content,original);
  $('fileEditorText').dispatchEvent(new window.CompositionEvent('compositionstart'));
  key('/',{ctrlKey:true,code:'Slash'}); assert.equal(editor.current.content,original);
  $('fileEditorText').dispatchEvent(new window.CompositionEvent('compositionend'));
  $('shortcutsDialog').open=true;key('Tab',{shiftKey:true});assert.equal(editor.current.content,original);$('shortcutsDialog').open=false;
  await editor.open({cwd:'/project',path:'readonly.sql'});
  key('/',{metaKey:true,code:'Slash'});key('Tab',{shiftKey:true});assert.equal(editor.current.content,original);assert.equal(editor.dirty,false);
});

test('Enter follows the caret at the viewport edge, synchronizes code layers and leaves manual scrolling alone', async t => {
  const { editor, $, key, calls } = await setup(t), input = $('fileEditorText');
  input.style.lineHeight = '22px'; input.style.paddingTop = '16px'; input.focus();
  Object.defineProperty(input, 'clientHeight', { configurable: true, value: 220 });
  Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => input.value.split('\n').length * 22 + 44 });
  input.value = Array.from({ length: 80 }, (_, i) => `    line_${i}`).join('\n'); input.setSelectionRange(input.value.length, input.value.length);
  input.scrollTop = 16 + 80 * 22 - input.clientHeight;
  let previous = input.scrollTop;
  for (let i = 0; i < 8; i++) {
    assert.equal(key('Enter').defaultPrevented, true);
    assert.ok(input.scrollTop > previous, 'each new line moves the viewport along with the caret'); previous = input.scrollTop;
    const caretBottom = 16 + input.value.slice(0, input.selectionEnd).split('\n').length * 22;
    assert.ok(caretBottom <= input.scrollTop + input.clientHeight);
    assert.equal($('editorHighlight').scrollTop, input.scrollTop); assert.equal($('editorLineNumbers').scrollTop, input.scrollTop);
  }
  assert.ok(input.value.endsWith('\n    '.repeat(8))); assert.equal(editor.current.start, input.value.length);
  // Selecting, polling, and wheel scrolling are not typing; keep the reader's position.
  input.scrollTop = 0; input.dispatchEvent(new window.Event('scroll')); input.dispatchEvent(new window.Event('select'));
  key('Escape'); assert.equal(input.scrollTop, 0);
  const oldLength = input.value.length; key('Enter', { ctrlKey: true }); assert.equal(input.value.length, oldLength);
  assert.equal(calls.filter(call => call.body).length, 0);
});

test('middle-file newlines stay near the edit and multiline insertions reveal the new caret', async t => {
  const { editor, $, key } = await setup(t), input = $('fileEditorText');
  input.style.lineHeight = '22px'; input.style.paddingTop = '16px'; input.focus();
  Object.defineProperty(input, 'clientHeight', { configurable: true, value: 220 });
  Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => input.value.split('\n').length * 22 + 44 });
  input.value = Array.from({ length: 80 }, (_, i) => `line_${i}`).join('\n');
  const at = input.value.indexOf('line_10') + 7; input.setSelectionRange(at, at); input.scrollTop = 170;
  key('Enter'); assert.equal(input.scrollTop, 170, 'typing in the middle never jumps to the end of the file');
  const snapshot = editor.current;
  assert.equal(editor.insertCompletion('a\nb\nc\nd\ne\nf\ng\nh\n', snapshot), true);
  assert.ok(input.scrollTop > 170);
  assert.ok(16 + input.value.slice(0, input.selectionEnd).split('\n').length * 22 <= input.scrollTop + input.clientHeight);
  input.setSelectionRange(0, 0); input.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Home', ctrlKey: true }));
  assert.equal(input.scrollTop, 0, 'keyboard navigation can reveal the top too');
});
