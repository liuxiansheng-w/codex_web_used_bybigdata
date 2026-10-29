import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createChartScene } from '@tanstack/charts';
import { renderChartSvg } from '@tanstack/charts/svg';
import { chartTypes, chartNumber, defaultChartSettings, prepareChart } from '../browser/chart-data.js';
import { chartDefinition, createChartPanel } from '../browser/chart-panel.js';
import { chartAiConfig, chartAiData, readChartSpec, chartSettings } from '../browser/chart-protocol.js';
import { createMessageCharts } from '../browser/chart-messages.js';
import { createMessageRenderer } from '../public/message-renderer.js';
import { createToolbox } from '../public/toolbox.js';
import { createComposerTools } from '../public/composer.js';
import { parseChartInput, runTool } from '../public/toolbox-core.js';
import { markdown } from '../public/markdown.js';

const wide = { columns: ['月份', '销售额', '目标'], rows: [[1, 186, 200], [2, 305, 250], [3, 237, 260]] };
const theme = { background: '#102030', foreground: '#edf2fa', grid: '#243040', muted: '#99aabb' };
const chartSpec = settings => JSON.stringify({ version: 1, settings: { type: 'line', x: '月份', y: '销售额', ...settings }, data: wide });
const fenced = settings => '```chart\n' + chartSpec(settings) + '\n```';
const settle = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(setImmediate); } assert.fail('UI did not settle'); };
function browser(t, html = '<article></article>') {
  const errors = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'https://fictional.test', pretendToBeVisual: true, virtualConsole: console });
  const old = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage, File: globalThis.File, FileReader: globalThis.FileReader };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, File: dom.window.File, FileReader: dom.window.FileReader });
  dom.cleanup = []; t.after(() => { for (const clean of dom.cleanup.reverse()) clean(); dom.window.close(); Object.assign(globalThis, old); assert.deepEqual(errors, []); }); return dom;
}

test('nine native chart types support wide metrics, stacked totals and true numeric scatter axes', () => {
  for (const [type] of chartTypes) {
    const model = prepareChart(wide, { ...defaultChartSettings(wide), type, ys: ['目标'], smooth: true });
    const scene = createChartScene(chartDefinition(model, theme), { width: 800, height: 400 });
    assert.ok(scene.points.length >= model.points.length, type); assert.match(renderChartSvg(scene, { ariaLabel: type }), /<svg/);
    if (type === 'stacked') assert.equal(model.points.find(p => p.label === '1' && p.metric === '目标').end, 386);
    if (type === 'scatter') assert.deepEqual(scene.scales.x.domain, [1, 3]);
    if (type === 'combo') assert.equal(model.series.length, 2);
  }
  assert.throws(() => prepareChart({ columns: ['name', 'amount'], rows: [['a', 2]] }, { type: 'scatter', x: 'name', y: 'amount' }), /横轴需为数值/);
});

test('direct spreadsheet, CSV, Markdown, matrix and object input preserve original cells and numeric IDs', () => {
  for (const source of ['月份\t销售额\n1月\t186\n2月\t305', '月份,销售额\n1月,186\n2月,305', '| 月份 | 销售额 |\n| --- | ---: |\n| 1月 | 186 |\n| 2月 | 305 |', '月份 | 销售额\n--- | ---:\n1月 | 186\n2月 | 305', '[["月份","销售额"],["1月",186],["2月",305]]', '[{"月份":"1月","销售额":186},{"月份":"2月","销售额":305}]']) {
    assert.deepEqual(parseChartInput(source), { columns: ['月份', '销售额'], rows: [['1月', '186'], ['2月', '305']] });
  }
  assert.equal(chartNumber('1,234.50'), 1234.5); assert.equal(chartNumber('12,34'), null);
  assert.equal(parseChartInput('[{"id":9007199254740993,"v":3}]').rows[0][0], '9007199254740993');
  assert.deepEqual(parseChartInput('name\tnote\tv\na\t"two\nlines"\t3').rows, [['a', 'two\nlines', '3']]);
  for (const source of ['x\tx\n1\t2', 'x\ty\n1\t2\t3']) assert.throws(() => parseChartInput(source), /表头/);
});

