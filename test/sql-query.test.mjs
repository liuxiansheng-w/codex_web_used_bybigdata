import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { SqlRunner, prepareQuery, validateQuery } from '../lib/sql-runner.mjs';
import { createApplication } from '../server.mjs';
import { extractParams, substituteParams, createParameterMemory, yesterdayBusinessDate, calendarDate } from '../public/sql-parameters.js';
import { createSqlQuery, resultText, filterRows, sqlFileFromRunnerLink, columnValueKey, columnOptions } from '../public/sql-query.js';
import { createBottomPanel } from '../public/editor-window.js';
test('query history requires confirmation before retry and reuses its original parameters without editing files', async t => {
  const { $, select, requests, settle, finish, files } = await ui(t);
  select(1); $('sqlRun').click(); $('sqlParamsFields').querySelector('input').value = '20260918';
  $('sqlParamsForm').dispatchEvent(new window.Event('submit', {cancelable:true}));
  finish({ok:true,columns:['dt'],rows:[['20260918']],rowCount:1,durationMs:20}); await settle();
  $('sqlRename').click(); $('sqlResultName').value = '每日汇总'; $('sqlRenameForm').dispatchEvent(new window.Event('submit',{cancelable:true}));
  assert.match($('sqlResultTabs').textContent, /每日汇总/);
  const before = requests.filter(item=>item.route==='/api/sql/query').length, original = files[1].content;
  $('sqlRepeat').click(); assert.equal($('sqlReviewDialog').open, true); assert.equal(requests.filter(item=>item.route==='/api/sql/query').length, before);
  $('sqlReviewCancel').click(); assert.equal(requests.filter(item=>item.route==='/api/sql/query').length, before);
  $('sqlRepeat').click(); $('sqlReviewForm').dispatchEvent(new window.Event('submit',{cancelable:true}));
  assert.equal($('sqlParamsFields').querySelector('input').value, '20260918'); assert.equal(files[1].content, original);
  $('sqlParamsForm').dispatchEvent(new window.Event('submit',{cancelable:true}));
  assert.deepEqual(requests.at(-1).body.params,{date:'20260918'});
  finish({ok:true,columns:['dt'],rows:[['20260918']],rowCount:1,durationMs:20}); await settle();
  assert.equal($('sqlResultTabs').querySelectorAll('[role=tab]').length, 2);
  $('sqlHistory').click(); assert.equal($('sqlKeepResults').checked, false); assert.equal($('sqlHistoryList').children.length, 2);
  $('sqlKeepResults').checked = true; $('sqlKeepResults').dispatchEvent(new window.Event('change'));
  window.dispatchEvent(new window.Event('pagehide'));
  const cache = JSON.parse(window.localStorage.getItem('lemon:queryResults:v1')); assert.equal(cache.length,2); assert.ok(cache.some(tab=>tab.name==='每日汇总'));
});

test('web SQL input checks preserve parameters and routing while deferring syntax and operation policy upstream', () => {
  assert.equal(sqlFileFromRunnerLink('http://127.0.0.1:5177/#path=%2Fproject%2Fquery.sql'), '/project/query.sql');
  for (const href of ['https://example.test/#path=/project/query.sql', 'http://127.0.0.1.evil.test:5177/#path=/project/query.sql', 'http://127.0.0.1:5177/#path=relative.sql', 'http://127.0.0.1:5177/#path=/project/private.txt']) assert.equal(sqlFileFromRunnerLink(href), null);
  const sql = "-- ignored ${no}\nWITH sample AS (SELECT '${date}' AS dt) SELECT * FROM sample WHERE dt = :other";
  assert.deepEqual(extractParams(sql), ['date', 'other']);
  const prepared = prepareQuery({ sql, params: { date: '20260917', other: "'20260917'" } });
  assert.match(prepared.sql, /^--lzy\n/);
  assert.match(substituteParams(prepared.sql, prepared.params), /'20260917'/);
  for (const source of ["SELECT 'drop; delete update' AS note; -- suffix", 'SHOW TABLES', 'DESC sample', 'EXPLAIN SELECT 1', 'SELECT `update` FROM sample']) assert.doesNotThrow(() => validateQuery(source));
  for (const source of ['SELECT 1; SELECT 2', 'SELECT 1 INTO OUTFILE x', 'WITH a AS (SELECT 1) INSERT INTO b SELECT * FROM a', 'EXPLAIN DELETE FROM t', 'UPDATE t SET x=1', "SELECT 'unterminated", 'SELECT 1 /*! INTO OUTFILE x */', 'SELECT 1 /* unfinished']) assert.equal(validateQuery(source), source);
  assert.deepEqual(prepareQuery({ sql: 'SELECT ${fragment}', params: { fragment: '1; DROP TABLE t' } }).params, { fragment: '1; DROP TABLE t' });
  for (const source of ['', '  ', null, 123]) assert.throws(() => validateQuery(source), /非空/);
  assert.throws(() => prepareQuery({ sql: 'SELECT ${missing}' }), /missing/);
  assert.throws(() => prepareQuery({ sql: 'SELECT 1', engine: 'other' }));
  assert.throws(() => new SqlRunner({ base: 'https://example.test' }), /本机/);
});

test('web workbench forwards SQL types and scripts without maintaining a second operation allowlist', () => {
  const allowed = [
    "--lzy\nCREATE TABLE IF NOT EXISTS demo_orders (order_id BIGINT COMMENT 'id', amount DECIMAL(18,2)) COMMENT 'demo' PARTITIONED BY (dt STRING) STORED AS ORC TBLPROPERTIES ('lifecycle'='7');",
    '/* schema */ create external table demo_external (id BIGINT) STORED AS PARQUET LOCATION \'obs://fictional-demo/data\'',
    'CREATE TEMPORARY TABLE demo_temp (id BIGINT)',
    'CREATE TABLE demo_copy LIKE demo_orders;',
    'CREATE TABLE demo_summary AS SELECT order_id FROM demo_orders',
    'CREATE VIEW demo_view AS SELECT order_id FROM demo_orders;',
    'CREATE TABLE `demo;table` (`update` STRING COMMENT \'create; drop\'); -- suffix',
  ];
  for (const engine of ['huawei', 'aliyun']) for (const sql of allowed) {
    const prepared = prepareQuery({ sql, engine });
    assert.equal(prepared.engine, engine); assert.match(prepared.sql, /^--lzy\n/);
  }
  for (const sql of [
    'CREATE TABLE a (id INT); CREATE TABLE b (id INT)', 'CREATE TABLE a (id INT); DROP TABLE b',
    'CREATE OR REPLACE VIEW a AS SELECT 1', 'CREATE FUNCTION a()', 'CREATE DATABASE a',
    'CREATE TABLE a AS WITH x AS (DELETE FROM b) SELECT * FROM x', 'CREATE TABLE a AS SELECT 1 INTO OUTFILE x',
    'CREATE TABLE a (id INT) /*! DROP TABLE b */', 'CREATE TABLE a /* unfinished', 'CREATE TABLE a (id STRING COMMENT \'unfinished)',
    "'ignored' CREATE TABLE a (id INT)", 'CREATE "ignored" TABLE a (id INT)',
    'INSERT INTO a SELECT 1', 'ALTER TABLE a ADD id INT', 'DELETE FROM a', 'DROP TABLE a',
  ]) assert.equal(prepareQuery({ sql }).sql, `--lzy\n${sql}`);
  assert.doesNotThrow(() => prepareQuery({ sql: 'CREATE TABLE ${name} (id INT)', params: { name: 'a (id INT); DROP TABLE b; --' } }));
  assert.doesNotThrow(() => prepareQuery({ sql: "CREATE TABLE demo_params COMMENT '${note}' AS SELECT '${dt}' AS dt", params: { note: "owner's demo", dt: '20260920' } }));
});

