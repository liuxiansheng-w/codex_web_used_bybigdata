import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createArtifactViewer } from '../public/artifact-viewer.js';

const settle = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('viewer did not settle'); };
const source = (rows, extra = {}) => ({ sheets: ['导出', '金额'], sheet: 0, columns: ['A', 'B', 'C'], rows, totalRows: rows.length, totalColumns: 3, limited: false, ...extra });
function browser(t, response = source([['日志ID', '用户姓名', '金额'], ['001', '甲', '0.1'], ['002', '乙', '0.2']]), state = {}) {
  const errors = [], vc = new VirtualConsole(); vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<html data-theme="dark"><body><section data-module-theme="editor" data-theme="light" data-skin="modern"><div id="host"></div></section></body></html>', { url: 'http://localhost', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom, document = window.document;
  const descriptors = Object.fromEntries(['window', 'document', 'navigator', 'Option'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, Option: window.Option })) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  let clipboard = ''; Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async text => { clipboard = text; } } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const calls = [], api = async (route, body) => { calls.push({ route, body }); assert.equal(route, '/api/project/spreadsheet'); return typeof response === 'function' ? response(body) : response; };
  const host = document.getElementById('host'), viewer = createArtifactViewer({ container: host, bytes: new Uint8Array(), entry: { cwd: '/project', path: 'export.xlsx' }, result: { extension: '.xlsx', version: 'v1', name: 'export.xlsx' }, api, state });
  const $ = selector => document.querySelector(selector), $$ = selector => [...document.querySelectorAll(selector)];
  const findButton = (text, scope = document) => [...scope.querySelectorAll('button')].find(button => button.textContent === text);
  const click = (text, scope) => { const button = findButton(text, scope); assert.ok(button, text); button.click(); };
  const input = (selector, value) => { const el = $(selector); el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const menu = index => { $$('.sheet-scroll .sql-column-trigger')[index].click(); return $('.sheet-value-menu'); };
  const rows = () => $$('.sheet-scroll tbody tr').map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent));
  const ready = () => settle(() => !!$('.sheet-scroll table') && !$('.sheet-toolbar input').disabled);
  const pointer = (type, target, extra = {}) => { const e = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(e, { button: 0, pointerId: 1, isPrimary: true, clientX: 30, clientY: 70, ...extra }); target.dispatchEvent(e); };
  t.after(() => { viewer.dispose(); window.close(); for (const [key, descriptor] of Object.entries(descriptors)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; assert.deepEqual(errors, []); });
  return { window, document, host, viewer, state, calls, $, $$, ready, rows, click, menu, input, pointer, clipboard: () => clipboard };
}

test('Excel uses the first row as actual headers, excludes it from data, copying and exports, and preserves original worksheet row numbers', async t => {
  const b = browser(t); await b.ready();
  assert.deepEqual(b.$$('.sql-column-sort').map(el => el.textContent), ['日志ID', '用户姓名', '金额']);
  assert.deepEqual(b.rows(), [['001', '甲', '0.1'], ['002', '乙', '0.2']]);
  assert.deepEqual(b.$$('.sheet-scroll tbody th').map(el => el.textContent), ['2', '3']);
  assert.match(b.$('.document-preview > [role=status]').textContent, /2 行数据.*首行为表头/);
  b.click('复制表头'); await settle(() => b.clipboard()); assert.equal(b.clipboard(), '日志ID\t用户姓名\t金额');
  b.click('复制表格'); await settle(() => b.clipboard().includes('\n')); assert.equal(b.clipboard().split('\n').length, 3);
  b.menu(1); b.click('复制此列（含表头）', b.$('.sheet-value-menu')); await settle(() => b.clipboard().startsWith('用户姓名\n')); assert.equal(b.clipboard(), '用户姓名\n甲\n乙');
  let exported, filename;
  const createUrl = URL.createObjectURL; URL.createObjectURL = blob => { exported = blob; return createUrl(blob); }; t.after(() => { URL.createObjectURL = createUrl; });
  b.window.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
  b.input('.sheet-toolbar input', '甲'); b.click('下载筛选');
  const bytes = new Uint8Array(await exported.arrayBuffer()); assert.deepEqual([...bytes.slice(0, 3)], [239, 187, 191]);
  assert.equal(new TextDecoder().decode(bytes), '"日志ID","用户姓名","金额"\r\n"001","甲","0.1"'); assert.equal(filename, '导出-筛选.csv');
  b.input('.sheet-toolbar input', '日志ID'); assert.equal(b.rows().length, 0, 'headers are not filtered as a data row');
  b.click('清空筛选'); assert.equal(b.rows().length, 2); assert.equal(b.calls.length, 1);
});

