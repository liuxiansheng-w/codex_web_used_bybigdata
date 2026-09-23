import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { markdown } from '../public/markdown.js';
import { enhanceMarkdown } from '../public/markdown-preview.js';
import { resolveMarkdownLink } from '../public/file-editor.js';

const render = source => JSDOM.fragment(markdown(source, { document: true }));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('document Markdown parses nested lists, task lists, reference links, tables, footnotes, alerts and equations', () => {
  const doc = render('# Guide\n\n## Second\n\n### Third\n\n- [x] Done\n  - child **bold**\n- [ ] Pending\n\n3. third\n4. fourth\n\n~~deleted~~ [link][ref]\n\n[ref]: ../other.md\n\n| left | right |\n| :--- | ---: |\n| a\\|b | `code` |\n\ntext[^one]\n\n[^one]: footnote\n\n> [!NOTE]\n> note\n\n$x^2$\n\n$$\n\\frac{1}{2}\n$$\n\n```math\nx+y\n```\n\n```javascript\nconst value = "text";\n```');
  assert.equal(doc.querySelectorAll('li input[disabled]').length, 2); assert.equal(doc.querySelector('input').checked, true);
  assert.ok(doc.querySelector('ul ul strong')); assert.equal(doc.querySelector('ol').getAttribute('start'), '3');
  assert.equal(doc.querySelector('s').textContent, 'deleted'); assert.equal(doc.querySelector('[data-file-link]').dataset.fileLink, '../other.md');
  assert.equal(doc.querySelector('tbody td').textContent, 'a|b'); assert.ok(doc.querySelector('th.markdown-align-right'));
  assert.ok(doc.querySelector('[data-markdown-heading="fn-0"]')); assert.ok(doc.querySelector('[data-markdown-anchor="fnref-0-0"]'));
  assert.ok(doc.querySelector('.markdown-alert-note')); assert.equal(doc.querySelectorAll('math').length, 3);
  assert.ok(doc.querySelector('.hljs-keyword')); assert.ok(doc.querySelector('[data-markdown-copy]')); assert.equal(doc.querySelectorAll('.markdown-outline li').length, 3);
});

test('preview output keeps scripts, dangerous URLs and raw HTML inert; math cannot load resources', () => {
  const doc = render('<script>bad()</script>\n\n<img src="https://bad.test/a" onerror="bad()">\n\n[bad](javascript:bad()) ![bad](javascript:bad())\n\n$\\href{javascript:bad()}{bad}$ $\\includegraphics{https://bad.test/a}$\n\n![local](./图.png) ![remote](https://example.test/image.png)\n\n```mermaid\nflowchart TD\n A[<script>bad()</script>] --> B\n```');
  assert.equal(doc.querySelectorAll('script,iframe,img,[onerror],a[href^="javascript"],foreignObject').length, 0);
  assert.equal(doc.querySelectorAll('[data-markdown-image]').length, 2);
  assert.ok(doc.querySelector('[data-markdown-diagram]')); assert.match(doc.querySelector('pre code').textContent, /<script>/);
});