test('CREATE is forwarded to the existing remote runner with the execution mark and preserves cloud errors', async () => {
  const calls = [];
  const runner = new SqlRunner({ fetchImpl: async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, rows: [], columns: [], durationMs: 25, sqlType: 'CREATE' }));
  } });
  for (const engine of ['huawei', 'aliyun']) {
    const result = await runner.execute({ sql: "CREATE TABLE demo AS SELECT '${dt}' AS dt", params: { dt: '20260920' }, engine });
    assert.equal(result.sqlType, 'CREATE'); assert.equal(result.ok, true); assert.equal(result.rowCount, 0);
    assert.match(result.executedSql, /^--lzy\nCREATE TABLE demo AS SELECT '20260920'/);
    assert.equal(calls.at(-1).url, 'http://127.0.0.1:5177/api/execute-sql');
    assert.match(calls.at(-1).payload.sql, /^--lzy\nCREATE/); assert.equal(calls.at(-1).payload.engine, engine);
  }
  await runner.execute({ sql: 'CREATE TABLE a (id INT); DROP TABLE b' });
  assert.equal(calls.length, 3, 'the original runner decides which scripts are supported');
  runner.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'mock: permission denied for CREATE TABLE' }));
  await assert.rejects(runner.execute({ sql: 'CREATE TABLE a (id INT)' }), /permission denied/);
  assert.equal(runner.active, false);
});

test('INSERT and ALTER reach the original service, whose SQL rejection is preserved without retry', async () => {
  const calls = [], rejection = '操作被禁止：不允许执行 DROP/TRUNCATE/DELETE/UPDATE';
  const runner = new SqlRunner({ fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body); calls.push(payload);
    return new Response(JSON.stringify(payload.sql.includes('DELETE') ? { ok: false, error: rejection } : { ok: true, rows: [], columns: [], durationMs: 40 }), { status: payload.sql.includes('DELETE') ? 400 : 200 });
  } });
  for (const engine of ['huawei', 'aliyun']) for (const sql of ["INSERT INTO demo_orders PARTITION(dt='${dt}') SELECT 1", "INSERT OVERWRITE TABLE demo_orders PARTITION(dt='${dt}') SELECT 1", 'ALTER TABLE demo_orders ADD COLUMNS (note STRING)']) {
    const result = await runner.execute({ sql, engine, params: { dt: '20260921' } });
    assert.equal(result.ok, true); assert.match(calls.at(-1).sql, /^--lzy\n/);
    assert.equal(calls.at(-1).sql, `--lzy\n${sql}`); assert.equal(calls.at(-1).engine, engine);
  }
  await assert.rejects(runner.execute({ sql: 'DELETE FROM demo_orders' }), error => error.message === rejection);
  assert.equal(calls.length, 7, 'a rejected statement must never be retried automatically');
});

test('runner retains all returned rows, reports errors and prevents overlapping queries', async () => {
  const calls = []; let finish;
  const runner = new SqlRunner({ fetchImpl: async (url, options) => { calls.push({ url, options }); return new Promise(resolve => { finish = resolve; }); } });
  const query = runner.execute({ sql: 'SELECT ${value}', params: { value: 3 }, engine: 'aliyun' });
  await assert.rejects(runner.execute({ sql: 'SELECT 4' }), /已有查询/);
  const sent = JSON.parse(calls[0].options.body); assert.equal(sent.sql, '--lzy\nSELECT ${value}'); assert.equal(sent.params.value, 3); assert.equal(sent.engine, 'aliyun');
  assert.equal(calls[0].options.redirect, 'error');
  finish(new Response(JSON.stringify({ ok: true, rows: Array.from({ length: 10001 }, (_, value) => ({ value })), columns: ['value'], durationMs: 850, executedSql: '--lzy\nSELECT 3', ossUrl: 'javascript:bad()' })));
  const result = await query;
  assert.equal(result.rows.length, 10001); assert.equal(result.rowCount, 10001); assert.equal(result.truncated, false); assert.equal(result.downloadUrl, null); assert.equal(result.durationMs, 850);
  runner.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'warehouse unavailable' }), { status: 200 });
  await assert.rejects(runner.execute({ sql: 'SELECT 1' }), /warehouse unavailable/);
  runner.fetch = async () => { throw new Error('connect refused'); };
  await assert.rejects(runner.execute({ sql: 'SELECT 1' }), /5177/);
  assert.equal((await runner.status()).available, false);
  runner.fetch = async () => new Response('{"ok":true,"active":false}');
  assert.equal((await runner.status()).available, true, 'runner UI need not be open for remote execution');
});

test('SQL HTTP routes retain session and CSRF protection while Codex is offline', async t => {
  const bridge = new EventEmitter(); bridge.ready = false; bridge.start = async () => {}; bridge.close = () => {};
  const calls = [], sqlRunner = { status: async () => ({ available: true }), execute: async body => { calls.push(body); return { ok: true, rows: [{ value: 1 }], columns: ['value'] }; } };
  const app = createApplication({ bridge, cwd: '/private/tmp', sqlRunner });
  await app.start(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  const boot = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  assert.equal((await fetch(`${base}/api/sql/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/sql/status`, { headers: { cookie } })).status, 200);
  const request = { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ sql: 'SELECT 1' }) };
  assert.equal((await fetch(`${base}/api/sql/query`, request)).status, 403);
  request.headers['x-codex-csrf'] = boot.csrf;
  const result = await fetch(`${base}/api/sql/query`, request); assert.equal(result.status, 200); assert.equal((await result.json()).ok, true);
  assert.equal(calls.length, 1);
  request.headers.origin = 'https://untrusted.test'; assert.equal((await fetch(`${base}/api/sql/query`, request)).status, 403);
  for (const asset of ['/sql-query.js', '/sql-parameters.js']) assert.equal((await fetch(base + asset)).status, 200);
});

test('result filtering, sorting and spreadsheet exports preserve nulls and neutralize formulas', () => {
  const result = { columns: ['value', 'note'], rows: [{ value: 12, note: 'apple' }, { value: 2, note: 'Apple' }, { value: 5, note: null }] };
  assert.deepEqual(filterRows(result, 'APPLE', { column: 'value', direction: 1 }).map(row => row.value), [2, 12]);
  assert.equal(filterRows(result, 'null').length, 1); assert.equal(result.rows[0].value, 12);
  const text = resultText(['value'], [{ value: '=1+2' }, { value: '"quoted"\nline' }, { value: -2 }, { value: null }], true);
  assert.match(text, /"'=1\+2"/); assert.match(text, /""quoted""/); assert.match(text, /"-2"/);
  const numeric = { columns: ['x', 'group'], rows: [['10', 'a'], ['-2', 'a'], ['2.5', 'a'], ['-10', 'b'], [null, 'a']] };
  assert.deepEqual(filterRows(numeric, '', { column: 'x', direction: 1 }).map(row => row[0]), ['-10', '-2', '2.5', '10', null]);
  assert.deepEqual(filterRows(numeric, '', null, [{ column: 'x', op: 'gte', value: '0' }, { column: 'group', op: 'equals', value: 'a' }]).map(row => row[0]), ['10', '2.5']);
  assert.equal(filterRows(numeric, '', null, [{ column: 'x', op: 'empty' }]).length, 1);
});

