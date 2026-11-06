import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { markdown } from '../public/markdown.js';
import { createMessageRenderer } from '../public/message-renderer.js';

const source = 'flowchart TD\n A[选择字段] --> B{结果是否确认}\n B -->|是| C[完成]\n B -->|否| A';
const fenced = value => '```mermaid\n' + value + '\n```';
const tick = () => new Promise(setImmediate);

function fixture(t) {
  const dom = new JSDOM('<html data-theme="dark"><body><section data-module-theme="chat" data-theme="dark"><article></article></section></body></html>', { url: 'http://localhost' });
  const { window } = dom, document = window.document, el = document.querySelector('article'), jobs = [], copied = [], revoked = [];
  let next = 0;
  window.URL.createObjectURL = () => `blob:diagram-${++next}`;
  window.URL.revokeObjectURL = value => revoked.push(value);
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async value => copied.push(value) } });
  const renderer = createMessageRenderer({ document, onCopy: value => copied.push(value), onOpenFile() {}, diagram: (text, dark) => new Promise((resolve, reject) => jobs.push({ text, dark, resolve, reject })) });
  const update = text => renderer.update(el, { type: 'agentMessage', text });
  t.after(() => { renderer.dispose(); dom.window.close(); });
  return { window, document, el, renderer, jobs, copied, revoked, update };
}

test('chat diagrams require a complete Mermaid fence; plain text, examples and partial streaming remain inert code', () => {
  for (const text of [source, fenced(source), '```mermaid\n' + source]) assert.doesNotMatch(markdown(text), /data-markdown-diagram/);
  assert.doesNotMatch(markdown('```mermaid\n' + source, { diagrams: true }), /data-markdown-diagram/);
  const fragment = JSDOM.fragment(markdown('````text\n' + fenced(source) + '\n````', { diagrams: true }));
  assert.equal(fragment.querySelector('figure'), null); assert.match(fragment.querySelector('code').textContent, /```mermaid/);
  const nested = source + '\n A["``` <script>bad()</script>"]';
  const rendered = JSDOM.fragment(markdown('````mermaid\n' + nested + '\n````', { diagrams: true }));
  assert.ok(rendered.querySelector('[data-markdown-diagram]')); assert.equal(rendered.querySelector('script'), null);
  assert.equal(rendered.querySelector('pre code').textContent, nested);
});

test('complete reply diagrams render once, keep zoom and source disclosure through streaming, and copy the exact source', async t => {
  const p = fixture(t); p.update('```mermaid\n' + source); assert.equal(p.jobs.length, 0);
  p.update(fenced(source)); assert.equal(p.jobs.length, 1); assert.equal(p.jobs[0].text, source); assert.equal(p.jobs[0].dark, true);
  p.jobs[0].resolve('<svg xmlns="http://www.w3.org/2000/svg"/>'); await tick();
  const figure = p.el.querySelector('figure'), image = figure.querySelector('img'); assert.ok(image);
  figure.querySelector('[data-diagram-action="in"]').click(); figure.querySelector('details').open = true;
  p.update(fenced(source) + '\n\n后续说明');
  assert.equal(p.jobs.length, 1); assert.equal(p.el.querySelector('figure'), figure); assert.equal(figure.querySelector('img'), image);
  assert.equal(image.style.width, '125%'); assert.equal(figure.querySelector('details').open, true);
  assert.equal(figure.querySelectorAll('.code-copy').length, 0);
  figure.querySelector('[data-markdown-copy]').click(); await tick(); assert.equal(p.copied.at(-1), source);
  p.el.querySelector('.copy-response').click(); assert.equal(p.copied.at(-1), fenced(source) + '\n\n后续说明');
});

test('changed diagram source disposes its old renderer and cannot display a late old result; removal releases the current image', async t => {
  const p = fixture(t); p.update(fenced(source)); p.update(fenced('flowchart LR\n X --> Y'));
  assert.equal(p.jobs.length, 2); p.jobs[0].resolve('<svg/>'); await tick(); assert.equal(p.el.querySelector('img:not(.message-label img)'), null);
  p.jobs[1].resolve('<svg xmlns="http://www.w3.org/2000/svg"/>'); await tick();
  assert.ok(p.el.querySelector('.markdown-diagram-canvas img')); assert.equal(p.el.querySelector('pre code').textContent, 'flowchart LR\n X --> Y');
  p.el.remove(); await tick(); assert.deepEqual(p.revoked, ['blob:diagram-1']);
});

test('diagram errors preserve the rest of the reply and allow a local retry; theme changes ignore stale results', async t => {
  const p = fixture(t); p.update('说明\n\n' + fenced(source));
  p.jobs[0].reject(new Error('图表语法无法解析')); await tick();
  assert.match(p.el.textContent, /说明/); assert.equal(p.el.querySelector('details').open, true);
  p.el.querySelector('.markdown-diagram-canvas button').click(); assert.equal(p.jobs.length, 2);
  p.el.parentElement.dataset.theme = 'light'; await tick(); assert.equal(p.jobs.length, 3); assert.equal(p.jobs[2].dark, false);
  p.jobs[1].resolve('<svg/>'); await tick(); assert.equal(p.el.querySelector('.markdown-diagram-canvas img'), null);
  p.jobs[2].resolve('<svg xmlns="http://www.w3.org/2000/svg"/>'); await tick(); assert.ok(p.el.querySelector('.markdown-diagram-canvas img'));
  p.update('普通说明'); assert.equal(p.el.querySelector('[data-markdown-diagram]'), null); assert.deepEqual(p.revoked, ['blob:diagram-1']);
});

test('selecting diagram source defers a reply update until selection ends, preserving the visible copy snapshot', t => {
  const p = fixture(t); p.update(fenced(source));
  const code = p.el.querySelector('pre code'), range = p.document.createRange(); range.selectNodeContents(code); p.document.getSelection().addRange(range);
  p.update('更新说明'); assert.equal(p.el.querySelector('pre code'), code); assert.equal(p.el.querySelector('.reply-refresh').hidden, false);
  p.el.querySelector('.copy-response').click(); assert.equal(p.copied.at(-1), fenced(source));
  p.document.getSelection().removeAllRanges(); p.document.dispatchEvent(new p.window.Event('selectionchange'));
  assert.equal(p.el.querySelector('pre code'), null); assert.match(p.el.textContent, /更新说明/);
});
