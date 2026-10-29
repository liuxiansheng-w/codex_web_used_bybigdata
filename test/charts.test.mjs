import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createChartScene } from '@tanstack/charts';
import { renderChartSvg } from '@tanstack/charts/svg';
import { defaultChartSettings, prepareChart, chartNumber } from '../browser/chart-data.js';
import { createChartPanel, chartDefinition } from '../browser/chart-panel.js';
import { runTool } from '../public/toolbox-core.js';

const table = { columns: ['月份', '金额', '组别'], rows: [['一月', '12.5', 'A'], ['二月', '20', 'A'], ['一月', '9', 'B'], ['二月', '17', 'B']] };
const theme = { foreground: '#111722', background: '#fff', muted: '#667788', grid: '#ddd', palette: ['#60a5fa', '#a78bfa'] };
test('all four chart definitions produce real TanStack scenes and distinct pie/donut geometry', () => {
  let pieSvg;
  for (const type of ['line', 'bar', 'pie', 'donut']) {
    const settings = { ...defaultChartSettings(table), type, series: '组别', aggregate: type === 'pie' || type === 'donut' ? 'sum' : 'none' };
    const model = prepareChart(table, settings), scene = createChartScene(chartDefinition(model, theme), { width: 600, height: 320 });
    const svg = renderChartSvg(scene, { ariaLabel: type });
    assert.match(svg, /<svg/); assert.equal(scene.points.length, model.points.length);
    if (type === 'line') assert.match(svg, /<path/);
    if (type === 'bar') assert.match(svg, /<rect/);
    if (type === 'pie') pieSvg = svg;
    if (type === 'donut') assert.notEqual(svg.replaceAll('donut', ''), pieSvg.replaceAll('pie', ''));
  }
});
test('chart preparation preserves data, validates units and requires explicit duplicate aggregation', () => {
  const input = JSON.stringify(table), settings = { ...defaultChartSettings(table), series: '组别' };
  assert.equal(prepareChart(table, settings).points.length, 4); assert.equal(JSON.stringify(table), input);
  assert.throws(() => prepareChart(table, { ...settings, series: '' }), /多行/);
  assert.deepEqual(prepareChart(table, { ...settings, series: '', aggregate: 'sum' }).points.map(p => p.value), [21.5, 37]);
  assert.equal(prepareChart(table, { ...settings, series: '', aggregate: 'average' }).points[0].value, 10.75);
  assert.equal(prepareChart(table, { ...settings, series: '', aggregate: 'count' }).points[0].value, 2);
  for (const value of [null, '', true, 'bad', '9007199254740993', Infinity]) assert.equal(chartNumber(value), null);
  const rates = { columns: ['day', 'rate'], rows: [['a', '12.3%'], ['b', '0%'], ['c', null]] };
  assert.equal(prepareChart(rates, defaultChartSettings(rates)).points[0].value, 12.3);
  assert.equal(prepareChart(rates, defaultChartSettings(rates)).skipped, 1);
  assert.throws(() => prepareChart({ ...rates, rows: [['a', '1%'], ['b', '2']] }, defaultChartSettings(rates)), /单位/);
  for (const type of ['pie', 'donut']) {
    assert.throws(() => prepareChart({ ...rates, rows: [['a', '-1']] }, { ...defaultChartSettings(rates), type }), /负数/);
    assert.throws(() => prepareChart({ ...rates, rows: [['a', '0']] }, { ...defaultChartSettings(rates), type }), /正数/);
  }
  assert.throws(() => prepareChart({ columns: ['x', 'y'], rows: Array.from({ length: 501 }, (_, i) => [String(i), i]) }, { x: 'x', y: 'y', type: 'line' }), /500/);
});
test('chart imports keep large IDs as text and reject ambiguous headers without external calls', async () => {
  const result = await runTool({ category: 'chart', action: 'json', input: '[{"id":9007199254740993,"amount":12.1}]' });
  assert.equal(result.table.rows[0][0], '9007199254740993'); assert.equal(result.table.rows[0][1], '12.1'); assert.equal(result.insertable, false);
  const csv = await runTool({ category: 'chart', action: 'csv', input: 'name,value\n"a,b",12\n' });
  assert.deepEqual(csv.table.rows, [['a,b', '12']]);
  await assert.rejects(runTool({ category: 'chart', action: 'csv', input: 'x,x\n1,2' }), /表头/);
});
test('chart controls mount all types, expose truncation, escape labels and release DOM on destroy', async t => {
  const dom = new JSDOM('<main data-module-theme="results"><section></section></main>', { pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  t.after(() => { dom.window.close(); Object.assign(globalThis, previous); });
  const container = document.querySelector('section'), changes = [], panel = createChartPanel(container, { onChange: settings => changes.push(settings) });
  t.after(() => panel.destroy());
  panel.setData({ columns: ['name', 'value'], rows: [['<img src=x onerror=alert(1)>', 3], ['正常', 5]] }, { truncated: true, note: '模拟预览' });
  assert.match(container.querySelector('.chart-scope').textContent, /截断预览/);
  const control = container.querySelector('[data-chart-control=type]');
  for (const type of ['line', 'bar', 'pie', 'donut']) {
    control.value = type; control.dispatchEvent(new window.Event('change'));
    assert.equal(container.querySelector('.chart-status').dataset.error, 'false', container.textContent);
    assert.equal(container.querySelector('.chart-surface').dataset.chartType, type); assert.ok(container.querySelector('svg'));
    assert.equal(container.querySelector('[data-chart-download]').disabled, false);
  }
  assert.equal(container.querySelector('img,script'), null); assert.equal(changes.at(-1).type, 'donut');
  const responsiveSvg = container.querySelector('.chart-surface > svg');
  responsiveSvg.setAttribute('width', '100%'); responsiveSvg.setAttribute('height', '100%'); responsiveSvg.setAttribute('viewBox', '0 0 1005.75 320');
  let exported; window.URL.createObjectURL = blob => { exported = blob; return 'blob:chart-test'; }; window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  container.querySelector('[data-chart-download]').click();
  const exportedText = await new Promise(resolve => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(exported); });
  assert.match(exportedText, /注意：截断预览/); assert.match(exportedText, /&lt;img/);
  const exportedDoc = new window.DOMParser().parseFromString(exportedText, 'image/svg+xml'); assert.equal(exportedDoc.querySelector('parsererror,img,script'), null);
  assert.equal(exportedDoc.documentElement.getAttribute('width'), '1005.75');
  assert.equal(exportedDoc.documentElement.getAttribute('height'), '474');
  assert.equal(exportedDoc.documentElement.getAttribute('viewBox'), '0 0 1005.75 474');
  panel.setData({ columns: ['x', 'y'], rows: [['a', '-3']] }, { settings: { type: 'pie' } });
  assert.match(container.querySelector('.chart-status').textContent, /负数/); assert.equal(container.querySelector('[data-chart-download]').disabled, true);
  panel.destroy(); assert.equal(container.children.length, 0);
});