async function ui(t, withBottom = false) {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://localhost:4318' });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  t.after(() => { dom.window.close(); Object.assign(globalThis, previous); });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const files = [
    { id: 1, cwd: '/project', path: 'a.sql', content: 'SELECT 1;\nSELECT 2;', start: 0, end: 9, language: 'sql' },
    { id: 2, cwd: '/project', path: 'b.sql', content: "SELECT '${date}' AS dt", start: 0, end: 0, language: 'sql' },
    { id: 3, cwd: '/project', path: 'c.py', content: 'x=1', start: 0, end: 0, language: 'python' },
  ];
  let selected = files[0], complete;
  const requests = [], contexts = [];
  const editor = { get current() { return selected; }, get tabs() { return files; }, visible: true, locked: false };
  const bottomPanel = withBottom ? createBottomPanel({ surface: document.getElementById('workSurface') }) : undefined;
  const controller = createSqlQuery({ editor, bottomPanel, api: async (route, body) => {
    requests.push({ route, body }); if (route.endsWith('/status')) return { available: true };
    return new Promise((resolve, reject) => { complete = { resolve, reject }; });
  }, onContext: text => contexts.push(text), notice: () => {} });
  const $ = id => document.getElementById(id), settle = () => new Promise(resolve => setImmediate(resolve));
  return { $, files, requests, contexts, editor, controller, bottomPanel, settle, finish: data => complete.resolve(data), fail: error => complete.reject(error), select(index) { selected = files[index]; controller.sync(); } };
}

function selectCells($, start, end = start, shiftKey = false) {
  const cell = ([row, column]) => $('sqlResultBody').querySelector(`[data-result-row="${row}"][data-result-column="${column}"]`);
  cell(start).dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, shiftKey }));
  cell(end).dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, buttons: 1 }));
  document.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true }));
}

test('result cells support rectangular selection, live decimal statistics, keyboard expansion and copying without queries', async t => {
  const { $, finish, settle, requests } = await ui(t);
  $('sqlRun').click();
  finish({ ok: true, columns: ['amount', 'label'], rows: [['0.1', 'a'], ['0.2', 'b'], [null, 'c'], ['-2', 'd']], rowCount: 4, durationMs: 1 }); await settle();
  const selected = () => [...$('sqlResultBody').querySelectorAll('[aria-selected=true]')];
  selectCells($, [1, 0], [0, 0]);
  assert.equal(selected().length, 2); assert.match($('sqlSelectionStats').textContent, /计数 2.*数值 2.*求和 0\.3.*平均值 0\.15/);
  const table = $('sqlResultBody').querySelector('table');
  table.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(selected().length, 4); assert.match($('sqlSelectionStats').textContent, /计数 4.*数值 2/);
  let copied; const copy = new window.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(copy, 'clipboardData', { value: { setData: (type, value) => { assert.equal(type, 'text/plain'); copied = value; } } });
  table.dispatchEvent(copy); assert.equal(copied, '0.1\ta\n0.2\tb');
  selectCells($, [3, 1], [3, 1], true); assert.equal(selected().length, 6);
  assert.match($('sqlSelectionStats').textContent, /求和 -1\.8/);
  table.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(selected().length, 8); assert.match($('sqlSelectionStats').title, /非空 7 个，数值 3 个/);
  table.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(selected().length, 0); assert.equal($('sqlSelectionStats').hidden, true);
  selectCells($, [0, 1]); assert.match($('sqlSelectionStats').textContent, /计数 1.*数值 0/); assert.doesNotMatch($('sqlSelectionStats').textContent, /求和/);
  assert.equal(requests.filter(r => r.route === '/api/sql/query').length, 1);
});

test('result selection stays isolated by tab and clears after sorting, filtering, paging or changing page size', async t => {
  const { $, finish, settle } = await ui(t);
  const rows = Array.from({ length: 60 }, (_, i) => ({ amount: String(i + 1), label: i % 2 ? 'odd' : 'even' }));
  $('sqlRun').click(); finish({ ok: true, columns: ['amount', 'label'], rows, rowCount: 60, durationMs: 1, truncated: true }); await settle();
  selectCells($, [0, 0], [2, 0]); assert.match($('sqlSelectionStats').textContent, /求和 6/); assert.match($('sqlSelectionStats').title, /截断预览/);
  $('sqlRun').click(); finish({ ok: true, columns: ['other'], rows: [[100], [200]], rowCount: 2, durationMs: 1 }); await settle();
  assert.equal($('sqlSelectionStats').hidden, true); selectCells($, [0, 0], [1, 0]); assert.match($('sqlSelectionStats').textContent, /求和 300/);
  $('sqlResultTabs').querySelectorAll('[role=tab]')[0].click(); assert.match($('sqlSelectionStats').textContent, /求和 6/);
  $('sqlNext').click(); assert.equal($('sqlSelectionStats').hidden, true); selectCells($, [0, 0], [1, 0]); assert.match($('sqlSelectionStats').textContent, /求和 103/);
  $('sqlPrev').click(); assert.equal($('sqlSelectionStats').hidden, true);
  selectCells($, [0, 0], [1, 0]); $('sqlResultBody').querySelector('.sql-column-sort').click(); assert.equal($('sqlSelectionStats').hidden, true);
  selectCells($, [0, 0], [1, 0]); $('sqlFilter').value = 'even'; $('sqlFilter').dispatchEvent(new window.Event('input')); assert.equal($('sqlSelectionStats').hidden, true);
  selectCells($, [0, 0], [1, 0]); assert.match($('sqlSelectionStats').textContent, /求和 4/);
  $('sqlPageSize').value = '100'; $('sqlPageSize').dispatchEvent(new window.Event('change')); assert.equal($('sqlSelectionStats').hidden, true);
  selectCells($, [0, 0]); $('sqlFilter').value = 'no match'; $('sqlFilter').dispatchEvent(new window.Event('input')); assert.equal($('sqlSelectionStats').hidden, true);
  $('sqlResultTabs').querySelectorAll('[role=tab]')[1].click(); assert.match($('sqlSelectionStats').textContent, /求和 300/);
});

