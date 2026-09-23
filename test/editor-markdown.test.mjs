import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createFileEditor, resolveMarkdownLink } from '../public/file-editor.js';
import { createEditorTools } from '../public/editor-tools.js';
import { markdown } from '../public/markdown.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const content = '# 项目说明\n\n> 阅读文档\n\n## 功能\n\n- 文件编辑\n- **实时预览**\n\n| 模块 | 作用 |\n| --- | --- |\n| `public/` | 界面 |\n\n```sql\nSELECT 1;\n```\n\n[功能](#功能)\n\n[另一个文件](../other.MD)\n';
const settle = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('editor did not settle'); };
function browser(t, initial) {
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'http://localhost', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom, document = window.document;
  const previous = Object.fromEntries(['window', 'document', 'localStorage'].map(name => [name, globalThis[name]]));
  Object.assign(globalThis, { window, document, localStorage: window.localStorage });
  window.HTMLElement.prototype.scrollIntoView = function () { this.dataset.scrolled = 'true'; };
  if (initial) window.localStorage.setItem('lemon:openFiles:v1', initial);
  const calls = [], files = new Map([['docs/guide.md', content], ['other.MD', '# Other\n'], ['query.sql', 'SELECT 1;']]);
  let version = 'v1';
  const api = async (route, body) => {
    calls.push({ route, body });
    const url = new URL(route, 'http://localhost'), path = url.searchParams.get('path');
    assert.equal(url.pathname, '/api/project/file'); assert.equal(body, undefined, 'reading and mode switching must never write or run code');
    return { cwd: '/project', path, content: files.get(path) ?? '', version, writable: true, newline: 'LF' };
  };
  const editor = createFileEditor({ api, onAttach() {} });
  createEditorTools({ editor, api, notice() {}, onContext() {}, onPreview() { assert.fail('Markdown should use the active buffer, not download the disk version'); } });
  const $ = id => document.getElementById(id), reader = () => document.querySelector('.editor-code:not([hidden]) .editor-markdown-reader');
  const flush = () => { window.dispatchEvent(new window.Event('pagehide')); return window.localStorage.getItem('lemon:openFiles:v1'); };
  let closed = false;
  const close = () => { if (closed) return; closed = true; dom.window.close(); Object.assign(globalThis, previous); assert.deepEqual(errors, []); };
  t.after(close);
  return { window, document, editor, $, reader, files, calls, flush, close, diskVersion(value) { version = value; } };
}

test('Markdown opens as a rendered document; switching uses the same draft, selection and independent scroll positions', async t => {
  const page = browser(t), { editor, $, reader, window } = page;
  editor.setProject('/project'); await editor.open({ cwd: '/project', path: 'docs/guide.md' });
  assert.equal(editor.current.markdownMode, 'preview'); assert.equal($('editorMarkdownModes').hidden, false);
  editor.previewCompletion(); assert.equal($('editorLanguageStatus').textContent, 'Markdown · 预览'); assert.equal($('editorCursor').textContent, '');
  assert.equal(reader().querySelector('h1').textContent, '项目说明');
  assert.equal(reader().querySelector('h2').textContent, '功能');
  assert.equal(reader().querySelectorAll('tbody td').length, 2); assert.equal(reader().querySelector('pre code').textContent, 'SELECT 1;');
  reader().querySelector('[data-markdown-anchor]').click(); assert.equal(reader().querySelector('h2').dataset.scrolled, 'true');
  const oldHeading = reader().querySelector('h1'); await editor.refresh(); assert.equal(reader().querySelector('h1'), oldHeading, 'polling unchanged text must not replace selected DOM');
  reader().scrollTop = 120; reader().dispatchEvent(new window.Event('scroll'));
  $('editorMarkdownSource').click(); const input = $('fileEditorText');
  assert.equal(editor.current.preview, false); assert.equal(page.document.activeElement, input);
  input.value += '\n未保存的草稿'; input.dispatchEvent(new window.Event('input', { bubbles: true })); input.setSelectionRange(5, 10, 'backward'); input.scrollTop = 88; input.scrollLeft = 24;
  $('editorMarkdownPreview').click(); assert.match(reader().textContent, /未保存的草稿/); assert.equal(reader().scrollTop, 120); assert.equal(editor.dirty, true);
  $('editorMarkdownSource').click(); assert.equal($('fileEditorText'), input); assert.equal(input.scrollTop, 88); assert.equal(input.scrollLeft, 24);
  assert.equal(input.selectionStart, 5); assert.equal(input.selectionEnd, 10); assert.equal(input.selectionDirection, 'backward');
  $('editorPreview').click(); await settle(() => editor.current.markdownMode === 'preview'); assert.match(reader().textContent, /未保存的草稿/);
  assert.equal(page.calls.length, 2); assert.equal(editor.snapshots()[0].content, input.value);
});

