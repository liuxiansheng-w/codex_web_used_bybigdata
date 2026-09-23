import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { markdown, tableClipboard, bindMarkdownTableCopy } from '../public/markdown.js';

const source = '| 服务状态 | 服务记录数 | 涉及权益卡数 |\n| --- | --- | --- |\n| 待确认 | 53 | 5 |\n| 已取消 | 2 | 2 |';
const settle = () => new Promise(resolve => setImmediate(resolve));
function page(t, content = source) {
  const dom = new JSDOM(`<form><main>${markdown(content)}</main></form>`, { url: 'http://localhost' });
  const { window } = dom, doc = window.document, messages = [];
  const dispose = bindMarkdownTableCopy(doc, { notify: text => messages.push(text) });
  t.after(() => { dispose(); window.close(); });
  return { window, doc, messages, dispose };
}
const readBlob = (window, blob) => new Promise(resolve => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });

test('each chat table copies only its own displayed header and data; delegated binding covers later messages without duplicates', async t => {
  const p = page(t, `回复正文\n\n${source}\n\n| 列 | 值 |\n| --- | --- |\n| 另一表 | 9 |`), copied = [];
  p.window.navigator.clipboard = { writeText: async text => copied.push(text) };
  bindMarkdownTableCopy(p.doc);
  const buttons = p.doc.querySelectorAll('[data-copy-markdown-table]'); assert.equal(buttons.length, 2); assert.equal(buttons[0].type, 'button');
  buttons[0].click(); await settle(); assert.equal(copied[0], '服务状态\t服务记录数\t涉及权益卡数\n待确认\t53\t5\n已取消\t2\t2'); assert.equal(buttons[0].textContent, '已复制');
  buttons[1].click(); await settle(); assert.equal(copied[1], '列\t值\n另一表\t9');
  p.doc.querySelector('main').innerHTML = markdown(source.replace('53', '54'));
  p.doc.querySelector('[data-copy-markdown-table]').click(); await settle(); assert.match(copied[2], /待确认\t54\t5/); assert.equal(copied.length, 3); assert.equal(p.messages.length, 3);
});

test('rich clipboard includes an inert HTML table and TSV with header, empty cells, line breaks and exact displayed precision', async t => {
  const p = page(t), writes = [];
  p.window.ClipboardItem = class { constructor(value) { this.value = value; } };
  p.window.navigator.clipboard = { write: async items => writes.push(items), writeText() { assert.fail('rich write succeeded'); } };
  const table = p.doc.querySelector('table');
  table.innerHTML = '<thead><tr><th>说明</th><th>值</th><th>空</th></tr></thead><tbody><tr><td><button data-file-link="/private/a.sql">文件</button><br>下一行</td><td>0.30000000000000004</td><td></td></tr></tbody>';
  p.doc.querySelector('[data-copy-markdown-table]').click(); await settle();
  const item = writes[0][0].value, text = await readBlob(p.window, item['text/plain']), html = await readBlob(p.window, item['text/html']);
  assert.equal(text, '说明\t值\t空\n"文件\n下一行"\t0.30000000000000004\t');
  const fragment = JSDOM.fragment(html); assert.equal(fragment.querySelectorAll('tr').length, 2); assert.equal(fragment.querySelectorAll('th').length, 3); assert.equal(fragment.querySelectorAll('td').length, 3);
  assert.ok(fragment.querySelector('br')); assert.equal(fragment.querySelector('button'), null); assert.doesNotMatch(html, /private|data-file-link|复制表格/);
  table.rows[1].cells[0].textContent = '<img src=x onerror=bad()>\t"quoted"'; table.rows[1].cells[1].textContent = '=HYPERLINK("https://example.test")';
  const payload = tableClipboard(table); assert.equal(JSDOM.fragment(payload.html).querySelector('img'), null); assert.match(payload.text, /'=HYPERLINK/); assert.match(payload.text, /""quoted""/);
  table.rows[1].cells[1].textContent = '-1.20'; assert.match(tableClipboard(table).text, /\t-1\.20\t$/);
});

test('unsupported rich copy falls back to TSV; rapid clicks write once; denied clipboard reports failure and permits retry', async t => {
  const p = page(t), button = p.doc.querySelector('[data-copy-markdown-table]'); let resolve, writes = 0;
  p.window.ClipboardItem = class {};
  p.window.navigator.clipboard = { write: async () => { throw new Error('format unsupported'); }, writeText: () => { writes++; return new Promise(done => { resolve = done; }); } };
  button.click(); button.click(); await settle(); assert.equal(writes, 1); assert.equal(button.disabled, true);
  resolve(); await settle(); assert.equal(button.disabled, false); assert.equal(button.textContent, '已复制');
  p.window.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  button.click(); await settle(); assert.equal(button.textContent, '复制失败，重试'); assert.equal(button.disabled, false); assert.match(p.messages.at(-1), /剪贴板不可用/);
  p.window.navigator.clipboard.writeText = async () => { writes++; };
  button.click(); await settle(); assert.equal(button.textContent, '已复制'); assert.equal(writes, 2);
  p.dispose(); button.click(); await settle(); assert.equal(writes, 2);
});