test('CREATE selection uses the existing parameter flow and shows success alongside independent query tabs', async t => {
  const { $, files, select, finish, settle, requests } = await ui(t);
  const create = "--lzy\nCREATE TABLE demo_daily AS SELECT '${dt}' AS dt;";
  files[0].content = create + '\nSELECT * FROM demo_daily;'; files[0].start = 0; files[0].end = create.length;
  select(0); assert.equal($('sqlRun').textContent, '执行选区');
  $('sqlRun').click(); assert.equal($('sqlParamsTitle').textContent, '填写执行参数');
  $('sqlParamsCancel').click(); assert.equal(requests.filter(r => r.route === '/api/sql/query').length, 0);
  $('sqlRun').click(); $('sqlParamsFields').querySelector('input').value = '20260920';
  $('sqlParamsForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.deepEqual(requests.at(-1).body, { sql: create, params: { dt: '20260920' }, engine: 'huawei' });
  assert.equal($('sqlRun').textContent, '执行中…'); assert.match($('sqlSummary').textContent, /正在执行/);
  finish({ ok: true, sqlType: 'CREATE', columns: [], rows: [], rowCount: 0, durationMs: 250 }); await settle();
  assert.match($('sqlSummary').textContent, /执行成功/); assert.match($('sqlResultBody').textContent, /CREATE 执行成功/);
  assert.equal($('sqlCopy').disabled, true); assert.equal($('sqlExportAll').disabled, true); assert.equal($('sqlPagination').hidden, true);
  $('sqlRepeat').click(); assert.match($('sqlReviewDialog').querySelector('h2').textContent, /再次执行/);
  $('sqlReviewCancel').click(); assert.equal(requests.filter(r => r.route === '/api/sql/query').length, 1);
  files[0].start = create.length; files[0].end = files[0].content.length; select(0);
  assert.equal($('sqlRun').textContent, '查询选区'); $('sqlRun').click();
  finish({ ok: true, sqlType: 'SELECT', columns: ['dt'], rows: [['20260920']], rowCount: 1, durationMs: 30 }); await settle();
  assert.equal($('sqlResultTabs').querySelectorAll('[role=tab]').length, 2);
  assert.match($('sqlSummary').textContent, /1 行/); assert.ok($('sqlResultBody').querySelector('table'));
  $('sqlResultTabs').querySelector('[role=tab]').click(); assert.match($('sqlResultBody').textContent, /CREATE 执行成功/);
  $('sqlHistory').click(); assert.match($('sqlHistoryList').textContent, /执行成功/);
  assert.equal(requests.filter(r => r.route === '/api/sql/query').length, 2);
  assert.equal(files[0].content, create + '\nSELECT * FROM demo_daily;');
});

test('failed CREATE keeps the error and never displays success or automatically retries', async t => {
  const { $, files, select, fail, settle, requests } = await ui(t);
  files[0].content = 'CREATE TABLE demo (id INT);'; files[0].end = 0; select(0);
  assert.equal($('sqlRun').textContent, '执行全文'); $('sqlRun').click();
  fail(new Error('mock: table already exists')); await settle();
  assert.equal($('sqlSummary').textContent, '执行失败'); assert.match($('sqlResultBody').textContent, /already exists/);
  assert.doesNotMatch($('sqlResultBody').textContent, /执行成功/); assert.equal(requests.filter(r => r.route === '/api/sql/query').length, 1);
});

test('INSERT uses execution labels and the UI displays the original service rejection for disallowed operations', async t => {
  const { $, files, select, finish, fail, settle, requests } = await ui(t);
  const sql = 'INSERT OVERWRITE TABLE demo_orders SELECT 1;';
  files[0].content = sql; files[0].end = 0; select(0);
  assert.equal($('sqlRun').textContent, '执行全文'); $('sqlRun').click();
  assert.equal(requests.at(-1).body.sql, sql); assert.equal($('sqlRun').textContent, '执行中…');
  finish({ ok: true, sqlType: 'INSERT', columns: [], rows: [], rowCount: 0, durationMs: 40 }); await settle();
  assert.match($('sqlSummary').textContent, /执行成功/); assert.equal($('sqlResultBody').textContent, 'INSERT 执行成功，没有返回数据表格。');
  files[0].content = 'DELETE FROM demo_orders;'; select(0); $('sqlRun').click();
  const message = '操作被禁止：不允许执行 DROP/TRUNCATE/DELETE/UPDATE';
  fail(new Error(message)); await settle();
  assert.equal($('sqlSummary').textContent, '执行失败'); assert.equal($('sqlResultBody').textContent, message);
  assert.equal(requests.filter(r => r.route === '/api/sql/query').length, 2);
});

test('shared bottom tabs keep queries running, preserve table filters and pagination, and return floating results to the same dock', async t => {
  const { $, finish, settle, requests, editor, controller } = await ui(t, true);
  $('sqlRun').click(); assert.equal($('bottomTabResults').getAttribute('aria-selected'), 'true');
  $('bottomTabTerminal').click(); finish({ok:true,columns:['value'],rows:Array.from({length:137},(_,i)=>[i]),rowCount:137,durationMs:30}); await settle();
  assert.equal($('bottomTabTerminal').getAttribute('aria-selected'), 'true', 'query completion must not steal the active terminal tab');
  $('bottomTabResults').click(); $('sqlFilter').value='1'; $('sqlFilter').dispatchEvent(new window.Event('input'));
  const table=$('sqlResults').querySelector('table'), rows=table.rows.length; $('sqlResultBody').scrollTop=43;
  $('bottomTabTerminal').click(); $('bottomTabResults').click();
  assert.equal($('sqlResults').querySelector('table'),table); assert.equal(table.rows.length,rows); assert.equal($('sqlFilter').value,'1'); assert.equal($('sqlResultBody').scrollTop,43);
  $('sqlLayoutToggle').click(); assert.equal($('sqlResults').parentNode,document.body);
  $('bottomTabTerminal').click(); assert.equal($('sqlResults').hidden,false,'floating results remain visible beside the terminal');
  $('sqlLayoutToggle').click(); assert.equal($('sqlResults').parentNode,$('bottomResultsHost')); assert.equal($('bottomTabResults').getAttribute('aria-selected'),'true');
  $('bottomPanelClose').click(); assert.equal($('sqlResults').hidden,true); $('bottomTabResults').click(); assert.equal($('sqlResults').hidden,false);
  editor.visible=false; controller.sync(); assert.equal($('sqlResults').hidden,false,'results remain available without an open editor');
  assert.equal(requests.filter(r=>r.route==='/api/sql/query').length,1);
});

test('bottom panel height supports keyboard and cancellable dragging without losing the selected tab', async t => {
  const { $ }=await ui(t,true), divider=$('bottomPanelDivider'),surface=$('workSurface');
  window.innerHeight=900; surface.getBoundingClientRect=()=>({height:900});
  divider.setPointerCapture=id=>{divider.captured=id;};divider.hasPointerCapture=id=>divider.captured===id;divider.releasePointerCapture=()=>{divider.captured=null;};
  const dispatch=(type,props)=>{const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,props);divider.dispatchEvent(e);};
  const height=()=>parseFloat(surface.style.getPropertyValue('--bottom-panel-height'));
  $('bottomTabTerminal').click(); const before=height();
  dispatch('pointerdown',{pointerId:1,button:0,clientY:600});dispatch('pointermove',{pointerId:1,clientY:550});assert.equal(height(),before+50);
  document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(height(),before);
  dispatch('keydown',{key:'ArrowUp',shiftKey:true});assert.equal(height(),before+50);
  $('bottomPanelExpand').click();assert.equal(divider.hidden,true);$('bottomPanelExpand').click();assert.equal(height(),before+50);
  assert.equal(JSON.parse(window.localStorage.getItem('lemon:bottomPanel')).height,before+50);
  $('bottomTabTerminal').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(document.activeElement,$('bottomTabResults'));
});

test('inline querying executes selection, retains project results across files, filters pages and adds a bounded chat draft', async t => {
  const { $, requests, contexts, files, controller, settle, select, finish } = await ui(t);
  assert.equal($('sqlRun').textContent, '查询选区');
  $('sqlRun').click(); assert.equal(requests.at(-1).body.sql, 'SELECT 1;'); assert.equal($('sqlRun').disabled, true);
  select(1); assert.equal($('sqlResults').hidden, false); assert.equal($('sqlRun').disabled, true);
  finish({ ok: true, rows: Array.from({ length: 102 }, (_, value) => ({ value, note: value === 0 ? '<script>bad()</script>' : `row ${value}` })), columns: ['value', 'note'], durationMs: 1200, rowCount: 102, executedSql: '--lzy\nSELECT 1;' });
  await settle(); assert.equal($('sqlResults').hidden, false);
  select(0); assert.equal($('sqlResults').hidden, false); assert.equal(document.querySelectorAll('.sql-table tbody tr').length, 50);
  assert.equal($('sqlResultBody').querySelector('script'), null); assert.match($('sqlPage').textContent, /1 \/ 3/);
  $('sqlNext').click(); assert.match($('sqlPage').textContent, /2 \/ 3/);
  $('sqlFilter').value = 'row 101'; $('sqlFilter').dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelectorAll('.sql-table tbody tr').length, 1);
  $('sqlContext').click(); assert.equal(contexts.length, 1); assert.match(contexts[0], /row 101/); assert.match(contexts[0], /当前筛选 1 行/);
  assert.equal(requests.filter(request => request.route === '/api/sql/query').length, 1);
  files[0].content += '\n-- edited'; controller.sync(); assert.match($('sqlResultNote').textContent, /编辑内容已变化/);
  $('sqlExpand').click(); assert.equal($('fileEditor').classList.contains('sql-expanded'), true);
  $('sqlCollapse').click(); assert.equal($('sqlResults').hidden, true); assert.equal($('fileEditor').classList.contains('sql-expanded'), false);
  $('sqlShowResults').click(); assert.equal($('sqlResults').hidden, false);
  select(2); assert.equal($('sqlRun').hidden, true); assert.equal($('sqlResults').hidden, false);
});