test('mode and reading position stay per file and restore without persisting document text; SQL has no Markdown toggle', async t => {
  let page = browser(t); page.editor.setProject('/project');
  await page.editor.open({ cwd: '/project', path: 'docs/guide.md' });
  page.reader().scrollTop = 164; page.reader().dispatchEvent(new page.window.Event('scroll'));
  await page.editor.open({ cwd: '/project', path: 'other.MD' }); page.$('editorMarkdownSource').click();
  await page.editor.open({ cwd: '/project', path: 'query.sql' }); assert.equal(page.$('editorMarkdownModes').hidden, true); assert.equal(page.editor.current.language, 'sql');
  await page.editor.open({ cwd: '/project', path: 'docs/guide.md' }); assert.equal(page.reader().scrollTop, 164);
  const stored = page.flush(); assert.doesNotMatch(stored, /项目说明|SELECT|content|baseline/); page.close();
  page = browser(t, stored); page.editor.setProject('/project'); await settle(() => page.editor.current && !page.editor.current.loading);
  assert.equal(page.editor.current.markdownMode, 'preview'); assert.equal(page.reader().scrollTop, 164);
  await page.editor.open({ cwd: '/project', path: 'other.MD' }); assert.equal(page.editor.current.markdownMode, 'source');
});

test('disk updates refresh preview; find and explicit line navigation reveal source and retain the unsaved buffer', async t => {
  const page = browser(t), { editor, $, reader, files, window } = page;
  editor.setProject('/project'); await editor.open({ cwd: '/project', path: 'docs/guide.md' });
  files.set('docs/guide.md', '# 新标题\n\n正文'); page.diskVersion('v2'); await editor.refresh();
  assert.equal(reader().querySelector('h1').textContent, '新标题');
  $('editorFindToggle').click(); assert.equal(editor.current.markdownMode, 'source'); assert.equal(page.document.activeElement, $('editorFind'));
  $('editorFind').value = '正文'; $('editorFind').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal($('editorFindCount').textContent, '1 / 1'); assert.equal(editor.current.content.slice(editor.current.start, editor.current.end), '正文');
  $('editorMarkdownPreview').click(); assert.equal($('editorFindBar').hidden, true);
  editor.select(2, 5); assert.equal(editor.current.markdownMode, 'source'); assert.equal(editor.current.start, 2);
  $('fileEditorText').value += '\n草稿'; $('fileEditorText').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('editorMarkdownPreview').click(); files.set('docs/guide.md', '# 磁盘标题\n\n正文'); page.diskVersion('v3'); await editor.refresh();
  assert.match(reader().textContent, /磁盘标题/); assert.match(reader().textContent, /草稿/); assert.equal(editor.dirty, true);
});

test('document links open relative to the Markdown folder through existing file reads', async t => {
  const page = browser(t); page.editor.setProject('/project'); await page.editor.open({ cwd: '/project', path: 'docs/guide.md' });
  const count = page.calls.length;
  page.reader().querySelector('[data-file-link]').click(); await settle(() => page.editor.current?.path === 'other.MD' && !page.editor.current.loading);
  assert.equal(page.calls.length, count + 1); assert.equal(page.editor.current.markdownMode, 'preview');
  assert.deepEqual(resolveMarkdownLink('../query.sql#L2', { cwd: '/project', path: 'docs/guide.md' }), { cwd: '/project', path: 'query.sql', line: 2, anchor: 'L2' });
  assert.equal(resolveMarkdownLink('/project/other.MD', { cwd: '/project', path: 'docs/guide.md' }).path, 'other.MD');
  for (const target of ['../../private.md', '/project-other/a.md', 'file:///private.md', '//evil.test/a.md', '%2e%2e/%2e%2e/private.md', '%6aavascript:bad.md', 'a%00.md']) assert.throws(() => resolveMarkdownLink(target, { cwd: '/project', path: 'docs/guide.md' }));
});

test('document rendering keeps HTML and unsafe protocols inert, scopes anchors and supports six heading levels', () => {
  const doc = JSDOM.fragment(markdown('# 标题\n\n# 标题\n\n###### 最小标题\n\n[跳转](#标题) [链接](javascript:alert(1))\n\n<script>alert(1)</script>\n\n<img src=x onerror=bad>\n\n```html\n<img src=x onerror=bad>\n```', { document: true }));
  assert.deepEqual([...doc.querySelectorAll('h1')].map(node => node.dataset.markdownHeading), ['标题', '标题-1']);
  assert.equal(doc.querySelector('h6').textContent, '最小标题'); assert.equal(doc.querySelector('[data-markdown-anchor]').dataset.markdownAnchor, '标题');
  assert.equal(doc.querySelectorAll('img,script,iframe,a,[onclick],[onerror],[id]').length, 0);
  assert.equal(doc.querySelector('pre code').textContent, '<img src=x onerror=bad>');
});