test('Excel filters provide distinct counts, search, all/invert/none, transactional cancel and conditions across loaded pages', async t => {
  const data = source([['编号', '类别', '金额'], ...Array.from({ length: 260 }, (_, i) => [String(i), i % 2 ? '乙' : '甲', String(i)])]);
  const b = browser(t, data); await b.ready(); const menu = b.menu(1);
  assert.deepEqual(b.$$('.sql-value-option small').map(el => el.textContent), ['(130)', '(130)']);
  b.click('清空', menu); b.click('取消', menu); assert.equal(b.rows().length, 100);
  b.menu(1); b.input('.sheet-value-menu input[type=search]', '乙'); b.click('确认', menu);
  assert.ok(b.rows().every(row => row[1] === '乙')); assert.match(b.$('.sheet-pagination').textContent, /130 \/ 260 行/);
  b.click('下一页'); assert.equal(b.rows().length, 30);
  b.menu(2); b.click('降序 ↓', menu); assert.equal(b.rows()[0][2], '259');
  b.menu(1); b.click('清空', menu); b.click('确认', menu); assert.equal(b.rows().length, 0); assert.equal(b.$$('.sql-column-sort').length, 3);
  b.menu(1); b.click('全选', menu); b.click('反选', menu); b.click('反选', menu); b.click('确认', menu); assert.equal(b.rows().length, 100);
  b.menu(2); const operator = b.$('select[aria-label="列筛选方式"]'); operator.value = 'gt'; operator.dispatchEvent(new b.window.Event('change')); b.$('input[aria-label="工作表列筛选值"]').value = '255'; b.click('应用条件', menu);
  assert.deepEqual(b.rows().map(row => row[2]), ['259', '258', '257', '256']);
  b.menu(1); assert.deepEqual(b.$$('.sql-value-option small').map(el => el.textContent), ['(2)', '(2)']); b.click('取消', menu);
  assert.equal(b.calls.length, 1, 'all table operations work locally without running a query');
});

test('duplicate and blank headers keep independent column identities and escape cell/header HTML', async t => {
  const b = browser(t, source([['名称', '名称', ''], ['<img src=x onerror=bad>', '甲', '1'], ['其他', '乙', '2']])); await b.ready();
  assert.deepEqual(b.$$('.sql-column-sort').map(el => el.textContent), ['名称', '名称', '列 C']);
  assert.equal(b.$$('img, script').length, 0);
  b.menu(1); b.input('.sheet-value-menu input[type=search]', '甲'); b.click('确认', b.$('.sheet-value-menu')); assert.deepEqual(b.rows(), [['<img src=x onerror=bad>', '甲', '1']]);
  b.menu(0); assert.equal(b.$('.sheet-value-menu').dataset.theme, 'light'); b.click('复制列名', b.$('.sheet-value-menu')); await settle(() => b.clipboard()); assert.equal(b.clipboard(), '名称');
});

test('selection uses SQL cell statistics and shortcuts; filtering, paging and sorting invalidate old ranges', async t => {
  const b = browser(t); await b.ready();
  const cell = (r, c) => b.$(`[data-result-row="${r}"][data-result-column="${c}"]`);
  b.pointer('pointerdown', cell(0, 2)); b.pointer('pointerup', cell(0, 2));
  b.pointer('pointerdown', cell(1, 2), { shiftKey: true }); b.pointer('pointerup', cell(1, 2));
  assert.match(b.$('.sql-selection-stats').textContent, /计数 2数值 2求和 0.3平均值 0.15最大值 0.2最小值 0.1/);
  b.$('table').dispatchEvent(new b.window.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true })); await settle(() => b.clipboard()); assert.equal(b.clipboard(), '0.1\n0.2');
  b.input('.sheet-toolbar input', '甲'); assert.equal(b.$('.sql-selection-stats').hidden, true);
  b.click('清空筛选'); b.pointer('pointerdown', cell(0, 2)); b.pointer('pointerup', cell(0, 2)); b.menu(2); b.click('降序 ↓', b.$('.sheet-value-menu')); assert.equal(b.$('.sql-selection-stats').hidden, true);
  b.$('table').focus(); b.$('table').dispatchEvent(new b.window.KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true })); assert.match(b.$('.sql-selection-stats').textContent, /计数 6/);
  b.$('table').dispatchEvent(new b.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); assert.equal(b.$('.sql-selection-stats').hidden, true);
});