test('AI chart JSON is bounded inert data and round-trips settings without losing large category IDs', async () => {
  const source = '{"version":1,"settings":{"type":"bar","x":"id","y":"amount","colors":["#abcdef"],"height":500},"data":{"columns":["id","amount"],"rows":[[9007199254740993,12.5]]}}';
  const read = readChartSpec(source); assert.equal(read.table.rows[0][0], '9007199254740993'); assert.equal(read.settings.height, 500);
  const imported = await runTool({ category: 'chart', action: 'auto', input: source }); assert.equal(imported.settings.type, 'bar'); assert.equal(imported.table.rows[0][0], '9007199254740993');
  for (const settings of [{ colors: ['url(https://evil.test/a)'] }, { colors: ['red'] }, { width: 10000 }, { height: 10 }, { precision: 1.5 }, { labels: 'yes' }, { type: 'script' }, { ys: Array(13).fill('x') }]) assert.throws(() => chartSettings(settings));
  assert.throws(() => readChartSpec('x'.repeat(1_000_001)), /100 万/);
  const hostile = readChartSpec(chartSpec({ title: '<img src=x onerror=alert(1)>', xTitle: '<script>bad</script>', code: 'fetch("https://evil.test")' })); assert.equal(hostile.settings.code, undefined);
  const special = prepareChart({ columns: ['name', 'v'], rows: [['toString', 2], ['__proto__', 3]] }, { ...defaultChartSettings({ columns: ['name', 'v'], rows: [['toString', 2], ['__proto__', 3]] }), type: 'donut' });
  assert.doesNotThrow(() => createChartScene(chartDefinition(special, theme), { width: 600, height: 360 }));
  assert.match(chartAiConfig({ labels: true }), /```chart/); assert.match(chartAiData(wide, '已加载 3 行', true), /截断预览/);
});

test('labels, category colors, resize settings and exported SVG contain visible dimensions and data', async t => {
  const dom = browser(t), host = document.querySelector('article'), contexts = [], panel = createChartPanel(host, { onContext: text => contexts.push(text) }); dom.cleanup.push(() => panel.destroy());
  panel.setData(wide, { settings: { type: 'line', title: '销售趋势', height: 480, labels: true, colorOverrides: { '销售额': '#ff6600' } }, note: '虚构测试数据' });
  assert.equal(host.querySelector('.chart-surface').style.height, '480px'); assert.match(host.querySelector('[data-chart-labels]').textContent, /186/); assert.match(host.querySelector('.chart-dimensions').textContent, /月份.*销售额/);
  assert.match(host.querySelector('svg').innerHTML, /#ff6600/);
  host.querySelector('[data-chart-ai=config]').click(); host.querySelector('[data-chart-ai=data]').click(); assert.equal(contexts.length, 2); assert.match(contexts[0], /销售趋势/); assert.match(contexts[1], /305/);
  const width = host.querySelector('[data-chart-control=width]'); width.value = '960'; width.dispatchEvent(new dom.window.Event('change')); assert.equal(host.querySelector('.chart-surface').style.width, '960px');
  const labels = host.querySelector('[data-chart-control=labels]'); labels.checked = false; labels.dispatchEvent(new dom.window.Event('change')); assert.equal(host.querySelector('[data-chart-labels]'), null);
  let exported; dom.window.URL.createObjectURL = blob => { exported = blob; return 'blob:test'; }; dom.window.URL.revokeObjectURL = () => {}; dom.window.HTMLAnchorElement.prototype.click = () => {};
  host.querySelector('[data-chart-download]').click();
  const text = await new Promise(resolve => { const reader = new dom.window.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(exported); });
  const svg = new dom.window.DOMParser().parseFromString(text, 'image/svg+xml'); assert.equal(svg.querySelector('parsererror'), null); assert.match(svg.documentElement.textContent, /销售趋势.*维度：月份.*虚构测试数据/s);
});

test('complete chart replies render, incomplete fences stay text, streaming preserves local styling and removal disposes', async t => {
  const dom = browser(t); const el = document.querySelector('article');
  const renderer = createMessageRenderer({ document, onCopy() {}, onOpenFile() {}, loadCharts: async () => ({ createMessageCharts }) }); dom.cleanup.push(() => renderer.dispose());
  renderer.update(el, { text: fenced({}) }); await settle(() => el.querySelector('.chart-surface svg'));
  const surface = el.querySelector('.chart-surface'), title = el.querySelector('[data-chart-control=title]'); title.value = '用户修改'; title.dispatchEvent(new window.Event('change')); title.blur();
  renderer.update(el, { text: fenced({}) + '\n\n后续说明' }); assert.equal(el.querySelector('.chart-surface'), surface); assert.equal(title.value, '用户修改');
  renderer.update(el, { text: fenced({ type: 'bar' }) }); await settle(() => el.querySelector('.chart-surface')?.dataset.chartType === 'bar'); assert.notEqual(el.querySelector('.chart-surface'), surface);
  assert.equal(markdown(fenced({}), { charts: true }).includes('data-ai-chart-host'), true);
  assert.equal(markdown(fenced({})).includes('data-ai-chart-host'), false, 'non-chat Markdown keeps source without an unmounted placeholder');
  assert.equal(markdown('```chart\n' + chartSpec({}), { charts: true }).includes('data-ai-chart-host'), false);
  renderer.update(el, { text: '```chart\n{"version":1,"data":{"columns":["x","y"],"rows":[["a",3]]},"settings":{"colors":["url(evil)"]}}\n```' });
  await settle(() => /无法渲染/.test(el.textContent)); assert.equal(el.querySelector('.message-body').querySelector('iframe,img,script'), null);
  el.remove(); await new Promise(setImmediate); assert.equal(surface.querySelector('svg'), null);
});

test('toolbox forwards raw data and configuration separately, preserves source and never sends a model request', async t => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8'); const dom = browser(t, html), contexts = [], calls = []; let contextKey = 'first';
  const toolbox = createToolbox({ getContextKey: () => contextKey, onContext: text => { contexts.push(text); return true; }, runner: { cancel() {}, run: async payload => { calls.push(payload); return runTool(payload); } } }); dom.cleanup.push(() => toolbox.destroy());
  const $ = id => document.getElementById(id); toolbox.open(); document.querySelector('[data-category=chart]').click();
  $('toolboxInput').value = '随意原始文字：一月销售额186，二月305'; $('toolboxInput').dispatchEvent(new dom.window.Event('input'));
  $('toolboxChartConfig').click(); await settle(() => contexts.length === 1); assert.match(contexts[0], /```chart/); assert.equal($('toolboxPanel').hidden, true);
  toolbox.open(); $('toolboxChartData').click(); await settle(() => contexts.length === 2); assert.match(contexts[1], /一月销售额186/); assert.equal(calls.length, 0);
  toolbox.open(); $('toolboxChartBoth').click(); await settle(() => contexts.length === 3); assert.match(contexts[2], /```chart[\s\S]*二月305/); assert.equal($('toolboxInput').value, '随意原始文字：一月销售额186，二月305');
  toolbox.open(); $('toolboxChartData').click(); contextKey = 'other-thread'; await new Promise(setImmediate); assert.equal(contexts.length, 3, 'late module load must not enter another conversation');
  $('toolboxInput').value = chartSpec({ type: 'bar', title: '导入的配置' }); $('toolboxInput').dispatchEvent(new dom.window.Event('input')); $('toolboxRun').click();
  await settle(() => document.querySelector('#toolboxChart .chart-surface svg'));
  const chartTitle = document.querySelector('#toolboxChart [data-chart-control=title]'); chartTitle.value = '重开仍保留'; chartTitle.dispatchEvent(new dom.window.Event('change'));
  toolbox.close(); toolbox.open(); await settle(() => document.querySelector('#toolboxChart [data-chart-control=title]')?.value === '重开仍保留');
});

