import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createFileEditor, lineEdit } from '../public/file-editor.js';

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