test('sheets preserve independent filters, page size and position; hidden/disposed previews close menus and ignore late replies', async t => {
  let resolveSecond;
  const state = {}, data = source([['编号', '类别', '金额'], ...Array.from({ length: 140 }, (_, i) => [String(i), '甲', String(i)])], { limited: true, totalRows: 10001 });
  const b = browser(t, body => body.sheet === 0 ? data : new Promise(resolve => { resolveSecond = resolve; }), state); await b.ready();
  const size = b.$('.sheet-pagination select'); size.value = '50'; size.dispatchEvent(new b.window.Event('change')); b.click('下一页');
  assert.equal(b.rows()[0][0], '50'); assert.equal(state.sheets[0].pageSize, 50); assert.match(b.$('.document-preview > [role=status]').textContent, /10000 行数据.*已加载 140 行/);
  b.$('.sheet-scroll').scrollTop = 75; b.$('.sheet-scroll').dispatchEvent(new b.window.Event('scroll'));
  b.menu(1); b.host.hidden = true; await new Promise(setImmediate); assert.equal(b.$('.sheet-value-menu').hidden, true); b.host.hidden = false; b.viewer.resume(); assert.equal(b.$('.sheet-scroll').scrollTop, 75);
  b.click('金额', b.$('.sheet-tabs')); await settle(() => resolveSecond); b.click('导出', b.$('.sheet-tabs')); await b.ready();
  resolveSecond(source([['不同表头', '名称', '值'], ['other', '乙', '4']], { sheet: 1 })); await new Promise(setImmediate); assert.equal(b.$('.sql-column-sort').textContent, '编号'); assert.equal(b.rows()[0][0], '50');
  b.click('金额', b.$('.sheet-tabs')); await settle(() => b.$('.sql-column-sort').textContent === '不同表头'); assert.equal(b.rows()[0][0], 'other');
  b.click('导出', b.$('.sheet-tabs')); await settle(() => b.$('.sql-column-sort').textContent === '编号'); assert.equal(b.rows()[0][0], '50'); assert.equal(b.calls.length, 2);
  b.menu(1); b.viewer.dispose(); assert.equal(b.$('.sheet-value-menu'), null); assert.equal(b.$('.document-preview'), null);
});

test('header-only and empty workbooks keep headings without manufacturing data', async t => {
  const b = browser(t, source([['标题', '', '']])); await b.ready();
  assert.deepEqual(b.rows(), []); assert.deepEqual(b.$$('.sql-column-sort').map(el => el.textContent), ['标题', '列 B', '列 C']);
  b.menu(0); assert.equal(b.$$('.sql-value-option').length, 0); assert.match(b.$('.sheet-value-menu').textContent, /没有匹配的值/);
});

test('value operations include entries past the first DOM batch and copied cells keep spreadsheet formulas inert', async t => {
  const b = browser(t, source([['编号', '文本', '值'], ...Array.from({ length: 320 }, (_, i) => [String(i), '=1+2', String(i)])])); await b.ready();
  const menu = b.menu(0); assert.equal(b.$$('.sql-value-option').length, 200);
  b.click('清空', menu); b.click('反选', menu); b.click('确认', menu); assert.match(b.$('.sheet-pagination').textContent, /320 \/ 320 行/);
  b.menu(0); b.input('.sheet-value-menu input[type=search]', '319'); b.click('确认', menu); assert.deepEqual(b.rows(), [['319', '=1+2', '319']]);
  b.click('复制表格'); await settle(() => b.clipboard()); assert.equal(b.clipboard(), "编号\t文本\t值\n319\t'=1+2\t319");
  const size = b.$('.sheet-pagination select'); size.value = '50'; size.dispatchEvent(new b.window.Event('change'));
  assert.equal(b.$('.sql-selection-stats').hidden, true); assert.equal(b.calls.length, 1);
});
