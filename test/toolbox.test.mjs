import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { parseJson, printJson, parseCsv, printCsv, runTool, MAX_TEXT } from '../public/toolbox-core.js';
import { createToolbox } from '../public/toolbox.js';
import { createFileEditor } from '../public/file-editor.js';
import { createModuleThemeControls } from '../public/interactions.js';
import { EventEmitter } from 'node:events';
import { createApplication } from '../server.mjs';

const run = (category, action, input, extra = {}) => runTool({ category, action, input, ...extra });
test('JSON formatting preserves long IDs, exact decimals, exponent tokens, duplicate keys and strict syntax', async () => {
  const input = '{"订单":9223372036854775807123,"金额":1.0000000000000000001,"n":-0,"e":1E+300,"重复":1,"重复":2}';
  const formatted = await run('json', 'format', input);
  assert.equal((await run('json', 'minify', formatted.text)).text, input);
  assert.match(formatted.text, /1\.0000000000000000001/);
  assert.equal((await run('json', 'minify', '{"__proto__":{"x":1}}')).text, '{"__proto__":{"x":1}}');
  assert.equal(({}).x, undefined);
  for (const invalid of ['{"x":1,}', '[1,]', '01', 'NaN', '{"x":"\n"}', 'true false', '"\\uXXXX"', '{unquoted:1}']) await assert.rejects(run('json', 'validate', invalid), /第 \d+ 行/);
  await assert.rejects(run('json', 'format', '['.repeat(130) + '0' + ']'.repeat(130)), /128/);
  assert.throws(() => parseJson(' '.repeat(MAX_TEXT + 1)), /200 万/);
  assert.equal(printJson(parseJson('{"b":1,"a":2}'), { sort: true, indent: 0 }), '{"a":2,"b":1}');
});
test('JSON string escaping and lazy tree data retain inert HTML and original values', async () => {
  const text = '中文\n"quote" \\ <img src=x onerror=alert(1)> 😀';
  assert.equal((await run('json', 'unescape', (await run('json', 'escape', text)).text)).text, text);
  await assert.rejects(run('json', 'unescape', '{}'), /字符串/);
  assert.equal((await run('json', 'tree', '{"x":9007199254740993}')).tree.entries[0].node.raw, '9007199254740993');
});
test('JSON extraction follows explicit paths without losing numeric tokens or silently skipping fields', async () => {
  const input = '{"data":[{"id":9007199254740993123,"amount":1.000000000000000001},{"id":42,"amount":2}],"a.b":{"name":"值"}}';
  const ids = await run('json', 'extract', input, { path: '$.data[*].id' });
  assert.match(ids.text, /9007199254740993123/); assert.match(ids.text, /42/); assert.match(ids.message, /2 项/);
  assert.equal((await run('json', 'extract', input, { path: '$["a.b"].name' })).text, '"值"');
  assert.equal((await run('json', 'extract', input, { path: '$.data[0].amount' })).text, '1.000000000000000001');
  assert.equal((await run('json', 'extract', '{"data":[]}', { path: '$.data[*].id' })).text, '[]');
  await assert.rejects(run('json', 'extract', '{"data":[{"id":1},{}]}', { path: '$.data[*].id' }), /不存在/);
  await assert.rejects(run('json', 'extract', '{"id":1,"id":2}', { path: '$.id' }), /重复/);
  for (const path of ['data.id', '$.data[-1]', '$.data[0].id()', '$.data[9999999999999999999]']) await assert.rejects(run('json', 'extract', input, { path }));
});
test('batch lists keep string identifiers, escape quotes and require explicit deduplication', async () => {
  const input = "001\nO'Brien\n001\n\n";
  const raw = await run('data-clean', 'sql-string', input);
  assert.equal(raw.text, "(\n  '001',\n  'O''Brien',\n  '001'\n)"); assert.match(raw.message, /未执行查询/);
  assert.equal((await run('data-clean', 'sql-string', input, { deduplicate: true })).text, "(\n  '001',\n  'O''Brien'\n)");
  assert.equal((await run('data-clean', 'sql-string', "O'Brien\na\\b", { sqlStyle: 'backslash' })).text, "(\n  'O\\'Brien',\n  'a\\\\b'\n)");
  assert.equal((await run('data-clean', 'sql-number', '12\n-2.5\n12')).text, '(\n  12,\n  -2.5,\n  12\n)');
  assert.equal((await run('data-clean', 'fields', '  user_id  \n amount \n')).text, 'user_id,\namount');
  await assert.rejects(run('data-clean', 'sql-number', '001'), /前导零/);
  await assert.rejects(run('data-clean', 'sql-string', 'a\\b'), /反斜杠/);
  await assert.rejects(run('data-clean', 'sql-string', 'a\tb', { sqlStyle: 'backslash' }), /控制字符/);
  await assert.rejects(run('data-clean', 'sql-string', '\n\n'), /非空/);
});
test('encoding round-trips UTF-8, emoji and URL reserved characters with useful invalid-input errors', async () => {
  const text = '中文😀 /?q=+&x=1\n';
  for (const prefix of ['base64', 'url', 'unicode']) {
    const encoded = await run('encoding', prefix + '-encode', text);
    assert.equal((await run('encoding', prefix + '-decode', encoded.text)).text, text);
  }
  assert.equal((await run('encoding', 'unicode-decode', '\\u{1f600}')).text, '😀');
  for (const [action, input] of [['base64-decode', '@@@'], ['base64-decode', '/w=='], ['url-decode', '%zz'], ['unicode-decode', '\\u12xx'], ['unicode-decode', '\\u{110000}']]) await assert.rejects(run('encoding', action, input));
});
test('comparison aligns inserted lines and compares JSON independently of object key order', async () => {
  assert.equal((await run('json', 'compare', '{"b":2,"a":1}', { secondary: '{ "a": 1, "b": 2 }' })).text, '内容一致。');
  const diff = await run('text', 'compare', 'a\nb\nc\n', { secondary: 'a\nnew\nb\nc\n' });
  assert.equal(diff.diff.filter(part => part.added).map(part => part.value).join(''), 'new\n');
  assert.equal(diff.diff.some(part => part.removed), false);
  const append = await run('text', 'compare', 'a\nb', { secondary: 'a\nb\nc' });
  assert.equal(append.diff.some(part => part.removed), false); assert.match(append.text, /\+ c/);
  const newline = await run('text', 'compare', 'a', { secondary: 'a\n' }); assert.match(newline.text, /文件末尾换行：原文无/);
  assert.equal((await run('text', 'dedup', 'a\na\nA\n a')).text, 'a\nA\n a');
  assert.match((await run('text', 'stats', '中😀\nx')).text, /字符数：4/);
});
test('time conversion uses Beijing regardless of host timezone, including epoch zero and invalid dates', async () => {
  assert.match((await run('time', 'seconds', '0')).text, /1970-01-01 08:00:00\.000/);
  assert.match((await run('time', 'date', '1970-01-01 08:00:00')).text, /Unix 毫秒：0/);
  assert.match((await run('time', 'date', '2024-02-29 00:00:00.123')).text, /\.123/);
  for (const input of ['2023-02-29 00:00:00', '2024-02-30 01:01:01', '2026-13-01 00:00:00', '2026-01-01 25:00:00', '01/02/2026']) await assert.rejects(run('time', 'date', input));
  const seconds = await run('time', 'auto', '1700000000'), millis = await run('time', 'auto', '1700000000000');
  assert.equal(seconds.text, millis.text); assert.deepEqual(seconds.fields.map(([label]) => label), ['北京时间（UTC+08:00）', 'Unix 秒', 'Unix 毫秒', 'UTC']);
  assert.equal((await run('time', 'auto', '2023-11-15 06:13:20')).text, seconds.text);
  await assert.rejects(run('time', 'auto', '12345'), /无法确定时间格式/);
});
test('CSV handles multiline quotes, preserves IDs and rejects ambiguous headers; downloads neutralize formulas', async () => {
  const csv = '\uFEFFid,note,empty\r\n9007199254740993,"a,""b""\nline",\r\n';
  const rows = parseCsv(csv); assert.equal(rows[1][1], 'a,"b"\nline'); assert.equal(rows[1][2], '');
  assert.deepEqual(parseCsv(printCsv(rows)), rows);
  const result = await run('data', 'csv-json', csv); assert.equal(JSON.parse(result.text)[0].id, '9007199254740993');
  assert.deepEqual(JSON.parse((await run('data', 'csv-json', '__proto__,x\ntext,1')).text), [JSON.parse('{"__proto__":"text","x":"1"}')]);
  for (const invalid of ['x,x\n1,2', ',x\n1,2', 'x\n1,2', 'x\n"bad']) await assert.rejects(run('data', 'csv-json', invalid));
  const output = await run('data', 'json-csv', '[{"id":9007199254740993,"formula":"=1+1","amount":-12}]');
  assert.match(output.text, /9007199254740993,=1\+1,-12/);
  assert.match(output.downloadText, /9007199254740993,'=1\+1,-12/);
});
test('Excel export uses text cells without formulas; import reads cached values without evaluation', async () => {
  const xlsx = await import('../public/vendor/toolbox.js');
  const result = await run('data', 'json-xlsx', '[{"id":9007199254740993,"note":"=1+1"}]');
  const book = xlsx.read(result.binary, { type: 'array' }); const sheet = book.Sheets[book.SheetNames[0]];
  assert.equal(sheet.A2.v, '9007199254740993'); assert.equal(sheet.A2.t, 's'); assert.equal(sheet.B2.v, '=1+1'); assert.equal(sheet.B2.f, undefined);
  const imported = await runTool({ category: 'data', action: 'xlsx-json', file: result.binary });
  assert.equal(imported.sheets[0].name, '数据'); assert.match(imported.sheets[0].csv, /9007199254740993/);
  const ambiguous = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(ambiguous, { '!ref': 'A1:A25000' }, 'too big');
  await assert.rejects(runTool({ category: 'data', action: 'xlsx-json', file: xlsx.write(ambiguous, { bookType: 'xlsx', type: 'array' }) }), /2 万/);
});

async function page(t, runner, formatSql) {
  const errors = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://localhost', pretendToBeVisual: true, virtualConsole: console });
  const saved = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage });
  const calls = [], editor = createFileEditor({ api: async (route, body) => { calls.push({ route, body }); const path = new URL(route, 'http://localhost').searchParams.get('path'); return { cwd: '/project', path, content: 'prefix {"id":9007199254740993} suffix', version: 'v1', writable: !path?.includes('readonly'), newline: 'LF' }; }, onAttach() {} });
  const toolbox = createToolbox({ editor, runner: runner || { cancel() {}, run: runTool }, formatSql });
  t.after(async () => { toolbox.destroy(); await new Promise(resolve => setTimeout(resolve, 15)); dom.window.close(); Object.assign(globalThis, saved); assert.deepEqual(errors, []); });
  const $ = id => dom.window.document.getElementById(id);
  const input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const settle = async condition => { for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(setImmediate); } assert.fail('toolbox did not settle'); };
  return { dom, $, editor, toolbox, calls, input, settle };
}
test('toolbox moves between workspace and floating modes without losing its draft', async t => {
  const { $, toolbox, input } = await page(t);
  toolbox.open(); assert.equal($('toolboxPanel').parentElement.id, 'workspacePanes'); assert.equal($('workspacePanes').classList.contains('toolbox-docked'), true);
  $('toolboxHome').querySelector('button').click(); input('toolboxInput', '虚构测试草稿');
  $('toolboxDock').click(); assert.equal($('toolboxPanel').parentElement.tagName, 'BODY'); assert.equal($('workspacePanes').classList.contains('toolbox-docked'), false); assert.equal($('toolboxInput').value, '虚构测试草稿');
  $('toolboxDock').click(); assert.equal($('toolboxPanel').parentElement.id, 'workspacePanes'); assert.equal($('toolboxInput').value, '虚构测试草稿');
  toolbox.close(); assert.equal($('workspacePanes').classList.contains('toolbox-docked'), false);
});
test('grouped navigation searches categories and actions while retaining collapse state and active input', async t => {
  const { $, dom, toolbox, input } = await page(t), doc = dom.window.document;
  toolbox.open(); assert.equal($('toolboxHome').hidden, false); doc.querySelector('[data-category=json]').click(); input('toolboxInput', '{"keep":"JSON draft"}');
  assert.equal(doc.querySelectorAll('#toolboxButton').length, 1, 'reuse the always-visible page entry');
  assert.equal(doc.querySelectorAll('.toolbox-group').length, 4);
  assert.equal(doc.querySelectorAll('[data-category]').length, 9);
  assert.equal($('toolboxBreadcrumb').textContent, '开发工具 / JSON');
  const development = doc.querySelector('[data-group=development]'); development.open = false;
  $('toolboxSearch').focus(); input('toolboxSearch', 'Base64');
  assert.equal(development.open, true); assert.equal(doc.querySelector('[data-category=encoding]').hidden, false);
  assert.equal(doc.querySelector('[data-category=json]').hidden, true);
  assert.equal(doc.querySelector('[data-group=text]').hidden, true);
  assert.equal($('toolboxSearchCount').textContent, '找到 1 个工具');
  assert.equal(doc.activeElement, $('toolboxSearch')); assert.equal($('toolboxInput').value, '{"keep":"JSON draft"}');
  input('toolboxSearch', '文本工具');
  assert.equal(doc.querySelector('[data-category=compare]').hidden, false); assert.equal(doc.querySelector('[data-category=text]').hidden, false);
  assert.equal($('toolboxSearchCount').textContent, '找到 2 个工具');
  input('toolboxSearch', 'no matching utility'); assert.equal($('toolboxSearchEmpty').hidden, false);
  $('toolboxSearchClear').click(); assert.equal(development.open, false);
  assert.equal($('toolboxSearchEmpty').hidden, true); assert.equal($('toolboxSearchCount').textContent, '4 个分类 · 9 个工具');
  assert.equal($('toolboxInput').value, '{"keep":"JSON draft"}');
});
test('task overview, favorites and recent tools remember only navigation while preserving in-page drafts', async t => {
  const { $, dom, toolbox, editor, input } = await page(t), doc = dom.window.document;
  toolbox.open(); assert.equal($('toolboxWorkspace').hidden, true);
  doc.querySelector('[data-quick-tool=json][data-quick-action=extract]').click();
  assert.equal($('toolboxHome').hidden, true); assert.equal($('toolboxAction').value, 'extract'); assert.equal($('toolboxPathLabel').hidden, false);
  input('toolboxInput', '{"private":"example"}'); $('toolboxFavorite').click();
  assert.equal($('toolboxFavorite').getAttribute('aria-pressed'), 'true'); $('toolboxHomeButton').click();
  assert.equal($('toolboxHome').hidden, false); assert.match($('toolboxHomeSaved').textContent, /我的收藏/);
  const saved = JSON.parse(dom.window.localStorage.getItem('lemon:toolboxNavigation'));
  assert.deepEqual(saved.favorites, ['json']); assert.deepEqual(saved.recent, ['json']);
  assert.equal(JSON.stringify(dom.window.localStorage).includes('private'), false);
  doc.querySelector('#toolboxHomeSaved [data-saved-tool=json]').click(); assert.equal($('toolboxInput').value, '{"private":"example"}');
  toolbox.destroy();
  const restored = createToolbox({ editor, runner: { cancel() {}, run: runTool } }); restored.open();
  assert.match($('toolboxHomeSaved').textContent, /我的收藏/); assert.equal($('toolboxInput').value, ''); restored.destroy();
});
test('overview search opens the matching action and time copy buttons cannot copy a stale result', async t => {
  const { $, dom, toolbox, input, settle } = await page(t), doc = dom.window.document, copied = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied.push(value); } } });
  toolbox.open(); input('toolboxSearch', 'Unicode 解码');
  const card = doc.querySelector('[data-quick-tool=encoding]'); assert.equal(card.hidden, false); card.click();
  assert.equal($('toolboxAction').value, 'unicode-decode'); $('toolboxSearchClear').click();
  doc.querySelector('[data-category=time]').click(); input('toolboxInput', '1700000000'); $('toolboxRun').click();
  await settle(() => !$('toolboxTimeResults').hidden);
  const copy = $('toolboxTimeResults').querySelector('button'); copy.click(); await new Promise(setImmediate); assert.match(copied[0], /^2023-11-15/);
  input('toolboxInput', '123'); assert.equal(copy.disabled, true); copy.click(); assert.equal(copied.length, 1);
});
test('small inputs preview automatically, while large inputs wait for an explicit request', async t => {
  const calls = [];
  const runner = { cancel() {}, async run(payload) { calls.push(payload); return runTool(payload); } };
  const { $, dom, toolbox, input, settle } = await page(t, runner), doc = dom.window.document;
  toolbox.open(); doc.querySelector('[data-category=json]').click(); input('toolboxInput', '{"id":9007199254740993}');
  await new Promise(resolve => setTimeout(resolve, 380)); await settle(() => !$('toolboxCopy').disabled);
  assert.match($('toolboxOutput').value, /9007199254740993/); assert.equal(calls.length, 1);
  doc.querySelector('[data-category=compare]').click(); input('toolboxInput', 'same\nold'); input('toolboxSecondary', 'same\nnew');
  await new Promise(resolve => setTimeout(resolve, 380)); await settle(() => !$('toolboxDiff').hidden);
  const rows = [...$('toolboxDiff').querySelectorAll('.toolbox-diff-row')];
  assert.ok(rows.some(row => row.textContent.includes('- old') && row.textContent.includes('+ new')));
  const previousCalls = calls.length; doc.querySelector('[data-category=text]').click(); input('toolboxInput', 'x'.repeat(80_001));
  await new Promise(resolve => setTimeout(resolve, 340)); assert.equal(calls.length, previousCalls); assert.match($('toolboxStatus').textContent, /内容较大/);
});
test('SQL formatting uses the existing static formatter on request and ignores a stale response', async t => {
  const calls = []; let finish;
  const formatSql = (content, dialect, signal) => { calls.push({ content, dialect, signal }); return new Promise(resolve => { finish = resolve; }); };
  const { $, dom, toolbox, editor, input, settle } = await page(t, undefined, formatSql), doc = dom.window.document;
  await editor.open({ cwd: '/project', path: 'sample.sql' });
  toolbox.open({ fromEditor: true }); assert.equal($('toolboxCategoryTitle').textContent, 'SQL 格式化'); assert.equal($('toolboxDialectLabel').hidden, false);
  input('toolboxInput', 'select 1'); await new Promise(resolve => setTimeout(resolve, 340)); assert.equal(calls.length, 0);
  $('toolboxDialect').value = 'hive'; $('toolboxDialect').dispatchEvent(new dom.window.Event('change'));
  $('toolboxRun').click(); assert.equal(calls.length, 1); assert.equal(calls[0].dialect, 'hive');
  input('toolboxInput', 'select 2'); assert.equal(calls[0].signal.aborted, true);
  finish({ content: 'SELECT 1' }); await new Promise(setImmediate); assert.equal($('toolboxOutput').value, '');
  $('toolboxRun').click(); finish({ content: 'SELECT 2' }); await settle(() => $('toolboxOutput').value === 'SELECT 2');
  assert.match($('toolboxStatus').textContent, /未执行查询/); assert.equal(doc.querySelector('#toolboxPanel').contains($('toolboxInput')), true);
});
test('text comparison and text cleanup keep independent drafts and dispatch the registered processor', async t => {
  const { $, dom, toolbox, input, settle, calls } = await page(t), doc = dom.window.document;
  toolbox.open(); doc.querySelector('[data-category=compare]').click();
  assert.equal($('toolboxBreadcrumb').textContent, '文本工具 / 文本对比');
  assert.equal($('toolboxSecond').hidden, false); input('toolboxInput', 'before\n'); input('toolboxSecondary', 'after\n');
  $('toolboxRun').click(); await settle(() => !$('toolboxCopy').disabled);
  assert.match($('toolboxDiff').textContent, /- before/); assert.match($('toolboxDiff').textContent, /\+ after/);
  assert.equal($('toolboxInsert').disabled, true);
  doc.querySelector('[data-category=text]').click(); assert.equal($('toolboxInput').value, ''); assert.equal($('toolboxSecond').hidden, true);
  input('toolboxInput', 'a\na\nb'); $('toolboxRun').click(); await settle(() => !$('toolboxCopy').disabled); assert.equal($('toolboxOutput').value, 'a\nb');
  doc.querySelector('[data-category=compare]').click(); assert.equal($('toolboxInput').value, 'before\n'); assert.equal($('toolboxSecondary').value, 'after\n');
  assert.match($('toolboxDiff').textContent, /\+ after/);
  assert.equal(doc.querySelector('[data-category=compare]').getAttribute('aria-current'), 'true');
  toolbox.close(); toolbox.open(); assert.equal($('toolboxInput').value, 'before\n'); assert.equal(calls.length, 0);
});
test('chart tool renders all types, keeps settings across closing and invalidates stale input', async t => {
  const { $, dom, toolbox, input, settle, calls } = await page(t), doc = dom.window.document;
  toolbox.open(); doc.querySelector('[data-category=chart]').click();
  input('toolboxInput', '[{"月份":"一月","金额":3},{"月份":"二月","金额":7}]'); $('toolboxRun').click();
  await settle(() => $('toolboxChart').querySelector('.chart-surface')?.dataset.pointCount === '2');
  const select = $('toolboxChart').querySelector('[data-chart-control=type]');
  for (const type of ['line', 'bar', 'pie', 'donut']) { select.value = type; select.dispatchEvent(new dom.window.Event('change')); assert.equal($('toolboxChart').querySelector('.chart-status').dataset.error, 'false'); }
  assert.equal($('toolboxInsert').disabled, true); assert.equal(doc.querySelector('.toolbox-result-actions').hidden, true);
  toolbox.close(); toolbox.open(); await settle(() => $('toolboxChart').querySelector('[data-chart-control=type]')?.value === 'donut');
  input('toolboxInput', '[{"月份":"三月","金额":9}]'); assert.equal($('toolboxChart').querySelector('svg'), null);
  $('toolboxRun').click(); await settle(() => $('toolboxChart').querySelector('.chart-surface')?.dataset.pointCount === '1');
  const xlsx = await import('../public/vendor/toolbox.js'), book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([['月份', '金额'], ['四月', 11]]), '图表数据');
  const bytes = xlsx.write(book, { bookType: 'xlsx', type: 'array' });
  Object.defineProperty($('toolboxFile'), 'files', { configurable: true, value: [{ name: 'chart.xlsx', size: bytes.byteLength, arrayBuffer: async () => bytes }] }); $('toolboxFile').dispatchEvent(new dom.window.Event('change'));
  await settle(() => $('toolboxSheet').options.length === 1);
  assert.equal($('toolboxBreadcrumb').textContent, '数据工具 / 图表生成'); assert.equal($('toolboxAction').value, 'csv');
  $('toolboxRun').click(); await settle(() => $('toolboxChart').querySelector('.chart-surface')?.dataset.pointCount === '1'); assert.equal(calls.length, 0);
});
test('toolbox reads and replaces only the captured editor selection, without save/query/model requests', async t => {
  const { $, editor, toolbox, calls, settle } = await page(t);
  await editor.open({ cwd: '/project', path: 'demo.json' }); const textarea = $('fileEditorText');
  textarea.setSelectionRange(7, textarea.value.indexOf(' suffix')); $('prompt').value = 'keep chat draft';
  toolbox.open({ fromEditor: true }); assert.equal($('toolboxInput').value, '{"id":9007199254740993}');
  $('toolboxRun').click(); await settle(() => !$('toolboxCopy').disabled);
  $('toolboxInsert').click(); assert.equal($('toolboxPanel').hidden, true);
  assert.equal(editor.current.content, 'prefix {\n  "id": 9007199254740993\n} suffix'); assert.equal(editor.dirty, true);
  assert.equal($('prompt').value, 'keep chat draft'); assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(globalThis.localStorage).includes('9007199254740993'), false);
});
test('stale editor snapshot cannot overwrite newer text or another tab; closing retains per-tool input and themes', async t => {
  const { $, dom, editor, toolbox, input, settle } = await page(t);
  await editor.open({ cwd: '/project', path: 'demo.json' }); $('fileEditorText').setSelectionRange(7, 32);
  toolbox.open({ fromEditor: true }); input('toolboxInput', '{"n":1}'); $('toolboxRun').click(); await settle(() => !$('toolboxCopy').disabled);
  input('fileEditorText', 'new editor draft'); $('toolboxInsert').click(); assert.equal(editor.current.content, 'new editor draft'); assert.match($('toolboxStatus').textContent, /已变化/);
  const themes = createModuleThemeControls({ root: dom.window.document.documentElement, storage: dom.window.localStorage }); t.after(() => themes.dispose());
  dom.window.document.querySelector('[data-module-theme-toggle=toolbox]').click(); assert.equal($('toolboxPanel').dataset.theme, 'light');
  $('toolboxClose').click(); toolbox.open(); assert.equal($('toolboxInput').value, '{"n":1}');
  dom.window.document.querySelector('[data-category=encoding]').click(); input('toolboxInput', 'keep encoding input');
  dom.window.document.querySelector('[data-category=json]').click(); assert.equal($('toolboxInput').value, '{"n":1}');
  assert.equal($('toolboxPanel').dataset.theme, 'light'); assert.equal(editor.current.content, 'new editor draft');
  const unload = new dom.window.Event('beforeunload', { cancelable: true }); dom.window.dispatchEvent(unload); assert.equal(unload.defaultPrevented, true);
});
test('late processing is ignored after edits, category switches or closing; untrusted tree content remains text', async t => {
  let finish;
  const { $, dom, toolbox, input, settle } = await page(t, { cancel() {}, run: () => new Promise(resolve => { finish = resolve; }) });
  toolbox.open(); input('toolboxInput', '{"x":1}'); $('toolboxRun').click();
  input('toolboxInput', '{"new":2}'); finish({ text: 'stale output', filename: 'old.txt' }); await new Promise(setImmediate);
  assert.equal($('toolboxOutput').value, ''); assert.equal($('toolboxInput').value, '{"new":2}');
  $('toolboxRun').click(); dom.window.document.querySelector('[data-category=encoding]').click(); finish({ text: 'old category output' }); await new Promise(setImmediate); assert.equal($('toolboxOutput').value, '');
  dom.window.document.querySelector('[data-category=json]').click(); $('toolboxRun').click();
  const root = parseJson('{"<img src=x onerror=alert(1)>":"<script>bad</script>"}'); finish({ text: printJson(root), tree: root });
  await settle(() => !$('toolboxCopy').disabled); assert.equal($('toolboxTree').querySelector('img,script'), null); assert.match($('toolboxTree').textContent, /<script>/);
});