test('parameter cancellation has no side effect and errors stay attached to the query snapshot', async t => {
  const { $, select, requests, settle, fail, contexts } = await ui(t);
  select(1); $('sqlEngine').value = 'aliyun'; $('sqlEngine').dispatchEvent(new window.Event('change'));
  $('sqlRun').click(); assert.equal($('sqlParamsDialog').open, true);
  $('sqlParamsCancel').click(); assert.equal(requests.filter(r => r.route === '/api/sql/query').length, 0);
  $('sqlRun').click(); $('sqlParamsFields').querySelector('input').value = '20260917';
  $('sqlParamsForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.deepEqual(requests.at(-1).body, { sql: "SELECT '${date}' AS dt", params: { date: '20260917' }, engine: 'aliyun' });
  fail(new Error('partition unavailable')); await settle();
  assert.match($('sqlResultBody').textContent, /partition unavailable/); assert.equal($('sqlCopy').disabled, true);
  assert.equal($('sqlExecuted').textContent, "SELECT '20260917' AS dt");
  $('sqlContext').click(); assert.match(contexts[0], /排查以下查询错误/); assert.match(contexts[0], /partition unavailable/);
});

test('column menus combine filters, sort, copy data/headers and download all rows independently of filters', async t => {
  const { $, finish, settle } = await ui(t);
  let clipboard = '', blob;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { clipboard = text; } } } });
  const createUrl = URL.createObjectURL, revokeUrl = URL.revokeObjectURL;
  URL.createObjectURL = value => { blob = value; return 'blob:test-result'; }; URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {};
  t.after(() => { Object.defineProperty(globalThis, 'navigator', navigatorDescriptor); URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl; });
  $('sqlRun').click();
  finish({ ok: true, columns: ['group', 'amount'], rows: Array.from({ length: 130 }, (_, i) => [i % 2 ? '奇数' : '偶数', i]), rowCount: 130, durationMs: 50 }); await settle();
  const menu = column => [...document.querySelectorAll('.sql-column-trigger')].find(button => button.getAttribute('aria-label').startsWith(`${column} `)).click();
  const filter = (column, op, value) => { menu(column); $('sqlColumnOperator').value = op; $('sqlColumnValue').value = value; $('sqlColumnForm').dispatchEvent(new window.Event('submit', { cancelable: true })); };
  filter('group', 'equals', '偶数'); assert.match($('sqlSummary').textContent, /65 \/ 130/);
  menu('amount'); $('sqlColumnCopy').click(); await settle(); assert.equal(clipboard.split('\n').length, 65, 'column copy includes all matching pages'); assert.equal(clipboard.split('\n')[1], '2');
  filter('amount', 'gte', '100'); assert.match($('sqlSummary').textContent, /15 \/ 130/);
  menu('amount'); $('sqlSortDesc').click();
  assert.equal(document.querySelector('.sql-table tbody tr td:nth-child(3)').textContent, '128');
  menu('amount'); $('sqlColumnWithHeader').click(); await settle(); assert.match(clipboard, /^amount\n128\n126/);
  menu('amount'); $('sqlColumnTitle').click(); await settle(); assert.equal(clipboard, 'amount');
  $('sqlCopyHeaders').click(); await settle(); assert.equal(clipboard, 'group\tamount');
  $('sqlExportAll').click(); const allCsv = await blob.text(); assert.equal(allCsv.split('\r\n').length, 131); assert.match(allCsv, /"奇数","129"/);
  $('sqlExport').click(); const filteredCsv = await blob.text(); assert.equal(filteredCsv.split('\r\n').length, 16); assert.doesNotMatch(filteredCsv, /奇数/);
  const clear = [...$('sqlFilterChips').querySelectorAll('button')].find(button => button.textContent === '清空筛选'); clear.click();
  $('sqlPageSize').value = '100'; $('sqlPageSize').dispatchEvent(new window.Event('change')); assert.equal(document.querySelectorAll('.sql-table tbody tr').length, 100);
});

test('desktop results resize, float, move and dock without losing table state across files', async t => {
  const { $, editor, controller, settle, select, finish } = await ui(t);
  window.innerWidth = 1440; window.innerHeight = 900;
  const container = $('fileEditor'), pane = $('sqlResults'), divider = $('sqlResultsDivider');
  container.hidden = false; container.getBoundingClientRect = () => ({ height: 800, width: 720 });
  const dispatch = (target, type, data = {}) => { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, data); target.dispatchEvent(event); };
  for (const target of [divider, $('sqlResultHandle'), ...pane.querySelectorAll('.sql-result-resize')]) {
    target.setPointerCapture = id => { target.captured = id; }; target.hasPointerCapture = id => target.captured === id; target.releasePointerCapture = () => { target.captured = null; };
  }
  const pointer = (target, type, x, y) => dispatch(target, type, { pointerId: 1, button: 0, clientX: x, clientY: y });
  const size = () => parseFloat(container.style.getPropertyValue('--sql-results-height'));
  $('sqlRun').click(); finish({ ok: true, columns: ['value'], rows: Array.from({ length: 137 }, (_, value) => ({ value })), rowCount: 137, durationMs: 200 }); await settle();
  assert.equal(divider.hidden, false);
  const initial = size(); pointer(divider, 'pointerdown', 300, 500); pointer(divider, 'pointermove', 300, 440); assert.ok(Math.abs(size() - initial - 60) < .001);
  dispatch(document, 'keydown', { key: 'Escape' }); assert.equal(size(), initial); assert.equal(divider.captured, null);
  pointer(divider, 'pointerdown', 300, 500); pointer(divider, 'pointermove', 300, 460); pointer(divider, 'pointerup', 300, 460);
  assert.ok(Math.abs(size() - initial - 40) < .001); assert.ok(Number(window.localStorage.getItem('lemon:resultsSplit')) > .45);
  dispatch(divider, 'keydown', { key: 'ArrowUp' }); assert.ok(Math.abs(size() - initial - 50) < .001);
  dispatch(divider, 'keydown', { key: 'End' }); assert.equal(divider.getAttribute('aria-valuenow'), divider.getAttribute('aria-valuemax'));
  dispatch(divider, 'dblclick'); assert.equal(size(), initial);
  const sort = pane.querySelector('.sql-column-sort'); sort.click(); sort.click(); $('sqlNext').click();
  const table = pane.querySelector('table'), body = $('sqlResultBody'), page = $('sqlPage').textContent;
  body.scrollTop = 91; body.scrollLeft = 12;
  $('sqlLayoutToggle').click(); assert.equal(pane.parentNode, document.body); assert.equal(pane.dataset.layout, 'floating'); assert.equal(divider.hidden, true);
  assert.equal(pane.querySelector('table'), table); assert.equal(body.scrollTop, 91); assert.equal(body.scrollLeft, 12); assert.equal($('sqlPage').textContent, page);
  assert.equal(table.querySelector('th[aria-sort="descending"]').textContent.includes('value'), true);
  const left = parseFloat(pane.style.left), top = parseFloat(pane.style.top), handle = $('sqlResultHandle');
  pointer(handle, 'pointerdown', 700, 120); pointer(handle, 'pointermove', 640, 170); pointer(handle, 'pointerup', 640, 170);
  assert.equal(parseFloat(pane.style.left), left - 60); assert.equal(parseFloat(pane.style.top), top + 50);
  const width = parseFloat(pane.style.width), height = parseFloat(pane.style.height), corner = pane.querySelector('[data-edge="se"]');
  pointer(corner, 'pointerdown', 1200, 700); pointer(corner, 'pointermove', 1100, 630); pointer(corner, 'pointerup', 1100, 630);
  assert.equal(parseFloat(pane.style.width), width - 100); assert.equal(parseFloat(pane.style.height), height - 70);
  $('sqlWindowMaximize').click(); assert.equal(pane.classList.contains('is-maximized'), true); assert.equal(pane.style.width, '1424px');
  $('sqlWindowMaximize').click(); assert.equal(parseFloat(pane.style.width), width - 100);
  select(1); assert.equal(pane.hidden, false); select(0); assert.equal(pane.hidden, false); assert.equal(pane.parentNode, document.body); assert.equal($('sqlPage').textContent, page);
  editor.visible = false; controller.sync(); assert.equal(pane.hidden, true); editor.visible = true; controller.sync(); assert.equal(pane.hidden, false);
  $('sqlCollapse').click(); assert.equal(pane.hidden, true); assert.equal($('sqlShowResults').hidden, false);
  $('sqlShowResults').click(); assert.equal(pane.hidden, false);
  $('sqlLayoutToggle').click(); assert.equal(pane.parentNode, container); assert.equal(pane.previousElementSibling, divider); assert.equal(pane.style.width, ''); assert.equal(divider.hidden, false); assert.equal(window.localStorage.getItem('lemon:resultsLayout'), 'docked');
  assert.equal($('sqlPage').textContent, page);
  $('sqlExpand').click(); assert.equal(divider.hidden, true); assert.equal(container.classList.contains('sql-expanded'), true);
  $('sqlExpand').click(); assert.equal(divider.hidden, false); assert.equal(size(), initial);
});