function page(t, source) {
  const dom = new JSDOM('<html data-theme="dark"><body><section data-module-theme="editor" data-theme="dark"><article></article></section></body></html>', { url: 'http://localhost' });
  const { window } = dom, article = window.document.querySelector('article'), calls = [], revoked = [], jobs = [];
  article.innerHTML = markdown(source, { document: true });
  let next = 0; window.URL.createObjectURL = () => `blob:local-${++next}`; window.URL.revokeObjectURL = url => revoked.push(url);
  window.navigator.clipboard = { writeText: async text => calls.push({ copied: text }) };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const api = async route => { calls.push({ route }); return { base64: 'iVBORw0KGgo=' }; };
  const diagram = (source, dark) => new Promise((resolve, reject) => jobs.push({ source, dark, resolve, reject }));
  const viewer = enhanceMarkdown(article, { api, entry: { cwd: '/project', path: 'docs/guide.md' }, resolveLink: resolveMarkdownLink, diagram });
  t.after(() => { viewer.dispose(); dom.window.close(); });
  return { window, article, viewer, jobs, calls, revoked };
}
test('diagrams support fit/zoom, source/copy, large view; theme regeneration ignores old responses and disposal releases images', async t => {
  const p = page(t, '```mermaid\nflowchart TD\n A --> B\n```'), figure = p.article.querySelector('figure');
  assert.equal(p.jobs.length, 1); assert.equal(p.jobs[0].dark, true);
  p.article.parentElement.dataset.theme = 'light'; await tick(); assert.equal(p.jobs.length, 2);
  p.jobs[1].resolve('<svg xmlns="http://www.w3.org/2000/svg"/>'); await tick();
  const image = figure.querySelector('img'); assert.ok(image); assert.equal(figure.querySelector('[data-diagram-action="download"]').disabled, false);
  p.jobs[0].resolve('<svg/>'); await tick(); assert.equal(figure.querySelector('img'), image);
  figure.querySelector('[data-diagram-action="in"]').click(); assert.equal(image.style.width, '125%');
  figure.querySelector('[data-diagram-action="fit"]').click(); assert.equal(image.style.width, '100%');
  figure.querySelector('[data-diagram-action="expand"]').click(); assert.equal(p.window.document.querySelector('dialog').dataset.theme, 'light');
  p.window.document.querySelector('dialog').close(); assert.equal(p.window.document.querySelector('dialog'), null);
  figure.querySelector('[data-markdown-copy]').click(); await tick(); assert.equal(p.calls[0].copied, 'flowchart TD\n A --> B');
  p.viewer.refresh(); assert.equal(p.jobs.length, 2); p.viewer.dispose(); assert.equal(p.revoked.length, 1);
});
test('diagram failure is isolated and retryable; a disposed preview never receives late results', async t => {
  const p = page(t, '# Survives\n\n```mermaid\nbad syntax\n```');
  p.jobs[0].reject(new Error('图表语法无法解析')); await tick();
  assert.match(p.article.textContent, /图表语法无法解析/); assert.equal(p.article.querySelector('details').open, true); assert.equal(p.article.querySelector('h1').textContent, 'Survives');
  p.article.querySelector('.markdown-diagram-canvas button').click(); assert.equal(p.jobs.length, 2);
  p.viewer.dispose(); p.jobs[1].resolve('<svg/>'); await tick(); assert.equal(p.article.querySelector('img'), null);
});
test('images resolve against the document, use existing authenticated API, and never automatically fetch external or escaping paths', async t => {
  const p = page(t, '![图](./images/chart.png)\n\n![外网](https://example.test/a.png)\n\n![越界](../../a.png)'); await tick();
  assert.equal(p.calls.length, 1); const url = new URL(p.calls[0].route, 'http://localhost'); assert.equal(url.pathname, '/api/project/artifact'); assert.equal(url.searchParams.get('path'), 'docs/images/chart.png');
  assert.equal(p.article.querySelectorAll('img').length, 1); assert.equal(p.article.querySelector('a').getAttribute('href'), 'https://example.test/a.png');
  assert.match(p.article.textContent, /不在当前项目/); p.viewer.dispose(); assert.equal(p.revoked.length, 1);
});

test('the actual project document renders all seven Mermaid diagrams with the local engine and rejects active SVG', async t => {
  // JSDOM has no text layout: the geometry shim tests SVG generation/structure,
  // not browser typography or visual fidelity.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const names = ['window', 'document', 'DOMParser', 'XMLSerializer', 'HTMLElement', 'SVGElement', 'Element', 'CSSStyleSheet', 'getComputedStyle'];
  const before = Object.fromEntries(names.map(name => [name, globalThis[name]]));
  for (const name of names) globalThis[name] = dom.window[name];
  dom.window.SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: Math.max(20, (this.textContent || '').length * 8), height: 20 }; };
  dom.window.SVGElement.prototype.getComputedTextLength = function () { return this.getBBox().width; };
  t.after(() => { dom.window.close(); Object.assign(globalThis, before); });
  const { renderDiagram, cleanSvg } = await import('../public/vendor/markdown/mermaid.js');
  const content = await readFile(new URL('../项目原理详解.md', import.meta.url), 'utf8');
  const sources = [...content.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(match => match[1]); assert.equal(sources.length, 7);
  for (const source of sources) {
    const svg = await renderDiagram(source, true); const output = new dom.window.DOMParser().parseFromString(svg, 'image/svg+xml');
    assert.equal(output.querySelector('parsererror'), null); assert.ok(output.querySelectorAll('path,line,rect,polygon').length > 1); assert.ok(output.querySelector('text'));
    assert.equal(output.querySelectorAll('foreignObject,script,a,image').length, 0);
  }
  const svg = cleanSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="bad()"><script>bad()</script><image href="https://bad.test/a"/><foreignObject><div>bad</div></foreignObject><a href="javascript:bad()"><text>bad</text></a><style>@import "https://bad.test/x"; .x{fill:url(https://bad.test/a)} .y{fill:url(#ok)}</style></svg>');
  assert.doesNotMatch(svg, /<script|<foreignObject|<image|onload=|javascript:|https:\/\/bad/); assert.match(svg, /url\(#ok\)/);
  await assert.rejects(renderDiagram('this is not a diagram', false)); assert.equal(dom.window.document.body.children.length, 0);
});