test('all toolbox modules and the local vendor bundle are served with the existing HTTP security policy', async t => {
  class Bridge extends EventEmitter { ready = false; async start() { this.ready = true; } close() {} }
  const app = createApplication({ bridge: new Bridge(), cwd: '/private/tmp' }); await app.start(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const route of ['/toolbox.js', '/toolbox-core.js', '/toolbox-worker.js', '/vendor/toolbox.js']) {
    const response = await fetch(base + route); assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /javascript/); assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/); assert.match(await response.text(), /./);
  }
  assert.equal((await fetch(base + '/vendor/../package.json')).status, 401);
});

test('Excel file import selects worksheets, preserves text values and ignores a file read after navigation', async t => {
  const { $, dom, toolbox, input, settle } = await page(t), xlsx = await import('../public/vendor/toolbox.js');
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['id'], ['9007199254740993123']]), '第一张');
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([['name'], ['演示用户']]), '第二张');
  const bytes = xlsx.write(workbook, { bookType: 'xlsx', type: 'array' });
  toolbox.open();
  Object.defineProperty($('toolboxFile'), 'files', { configurable: true, value: [{ name: 'fixture.xlsx', size: bytes.byteLength, arrayBuffer: async () => bytes }] });
  $('toolboxFile').dispatchEvent(new dom.window.Event('change'));
  await settle(() => $('toolboxSheet').options.length === 2); assert.equal($('toolboxAction').value, 'xlsx-json');
  $('toolboxRun').click(); await settle(() => !$('toolboxCopy').disabled); assert.equal(JSON.parse($('toolboxOutput').value)[0].id, '9007199254740993123');
  $('toolboxSheet').value = '1'; $('toolboxSheet').dispatchEvent(new dom.window.Event('change')); $('toolboxRun').click();
  await settle(() => !$('toolboxCopy').disabled); assert.deepEqual(JSON.parse($('toolboxOutput').value), [{ name: '演示用户' }]);
  let finish; Object.defineProperty($('toolboxFile'), 'files', { configurable: true, value: [{ name: 'late.txt', size: 10, arrayBuffer: () => new Promise(resolve => { finish = resolve; }) }] });
  $('toolboxFile').dispatchEvent(new dom.window.Event('change')); dom.window.document.querySelector('[data-category=encoding]').click(); input('toolboxInput', 'keep this');
  finish(new TextEncoder().encode('late content').buffer); await new Promise(setImmediate); assert.equal($('toolboxInput').value, 'keep this');
});

test('writeback rejects another file even with identical text, and readonly files remain readable without writeback', async t => {
  const { $, editor, toolbox, settle } = await page(t);
  await editor.open({ cwd: '/project', path: 'one.json' }); $('fileEditorText').setSelectionRange(7, $('fileEditorText').value.indexOf(' suffix'));
  toolbox.open({ fromEditor: true }); $('toolboxRun').click(); await settle(() => !$('toolboxCopy').disabled);
  await editor.open({ cwd: '/project', path: 'two.json' }); const before = editor.current.content;
  $('toolboxInsert').click(); assert.equal(editor.current.path, 'two.json'); assert.equal(editor.current.content, before); assert.match($('toolboxStatus').textContent, /已变化/);
  await editor.open({ cwd: '/project', path: 'readonly.json' }); $('fileEditorText').setSelectionRange(7, $('fileEditorText').value.indexOf(' suffix'));
  toolbox.open({ fromEditor: true }); $('toolboxRun').click(); await settle(() => !$('toolboxCopy').disabled); assert.equal($('toolboxInsert').disabled, true);
});