test('each execution keeps a tab with independent filters, sorting, pages and immutable SQL', async t => {
  const { $, finish, settle, files, select } = await ui(t);
  const tabs = () => [...$('sqlResultTabs').querySelectorAll('[role="tab"]')];
  const data = (label, count) => ({ ok: true, columns: ['value'], rows: Array.from({ length: count }, (_, i) => [`${label} ${i}`]), rowCount: count, durationMs: 10 });
  $('sqlRun').click(); finish(data('first', 120)); await settle();
  $('sqlFilter').value = 'first'; $('sqlFilter').dispatchEvent(new window.Event('input'));
  document.querySelector('.sql-column-sort').click(); document.querySelector('.sql-column-sort').click(); $('sqlNext').click();
  const firstCell = document.querySelector('.sql-table tbody tr td:nth-child(2)').textContent;
  $('sqlRun').click(); assert.equal(tabs().length, 2); assert.equal($('sqlResultTabs').querySelectorAll('button:disabled').length, 1);
  tabs()[0].click(); assert.match($('sqlPage').textContent, /2 \/ 3/); assert.equal($('sqlFilter').value, 'first');
  finish(data('second', 3)); await settle();
  assert.equal(tabs()[0].getAttribute('aria-selected'), 'true', 'completion must not steal the active result');
  assert.equal(document.querySelector('.sql-table tbody tr td:nth-child(2)').textContent, firstCell);
  tabs()[1].click(); assert.equal($('sqlFilter').value, ''); assert.match($('sqlSummary').textContent, /3 行/);
  select(1); $('sqlRun').click(); $('sqlParamsFields').querySelector('input').value = '20260917'; $('sqlParamsForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  finish(data('third', 1)); await settle(); assert.equal(tabs().length, 3); assert.match($('sqlResultNote').textContent, /b.sql/);
  tabs()[0].click(); assert.match($('sqlResultNote').textContent, /a.sql/); assert.equal($('sqlExecuted').textContent, 'SELECT 1;');
  files.splice(0, 1); select(0); assert.equal(tabs().length, 3, 'closing the source editor does not erase results');
  document.querySelector('[aria-label="关闭结果 1"]').click(); assert.equal(tabs().length, 2); assert.match($('sqlSummary').textContent, /3 行/);
  tabs()[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); assert.equal(tabs()[1].getAttribute('aria-selected'), 'true');
  files.push({ id: 9, cwd: '/other', path: 'other.sql', language: 'sql', content: 'SELECT 9', start: 0, end: 0 });
  select(files.length - 1); assert.equal($('sqlResults').hidden, true);
  select(0); assert.equal($('sqlResults').hidden, false); assert.equal(tabs().length, 2);
});

test('business dates use yesterday in local calendar time across month, leap-year and year boundaries', () => {
  assert.equal(yesterdayBusinessDate(new Date(2026, 0, 1, 0, 5)), '20251231');
  assert.equal(yesterdayBusinessDate(new Date(2024, 2, 1, 0, 5)), '20240229');
  assert.equal(yesterdayBusinessDate(new Date(2026, 2, 1, 0, 5)), '20260228');
  assert.equal(calendarDate('20260921'), '2026-09-21');
  assert.equal(calendarDate('2024-02-29'), '2024-02-29');
  for (const date of ['20230229', '20260431', '00000101', 'partial']) assert.equal(calendarDate(date), '');
});

test('bizdate defaults to yesterday, supports typing and calendar selection, and submits only the named YYYYMMDD parameter', async t => {
  const { $, select, files, requests, finish, settle } = await ui(t);
  files[1].content = "SELECT '${bdp.system.bizdate}' AS dt, '${region}' AS region";
  createParameterMemory(window.localStorage).save({ ...files[1], sql: files[1].content, engine: 'huawei' }, { 'bdp.system.bizdate': '20200101', region: 'north' });
  select(1); $('sqlRun').click();
  const date = $('sqlParamsFields').querySelector('[name="bdp.system.bizdate"]'), picker = $('sql-business-calendar');
  assert.equal(date.value, yesterdayBusinessDate()); assert.equal(date.type, 'text');
  assert.equal(picker.hidden, false); assert.equal(date.getAttribute('aria-expanded'), 'true');
  assert.equal($('sqlParamsFields').querySelector('.sql-date-trigger'), null);
  assert.equal($('sqlParamsFields').querySelector('[name=region]').value, 'north');
  date.value = '20240229'; date.dispatchEvent(new window.Event('input'));
  assert.equal(picker.querySelector('[aria-selected=true]').dataset.dateValue, '2024-02-29');
  picker.querySelector('[data-date-year]').click(); picker.querySelector('[data-date-value="2026"]').click();
  picker.querySelector('[data-date-value="8"]').click(); picker.querySelector('[data-date-value="2026-09-15"]').click();
  assert.equal(date.value, '20260915'); assert.equal(document.activeElement, date);
  assert.equal(picker.hidden, true); assert.equal(date.getAttribute('aria-expanded'), 'false');
  assert.equal(requests.filter(r => r.route === '/api/sql/query').length, 0);
  $('sqlParamsForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.deepEqual(requests.at(-1).body.params, { 'bdp.system.bizdate': '20260915', region: 'north' });
  finish({ ok: true, columns: ['dt'], rows: [['20260915']], rowCount: 1, durationMs: 1 }); await settle();
  $('sqlRepeat').click(); $('sqlReviewForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.equal($('sqlParamsFields').querySelector('[name="bdp.system.bizdate"]').value, '20260915', 'explicit historical queries retain the reviewed date');
  $('sqlParamsCancel').click(); $('sqlRun').click();
  assert.equal($('sqlParamsFields').querySelector('[name="bdp.system.bizdate"]').value, yesterdayBusinessDate(), 'ordinary new queries do not inherit a stale remembered date');
  $('sqlParamsClear').click(); assert.equal($('sqlParamsFields').querySelector('[name="bdp.system.bizdate"]').value, '');
  assert.equal($('sql-business-calendar').querySelector('[aria-selected=true]'), null);
  $('sqlParamsCancel').click(); assert.equal(requests.filter(r => r.route === '/api/sql/query').length, 1);
});

test('manual business dates normalize dashed dates and other parameter names stay plain text', async t => {
  const { $, select, files, requests, finish, settle } = await ui(t);
  files[1].content = "SELECT '${bdp.system.bizdate}' AS dt, '${bizdate}' AS other";
  select(1); $('sqlRun').click();
  const date = $('sqlParamsFields').querySelector('[name="bdp.system.bizdate"]');
  date.value = '2026-09-17'; $('sqlParamsFields').querySelector('[name=bizdate]').value = 'unchanged';
  assert.equal($('sqlParamsFields').querySelectorAll('.sql-date-calendar').length, 1);
  assert.equal($('sqlParamsFields').querySelector('[name=bizdate]').getAttribute('aria-haspopup'), null);
  $('sqlParamsForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.deepEqual(requests.at(-1).body.params, { 'bdp.system.bizdate': '20260917', bizdate: 'unchanged' });
  finish({ ok: true, columns: [], rows: [], rowCount: 0, durationMs: 1 }); await settle();
});

test('business-date dropdown handles keyboard navigation, outside dismissal, month/year navigation and shortcuts without querying', async t => {
  const { $, select, files, requests } = await ui(t);
  files[1].content = "SELECT '${bdp.system.bizdate}' AS dt, '${region}' AS region";
  select(1); $('sqlRun').click();
  const date = $('sqlParamsFields').querySelector('[name="bdp.system.bizdate"]'), picker = $('sql-business-calendar');
  const key = (target, value, extra = {}) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }));
  date.value = '20240131'; date.dispatchEvent(new window.Event('input'));
  key(date, 'ArrowDown'); assert.equal(document.activeElement.dataset.dateValue, '2024-01-31');
  key(document.activeElement, 'PageDown'); assert.equal(document.activeElement.dataset.dateValue, '2024-02-29');
  key(document.activeElement, 'ArrowRight'); assert.equal(document.activeElement.dataset.dateValue, '2024-03-01');
  key(document.activeElement, 'Enter'); assert.equal(date.value, '20240301'); assert.equal(picker.hidden, true);
  date.click(); assert.equal(picker.hidden, false);
  const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); date.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true); assert.equal(picker.hidden, true); assert.equal($('sqlParamsDialog').open, true);
  date.click(); picker.querySelector('[data-date-nav="-1"]').click(); assert.equal(picker.querySelector('[data-date-month]').textContent, '2月');
  picker.querySelector('[data-date-month]').click(); picker.querySelector('[data-date-nav="1"]').click();
  assert.equal(picker.querySelector('[data-date-year]').textContent, '2025年');
  picker.querySelector('[data-date-value="0"]').click(); picker.querySelector('[data-date-value="2025-01-17"]').click();
  assert.equal(date.value, '20250117'); date.click(); picker.querySelector('[data-date-shortcut=yesterday]').click();
  assert.equal(date.value, yesterdayBusinessDate()); assert.equal(picker.hidden, true);
  date.click(); $('sqlParamsFields').querySelector('[name=region]').focus(); assert.equal(picker.hidden, true);
  date.focus(); assert.equal(picker.hidden, false);
  $('sqlParamsTitle').dispatchEvent(new window.Event('pointerdown', { bubbles: true })); assert.equal(picker.hidden, true);
  date.click(); key(date, 'Enter'); assert.equal(picker.hidden, true);
  assert.equal(requests.filter(r => r.route === '/api/sql/query').length, 0);
  date.click(); $('sqlParamsCancel').click(); assert.equal(picker.hidden, true);
  $('sqlRun').click(); assert.notEqual($('sql-business-calendar'), picker); assert.equal(picker.hidden, true);
});

