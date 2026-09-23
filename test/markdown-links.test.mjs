import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { markdown } from '../public/markdown.js';

const render = value => JSDOM.fragment(markdown(value));

test('Markdown file citations accept angle targets, spaces, Unicode and line anchors', () => {
  const target = '/Users/example/dw_job/QSC数仓作业/ADS/保险 报表/订单(v2).sql';
  const fragment = render(`源码位置：[订单.sql:204](<${target}:204>)、[订单.sql:214](<${target}:214>)\n\n[说明](docs/review(v2).md#L8)\n\n[相对](<保险 报表/订单.sql:6>)`);
  assert.deepEqual([...fragment.querySelectorAll('[data-file-link]')].map(el => [el.textContent, el.dataset.fileLink]), [
    ['订单.sql:204', `${target}:204`], ['订单.sql:214', `${target}:214`], ['说明', 'docs/review(v2).md#L8'], ['相对', '保险 报表/订单.sql:6'],
  ]);
  assert.equal(render('[a.sql:5](a.sql:5)').querySelector('button').dataset.fileLink, 'a.sql:5');
  const codeLabel = render('[`订单.sql:204`](</project/订单.sql:204>)').querySelector('button');
  assert.equal(codeLabel.querySelector('code').textContent, '订单.sql:204');
  assert.ok(!codeLabel.innerHTML.includes('\u0000'));
});

test('file link parsing keeps code, incomplete citations, unsafe schemes and HTML inert', () => {
  const fragment = render('`[代码示例](</project/a.sql:2>)`\n\n```md\n[示例](</project/b.sql>)\n```\n\n[x](<javascript:bad.sql>) [x](javascript:alert(1)) [x](<data:text/html,bad.sql>) [x](<file:///etc/a.sql>)\n\n[未结束](</project/a.sql:3>\n\n<script>alert(1)</script>');
  assert.equal(fragment.querySelectorAll('button, a, script').length, 0);
  const escaped = render('[<img src=x onerror=bad>](</project/a" autofocus onfocus="bad & review.sql:4>)');
  const link = escaped.querySelector('button');
  assert.equal(link.dataset.fileLink, '/project/a" autofocus onfocus="bad & review.sql:4');
  assert.equal(link.hasAttribute('onfocus'), false); assert.equal(link.hasAttribute('autofocus'), false);
  assert.equal(escaped.querySelector('img'), null);
  const external = render('[文档](<https://example.com/a(b)?x=1&y=2>)').querySelector('a');
  assert.equal(external.getAttribute('href'), 'https://example.com/a(b)?x=1&y=2');
  assert.equal(external.rel, 'noopener noreferrer');
});