test('AI additions append short text and attach full long data without replacing an existing draft or sending', async t => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8'); const dom = browser(t, html);
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {} });
  document.querySelectorAll('dialog').forEach(dialog => { dialog.close = () => {}; dialog.showModal = () => {}; });
  const calls = [], controller = createComposerTools({ api: async (route, body) => { calls.push({ route, body }); return { id: 'fictional-attachment' }; }, notice() {}, getContext: () => ({ cwd: '/fictional', thread: null }), onChange() {} });
  const prompt = document.getElementById('prompt'); prompt.value = '保留我的要求'; assert.equal(controller.appendText('图表配置'), true); assert.equal(prompt.value, '保留我的要求\n\n图表配置');
  const long = '虚构数据'.repeat(2000); assert.equal(controller.appendText(long), true); await settle(() => calls.length === 1); await new Promise(setImmediate);
  assert.equal(prompt.value, '保留我的要求\n\n图表配置'); assert.equal(controller.snapshot().files[0].pastedText, long); assert.equal(calls[0].route, '/api/attachments/upload'); assert.equal(calls.some(call => /send|followup/.test(call.route)), false);
  controller.setBusy(false, true); assert.equal(controller.appendText('不要丢弃'), false);
});

test('PNG saving completes one download and cancels stale generation or reports rasterization errors', async t => {
  const dom = browser(t), host = document.querySelector('article'), panel = createChartPanel(host); dom.cleanup.push(() => panel.destroy());
  const images = [], downloads = [], drawn = [];
  dom.window.Image = class { constructor() { images.push(this); } set src(value) { this.url = value; } };
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({ scale() {}, drawImage(...args) { drawn.push(args); } });
  dom.window.HTMLCanvasElement.prototype.toBlob = function (callback, mime) { callback(new dom.window.Blob(['fake-raster-for-flow-test'], { type: mime })); };
  dom.window.URL.createObjectURL = blob => 'blob:' + blob.type; dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, type: this.href }); };
  panel.setData(wide); const png = host.querySelector('[data-chart-png]'); png.click(); assert.equal(png.disabled, true);
  images[0].onload(); await settle(() => downloads.length === 1); assert.match(downloads[0].name, /\.png$/); assert.match(downloads[0].type, /image\/png/); assert.equal(drawn.length, 1);
  await settle(() => !png.disabled); png.click(); const title = host.querySelector('[data-chart-control=title]'); title.value = '变更后的图'; title.dispatchEvent(new dom.window.Event('change'));
  images[1].onload(); await new Promise(setImmediate); assert.equal(downloads.length, 1, 'changed chart must not save a stale image');
  png.click(); images[2].onerror(); await settle(() => /PNG 生成失败/.test(host.textContent)); assert.equal(downloads.length, 1); assert.equal(png.disabled, false);
});

test('late chart-module initialization never mounts into a reply that changed or was removed', async t => {
  const dom = browser(t), el = document.querySelector('article'); let resolveModule, mounted = 0;
  const renderer = createMessageRenderer({ document, onCopy() {}, onOpenFile() {}, loadCharts: () => new Promise(resolve => { resolveModule = resolve; }) }); dom.cleanup.push(() => renderer.dispose());
  renderer.update(el, { text: fenced({}) }); renderer.update(el, { text: '已经替换为普通说明' });
  resolveModule({ createMessageCharts() { mounted++; return { sync() {}, destroy() {} }; } }); await new Promise(setImmediate);
  assert.equal(mounted, 0); assert.equal(el.querySelector('.ai-chart'), null);
});