test('parameters prefill across files and reopen, cancellation keeps previous values, clear forgets them', async t => {
  const { $, select, files, finish, settle, requests } = await ui(t);
  select(1); $('sqlRun').click(); $('sqlParamsFields').querySelector('input').value = '20260917';
  $('sqlParamsForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  finish({ ok: true, columns: ['dt'], rows: [['20260917']], rowCount: 1, durationMs: 1 }); await settle();
  files[0].content = "SELECT '${date}' AS another"; files[0].start = files[0].end = 0;
  select(0); $('sqlRun').click(); assert.equal($('sqlParamsFields').querySelector('input').value, '20260917');
  $('sqlParamsFields').querySelector('input').value = 'cancelled'; $('sqlParamsCancel').click();
  $('sqlRun').click(); assert.equal($('sqlParamsFields').querySelector('input').value, '20260917');
  $('sqlParamsClear').click(); assert.equal($('sqlParamsFields').querySelector('input').value, ''); $('sqlParamsCancel').click();
  $('sqlRun').click(); assert.equal($('sqlParamsFields').querySelector('input').value, ''); $('sqlParamsCancel').click();
  assert.equal(requests.filter(request => request.route === '/api/sql/query').length, 1);
});

test('parameter memory survives controller recreation and isolates projects, engines and positional SQL', () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const a = { cwd: '/a', engine: 'huawei', sql: 'SELECT ?' };
  const first = createParameterMemory(storage); first.save(a, { 'bdp.system.bizdate': '20260917', param1: '1' });
  const next = createParameterMemory(storage);
  assert.equal(next.get({ ...a, sql: 'other SQL' }, 'bdp.system.bizdate'), '20260917');
  assert.equal(next.get({ ...a, engine: 'aliyun' }, 'bdp.system.bizdate'), '');
  assert.equal(next.get({ ...a, cwd: '/b' }, 'bdp.system.bizdate'), '');
  assert.equal(next.get(a, 'param1'), '1'); assert.equal(next.get({ ...a, sql: 'SELECT ? + 1' }, 'param1'), '');
  const blocked = createParameterMemory({ getItem() { throw Error('blocked'); }, setItem() { throw Error('quota'); }, removeItem() { throw Error('blocked'); } });
  blocked.save(a, { date: '' }); assert.equal(blocked.get(a, 'date'), ''); blocked.save(a, { date: 'new' }); assert.equal(blocked.get(a, 'date'), 'new');
});

test('checkbox filters distinguish typed values, combine columns and count all pages without self-filtering', () => {
  const result = { columns: ['event', 'group'], rows: [[null, 'a'], ['', 'a'], ['NULL', 'a'], [0, 'a'], ['0', 'b'], [false, 'b'], ['pageview', 'a'], ['pageview', 'b']] };
  const rule = { column: 'event', op: 'in', values: [columnValueKey(null), columnValueKey(0)] };
  assert.deepEqual(filterRows(result, '', null, [rule]), [[null, 'a'], [0, 'a']]);
  assert.deepEqual(filterRows(result, '', null, [{ ...rule, values: [] }]), []);
  const groupRule = { column: 'group', op: 'equals', value: 'a' };
  const options = columnOptions(result, 'event', '', [rule, groupRule]);
  assert.equal(options.find(item => item.value === 'pageview').count, 1, 'ignore own filter, respect other column');
  assert.equal(options.find(item => item.value === '0').count, 0, 'keep currently unavailable values selectable');
  assert.equal(columnOptions(result, 'event', 'pageview', [rule]).find(item => item.value === 'pageview').count, 2);
  assert.deepEqual(filterRows(result, '', null, [{ column: 'event', op: 'in', values: [columnValueKey('pageview')] }, groupRule]), [['pageview', 'a']]);
  const objectRows = { columns: ['v'], rows: [{v: '<img onerror=bad()>'}, {v: {a: 1}}, {}] };
  assert.equal(filterRows(objectRows, '', null, [{column: 'v', op: 'in', values: [columnValueKey({a: 1})]}]).length, 1);
});

test('checkbox menu keeps drafts until confirm, searches values, cancels safely and supports empty selection', async t => {
  const { $, finish, settle } = await ui(t);
  $('sqlRun').click(); finish({ok: true, columns: ['event'], rows: Array.from({length:130}, (_, i) => [i % 2 ? 'pageview' : 'WebClick']), rowCount:130, durationMs:5}); await settle();
  const open = () => document.querySelector('.sql-column-trigger').click();
  const confirm = () => $('sqlValuesForm').dispatchEvent(new window.Event('submit', {cancelable:true}));
  open(); assert.equal($('sqlValueList').querySelectorAll('input').length, 2); assert.match($('sqlValueList').textContent, /\(65\)/);
  $('sqlValuesNone').click(); assert.match($('sqlSummary').textContent, /^130 行/, 'draft does not change results');
  $('sqlValuesCancel').click(); open(); assert.equal($('sqlValueList').querySelectorAll('input:checked').length, 2);
  $('sqlValuesNone').click(); $('sqlValueSearch').value = 'page'; $('sqlValueSearch').dispatchEvent(new window.Event('input'));
  assert.equal($('sqlValueList').querySelectorAll('input').length, 1); $('sqlValuesAll').click(); confirm();
  assert.match($('sqlSummary').textContent, /^65 \/ 130/); assert.match($('sqlPage').textContent, /1 \/ 2/);
  open(); assert.equal($('sqlValueList').querySelectorAll('input:checked').length, 1);
  $('sqlValuesInvert').click(); $('sqlValuesCancel').click(); assert.match($('sqlResultBody').textContent, /pageview/);
  open(); $('sqlValuesInvert').click(); confirm(); assert.match($('sqlResultBody').textContent, /WebClick/); assert.doesNotMatch($('sqlResultBody').textContent, /pageview/);
  open(); $('sqlValuesNone').click(); document.dispatchEvent(new window.KeyboardEvent('keydown', {key:'Escape'}));
  assert.equal($('sqlColumnMenu').hidden, true); assert.match($('sqlSummary').textContent, /^65 \/ 130/);
  open(); $('sqlValuesNone').click(); confirm(); assert.match($('sqlSummary').textContent, /^0 \/ 130/);
  open(); assert.equal($('sqlValueList').querySelectorAll('input:checked').length, 0); $('sqlValuesAll').click(); confirm(); assert.match($('sqlSummary').textContent, /^130 行/);
  open(); $('sqlValueSearch').value = 'page'; $('sqlValueSearch').dispatchEvent(new window.Event('input')); confirm();
  assert.match($('sqlSummary').textContent, /^65 \/ 130/, 'search and confirm keeps only matching checked values, like a spreadsheet');
});

test('large checkbox lists search and bulk-select beyond their rendered batch; tabs keep independent filters', async t => {
  const { $, finish, settle } = await ui(t);
  $('sqlRun').click(); finish({ok:true, columns:['event'], rows:Array.from({length:450}, (_, i) => [`value-${i}`]), rowCount:450, durationMs:5}); await settle();
  const open = () => document.querySelector('.sql-column-trigger').click();
  const confirm = () => $('sqlValuesForm').dispatchEvent(new window.Event('submit', {cancelable:true}));
  open(); assert.equal($('sqlValueList').querySelectorAll('input').length, 200);
  $('sqlValueList').querySelector('button').click(); assert.equal($('sqlValueList').querySelectorAll('input').length, 400);
  $('sqlValuesNone').click(); $('sqlValueSearch').value = 'value-449'; $('sqlValueSearch').dispatchEvent(new window.Event('input'));
  $('sqlValuesAll').click(); confirm(); assert.match($('sqlSummary').textContent, /^1 \/ 450/); assert.match($('sqlResultBody').textContent, /value-449/);
  $('sqlRun').click(); finish({ok:true, columns:['event'], rows:[['second-result']], rowCount:1, durationMs:5}); await settle();
  assert.match($('sqlSummary').textContent, /^1 行/);
  $('sqlResultTabs').querySelector('[role=tab]').click(); assert.match($('sqlSummary').textContent, /^1 \/ 450/);
  open(); $('sqlValuesAll').click(); confirm(); assert.match($('sqlSummary').textContent, /^450 行/, 'bulk select covers values beyond displayed batch');
  open(); $('sqlValuesNone').click(); $('sqlResultTabs').querySelectorAll('[role=tab]')[1].click(); confirm();
  assert.match($('sqlResultBody').textContent, /second-result/); assert.match($('sqlSummary').textContent, /^1 行/, 'stale menu cannot apply to another tab');
});

test('bottom dock follows the editor column and reserves the composer when returning to chat-only layout', async t => {
  const { $, settle } = await ui(t, true), surface = $('workSurface'), panes = $('workspacePanes');
  surface.getBoundingClientRect = () => ({ height: 900 });
  document.querySelector('.conversation-heading').getBoundingClientRect = () => ({ height: 52 });
  let composerHeight = 220;
  document.querySelector('.composer-area').getBoundingClientRect = () => ({ height: composerHeight });
  $('fileEditor').hidden = false; panes.classList.add('editor-docked'); panes.style.setProperty('--editor-split-size', '640px');
  surface.dataset.mode = 'both'; $('bottomTabResults').click(); await settle();
  assert.equal(surface.classList.contains('bottom-under-editor'), true);
  assert.equal(surface.style.getPropertyValue('--bottom-panel-width'), '640px');
  panes.style.setProperty('--editor-split-size', '480px'); await settle();
  assert.equal(surface.style.getPropertyValue('--bottom-panel-width'), '480px', 'the dock must follow horizontal split dragging');
  $('bottomPanelExpand').click(); const expanded = parseFloat(surface.style.getPropertyValue('--bottom-panel-height'));
  surface.dataset.mode = 'chat'; await settle();
  const chatHeight = () => 900 - 48 - parseFloat(surface.style.getPropertyValue('--bottom-panel-height'));
  assert.equal(surface.classList.contains('bottom-under-editor'), false);
  assert.ok(chatHeight() >= 52 + composerHeight + 120, 'expanded tools must leave the full composer and readable messages visible');
  assert.ok(parseFloat(surface.style.getPropertyValue('--bottom-panel-height')) < expanded);
  composerHeight = 320; window.dispatchEvent(new window.Event('resize'));
  assert.ok(chatHeight() >= 52 + composerHeight + 120, 'multiline drafts require more reserved space');
  surface.dataset.mode = 'both'; await settle(); assert.equal(surface.classList.contains('bottom-under-editor'), true);
  panes.classList.replace('editor-docked', 'editor-floating'); await settle();
  assert.equal(surface.classList.contains('bottom-under-editor'), false, 'floating editors must not leave a phantom dock column');
});
