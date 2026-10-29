import { defineChart, mountChart, lineY, barY, barX, areaY, dot, group } from '@tanstack/charts';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scaleBand } from '@tanstack/charts/scales/band';
import { scalePoint } from '@tanstack/charts/scales/point';
import { pie, polar, radialArc } from '@tanstack/charts/polar';
import { tooltip } from '@tanstack/charts/tooltip';
import { d3Curve } from '@tanstack/charts';
import { curveMonotoneX } from 'd3-shape';
import { chartTypes, chartCell, chartNumber, defaultChartSettings, prepareChart } from './chart-data.js';
import { chartSettings, chartAiConfig, chartAiData } from './chart-protocol.js';

export const chartPalette = ['#60a5fa', '#a78bfa', '#34d399', '#fb7185', '#38bdf8', '#fb923c', '#c084fc', '#2dd4bf', '#818cf8', '#f472b6', '#94a3b8', '#d97706'];
const short = value => String(value).length > 32 ? String(value).slice(0, 31) + '…' : String(value);
const numberLabel = (value, settings) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: settings.precision ?? 2 });
const colorNames = model => model.round || model.settings?.categoryColors ? model.categories : model.series;
const colorRange = model => colorNames(model).map((name, i) => (model.settings?.colorOverrides && Object.hasOwn(model.settings.colorOverrides, name) ? model.settings.colorOverrides[name] : null) || (model.settings?.colors?.length ? model.settings.colors : chartPalette)[i % (model.settings?.colors?.length || chartPalette.length)]);
export function chartDefinition(model, theme) {
  const settings = model.settings || {}, names = colorNames(model), range = colorRange(model);
  const base = { theme, color: { domain: names, range }, tooltip, motion: false, clip: false, margin: { top: 30, right: model.type === 'horizontal' ? 65 : 30, bottom: 55, left: model.type === 'horizontal' ? 110 : 66 } };
  const paint = settings.categoryColors ? 'label' : 'series';
  if (model.round) return defineChart({ ...base, margin: 28, scales: { x: null, y: null }, marks: [polar({ inset: 8, radiusRatio: .92, scales: { angle: null, radius: null }, marks: [radialArc(pie(model.points, { value: 'value', gapAngle: .025 }), { key: 'key', color: 'label', innerRadius: ({ radius }) => model.type === 'donut' ? radius * .58 : 0, cornerRadius: 7, stroke: theme.background, strokeWidth: 2 })] })] });
  const options = { x: 'label', y: 'value', z: 'series', color: paint, key: 'key' };
  const values = model.points.flatMap(point => model.type === 'stacked' ? [point.start, point.end] : [point.value]);
  const low = Math.min(0, ...values), high = Math.max(0, ...values), pad = (high - low || 1) * .12;
  const numeric = () => scaleLinear().domain([low < 0 ? low - pad : 0, high + pad]);
  const band = () => scaleBand().domain(model.categories).padding(.25);
  const curve = settings.smooth ? d3Curve(curveMonotoneX) : undefined;
  let marks;
  if (model.type === 'horizontal') marks = [barX(model.points, { ...options, x: 'value', y: 'label', layout: group(), radius: 5, inset: 1 })];
  else if (model.type === 'bar') marks = [barY(model.points, { ...options, layout: group(), radius: 5, inset: 1 })];
  else if (model.type === 'stacked') marks = [barY(model.points, { ...options, y1: 'start', y2: 'end', radius: 2, inset: 1 })];
  else if (model.type === 'area') marks = [areaY(model.points, { ...options, curve, fillOpacity: .24 }), lineY(model.points, { ...options, curve, points: true, strokeWidth: 2.5 })];
  else if (model.type === 'scatter') marks = [dot(model.points, { ...options, x: 'nx', r: 5 })];
  else if (model.type === 'combo') marks = [barY(model.points.filter(p => p.series === model.series[0]), { ...options, radius: 5, inset: 8 }), lineY(model.points.filter(p => p.series !== model.series[0]), { ...options, curve, points: true, strokeWidth: 3 })];
  else marks = [lineY(model.points, { ...options, curve, points: true, strokeWidth: 2.5 })];
  const xTitle = settings.xTitle || model.x, yTitle = settings.yTitle || model.y;
  let scales;
  if (model.type === 'horizontal') scales = { x: { scale: numeric(), grid: true, axis: { label: yTitle } }, y: { scale: band(), axis: { label: xTitle } } };
  else scales = { x: { scale: model.type === 'scatter' ? scaleLinear().domain([Math.min(...model.points.map(p => p.nx)), Math.max(...model.points.map(p => p.nx))]) : ['bar', 'stacked', 'combo'].includes(model.type) ? band() : scalePoint().domain(model.categories).padding(.5), axis: { label: xTitle } }, y: { scale: numeric(), nice: true, grid: true, axis: { label: yTitle } } };
  return defineChart({ ...base, marks, scales });
}

export function createChartPanel(container, { onChange = () => {}, onContext, document: doc = container.ownerDocument } = {}) {
  const win = doc.defaultView;
  const make = (tag, text, className) => { const node = doc.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const svgNode = (tag, attrs, text) => { const node = doc.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); if (text != null) node.textContent = text; return node; };
  const button = (label, action) => { const node = make('button', label, 'text-button'); node.type = 'button'; node.onclick = action; return node; };
  container.classList.add('chart-panel');
  const controls = make('div', null, 'chart-controls'), selectors = {};
  for (const [key, name] of [['type', '图表类型'], ['x', '横轴 / 分类'], ['y', '主指标'], ['series', '分组列'], ['aggregate', '汇总方式'], ['order', '分类顺序']]) {
    const label = make('label', name), select = make('select'); select.dataset.chartControl = key; select.setAttribute('aria-label', name); label.append(select); controls.append(label); selectors[key] = select;
  }
  const extra = make('details', null, 'chart-customize'); extra.append(make('summary', '样式、更多指标与尺寸'));
  const fields = make('div', null, 'chart-custom-fields'), inputs = {};
  for (const [key, name, type] of [['title', '图表标题', 'text'], ['xTitle', '维度名称', 'text'], ['yTitle', '指标名称 / 单位', 'text'], ['width', '宽度（0 为自适应）', 'number'], ['height', '高度（像素）', 'number'], ['precision', '小数位数', 'number']]) {
    const label = make('label', name), input = make('input'); input.type = type; input.dataset.chartControl = key; input.setAttribute('aria-label', name);
    if (type === 'text') input.maxLength = 200; else { input.min = key === 'height' ? '240' : '0'; input.max = key === 'width' ? '2400' : key === 'height' ? '1200' : '8'; input.step = '1'; }
    label.append(input); fields.append(label); inputs[key] = input;
  }
  for (const [key, name] of [['labels', '显示数值标签'], ['legend', '显示图例'], ['smooth', '平滑曲线'], ['categoryColors', '按分类着色']]) {
    const label = make('label', null, 'chart-checkbox'), input = make('input'); input.type = 'checkbox'; input.dataset.chartControl = key; label.append(input, name); fields.append(label); inputs[key] = input;
  }
  const metrics = make('div', null, 'chart-metrics'), colors = make('div', null, 'chart-colors');
  extra.append(fields, make('p', '更多指标（与主指标一起绘制，需统一单位）', 'chart-help'), metrics, make('p', '系列 / 分类配色（点击色块可自由选择）', 'chart-help'), colors);
  const actions = make('div', null, 'chart-actions');
  const aiConfig = button('配置 → AI 对话', () => addContext('config')), aiData = button('数据 → AI 对话', () => addContext('data'));
  aiConfig.dataset.chartAi = 'config'; aiData.dataset.chartAi = 'data'; aiConfig.hidden = aiData.hidden = !onContext;
  const download = button('下载 SVG', () => save('svg')); download.dataset.chartDownload = '';
  const png = button('保存 PNG', () => void save('png')); png.dataset.chartPng = '';
  const json = button('保存配置与数据', () => save('json')); json.dataset.chartJson = '';
  const fit = button('适应宽度', () => change({ width: 0 })); actions.append(aiConfig, aiData, fit, png, download, json);
  const heading = make('h4', '', 'chart-heading'), scope = make('p', '', 'chart-scope'), status = make('p', '', 'chart-status'); status.setAttribute('role', 'status');
  const viewport = make('div', null, 'chart-viewport'), surface = make('div', null, 'chart-surface'); viewport.append(surface);
  const legend = make('div', null, 'chart-legend'); legend.setAttribute('aria-label', '图例');
  const dimensions = make('p', '', 'chart-dimensions');
  const data = make('details', null, 'chart-data'), summary = make('summary', '查看绘图数据'), dataBody = make('div'); data.append(summary, dataBody);
  container.append(controls, extra, actions, heading, scope, status, viewport, dimensions, legend, data);
  let table, settings, host, model, destroyed = false, lastTheme = '', scopeNote = '', truncated = false, resizing = false, saveSequence = 0;
  const options = (key, entries, value) => { selectors[key].replaceChildren(...entries.map(([id, text]) => { const option = make('option', text); option.value = id; return option; })); selectors[key].value = value; };
  function release() { host?.destroy(); host = null; surface.replaceChildren(); }
  function theme() { const styles = win.getComputedStyle(container), color = name => styles.getPropertyValue(name).trim(); return { foreground: color('--ink') || '#edf2fa', muted: color('--muted') || '#939fb4', grid: color('--line') || '#242e3f', background: color('--surface') || '#111722', palette: chartPalette }; }
  function renderData() {
    dataBody.replaceChildren(); if (!data.open || !model) return;
    const grid = make('table'), head = grid.createTHead().insertRow();
    for (const name of [model.x, '系列 / 指标', model.y]) head.append(make('th', name));
    const body = grid.createTBody(); for (const point of model.points.slice(0, 200)) { const row = body.insertRow(); for (const value of [point.label, point.series, String(point.value)]) row.append(make('td', value)); }
    dataBody.append(grid); if (model.points.length > 200) dataBody.append(make('p', '数据表仅展示前 200 点，图表包含全部 ' + model.points.length + ' 点。'));
  }
  function decorate({ svg, scene }) {
    svg.querySelector('[data-chart-labels]')?.remove(); if (!model || !settings.labels) return;
    const layer = svgNode('g', { 'data-chart-labels': '', 'pointer-events': 'none', 'aria-hidden': 'true' }), seen = new Set();
    const palette = theme();
    for (const point of scene.points) {
      const datum = point.datum; if (!datum?.key || seen.has(datum.key)) continue; seen.add(datum.key);
      let x = point.x, y = point.y - (datum.value >= 0 ? 10 : -18), anchor = 'middle', label = numberLabel(datum.value, settings) + (model.percentage ? '%' : '');
      if (model.type === 'horizontal') { x += datum.value >= 0 ? 8 : -8; y = point.y + 4; anchor = datum.value >= 0 ? 'start' : 'end'; }
      if (model.round) { y = point.y; label = short(datum.label) + ' ' + label + ' (' + numberLabel(datum.value / model.total * 100, { precision: 1 }) + '%)'; }
      const text = svgNode('text', { x: Math.max(12, Math.min(scene.width - 12, x)), y: Math.max(16, Math.min(scene.height - 12, y)), 'text-anchor': anchor, fill: palette.foreground, stroke: palette.background, 'stroke-width': 3, 'paint-order': 'stroke', 'font-size': 12, 'font-weight': 600, 'font-family': 'sans-serif' }, label);
      text.append(svgNode('title', {}, datum.label + ' · ' + datum.series + ': ' + datum.value)); layer.append(text);
    }
    svg.append(layer);
  }
  function renderColors() {
    colors.replaceChildren(); if (!model) return;
    const names = colorNames(model), palette = colorRange(model);
    for (const [i, name] of names.entries()) {
      const label = make('label', null, 'chart-color-item'), color = make('input'); color.type = 'color'; color.value = palette[i]; color.setAttribute('aria-label', '颜色：' + name); color.dataset.chartColor = name;
      color.onchange = () => change({ colorOverrides: { ...settings.colorOverrides, [name]: color.value } }); label.append(color, make('span', short(name))); label.title = name; colors.append(label);
    }
  }
  function draw() {
    if (!table || destroyed) return;
    for (const action of [download, png, json]) action.disabled = true;
    saveSequence++; model = null; legend.replaceChildren(); dataBody.replaceChildren();
    scope.textContent = scopeNote + (truncated ? ' · 数据为截断预览，图表仅反映已加载部分' : ''); scope.dataset.truncated = String(truncated);
    try {
      model = prepareChart(table, settings); const colors = theme(); lastTheme = JSON.stringify(colors);
      surface.style.width = settings.width ? settings.width + 'px' : '100%'; surface.style.height = settings.height + 'px';
      const spec = { definition: chartDefinition(model, colors), height: surface.clientHeight || settings.height, initialWidth: settings.width || 700, ariaLabel: chartTypes.find(([id]) => id === settings.type)[1] + '：' + model.x + '与' + model.y, onRender: decorate };
      if (host) host.update(spec); else host = mountChart(surface, spec);
      surface.dataset.chartType = settings.type; surface.dataset.pointCount = String(model.points.length);
      heading.textContent = settings.title || (model.x + ' · ' + model.y); dimensions.textContent = '维度：' + (settings.xTitle || model.x) + '　指标：' + (settings.yTitle || model.y) + (model.type === 'combo' ? ' · 柱线共用数值轴' : '') + ' · 可拖动图形右下角调整尺寸';
      const names = colorNames(model), palette = colorRange(model); legend.hidden = !settings.legend;
      for (const [i, name] of names.entries()) {
        const item = make('span', null, 'chart-legend-item'), marker = svgNode('svg', { viewBox: '0 0 10 10', 'aria-hidden': 'true' }); marker.append(svgNode('circle', { cx: 5, cy: 5, r: 4, fill: palette[i] }));
        const point = model.round ? model.points.find(p => p.label === name) : null;
        item.append(marker, make('span', name + (point ? '：' + numberLabel(point.value, settings) + '（' + numberLabel(point.value / model.total * 100, { precision: 1 }) + '%）' : ''))); legend.append(item);
      }
      const aggregateName = { none: '逐行绘制', sum: '同分类求和', average: '同分类平均值', count: '同分类计数' }[settings.aggregate];
      status.textContent = '输入 ' + model.inputRows + ' 行 · 绘制 ' + model.points.length + ' 点 · ' + aggregateName + (model.skipped ? ' · ' + model.skipped + ' 个空值未绘制' : '') + (model.round ? ' · 合计 ' + numberLabel(model.total, settings) : ''); status.dataset.error = 'false';
      summary.textContent = '查看绘图数据（' + model.points.length + ' 点）'; for (const action of [download, png, json]) action.disabled = false; renderColors(); renderData();
    } catch (error) { release(); surface.removeAttribute('data-point-count'); status.textContent = error.message || '图表无法绘制，请核对数据。'; status.dataset.error = 'true'; }
  }
  function syncFields() {
    for (const [key, input] of Object.entries(inputs)) if (input.type === 'checkbox') input.checked = !!settings[key]; else input.value = settings[key] ?? '';
    selectors.series.disabled = ['pie', 'donut'].includes(settings.type); selectors.y.disabled = settings.aggregate === 'count';
    metrics.replaceChildren(); const round = ['pie', 'donut'].includes(settings.type);
    for (const column of table.columns) {
      if (column === settings.x || column === settings.y || !table.rows.some(row => chartNumber(chartCell(table, row, column)) !== null)) continue;
      const label = make('label', null, 'chart-checkbox'), input = make('input'); input.type = 'checkbox'; input.checked = settings.ys?.includes(column) || false; input.disabled = round || settings.aggregate === 'count'; input.dataset.chartMetric = column;
      input.onchange = () => change({ ys: [...metrics.querySelectorAll('input:checked')].map(node => node.dataset.chartMetric) }); label.append(input, column); metrics.append(label);
    }
  }
  function updateControls() {
    options('type', chartTypes, settings.type); for (const key of ['x', 'y']) options(key, table.columns.map(column => [column, column]), settings[key]);
    options('series', [['', '不分组'], ...table.columns.map(column => [column, column])], settings.series);
    options('aggregate', [['none', '逐行（不汇总）'], ['sum', '同分类求和'], ['average', '同分类平均值'], ['count', '同分类计数']], settings.aggregate);
    options('order', [['source', '原数据顺序'], ['ascending', '分类升序']], settings.order); syncFields();
  }
  function change(patch) {
    try { settings = { ...settings, ...chartSettings({ ...settings, ...patch }) }; onChange({ ...settings }); syncFields(); draw(); }
    catch (error) { status.textContent = error.message; status.dataset.error = 'true'; syncFields(); }
  }
  for (const [key, select] of Object.entries(selectors)) select.onchange = () => change({ [key]: select.value, ...(key === 'x' || key === 'y' ? { ys: (settings.ys || []).filter(column => column !== select.value) } : {}) });
  for (const [key, input] of Object.entries(inputs)) input.onchange = () => change({ [key]: input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value });
  data.addEventListener('toggle', renderData);
  function addContext(kind) {
    if (!table || !onContext) return;
    try { const accepted = onContext(kind === 'config' ? chartAiConfig(settings) : chartAiData(table, scopeNote, truncated)); if (accepted !== false) { status.textContent = (kind === 'config' ? '配置' : '数据') + '已加入当前对话草稿，确认后发送。'; status.dataset.error = 'false'; } }
    catch (error) { status.textContent = error.message; status.dataset.error = 'true'; }
  }
  function svgExport() {
    const original = surface.querySelector('svg'); if (!original || !model) throw new Error('请先生成有效的图表。');
    const copy = original.cloneNode(true); for (const attribute of [...copy.attributes]) if (attribute.name === 'xmlns') copy.removeAttributeNode(attribute);
    const viewBox = (original.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number), bounds = original.getBoundingClientRect();
    const width = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : bounds.width || 700, height = viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3] : bounds.height || settings.height;
    const colors = theme(), names = settings.legend ? colorNames(model) : [], palette = colorRange(model), columns = Math.max(1, Math.floor(width / 220)), footer = 90 + Math.ceil(names.length / columns) * 24;
    const outer = svgNode('svg', { width, height: height + footer + 40, viewBox: '0 0 ' + width + ' ' + (height + footer + 40), role: 'img', 'aria-label': heading.textContent });
    outer.append(svgNode('rect', { width, height: height + footer + 40, fill: colors.background }), svgNode('title', {}, heading.textContent), svgNode('text', { x: 16, y: 26, fill: colors.foreground, 'font-size': 18, 'font-family': 'sans-serif' }, heading.textContent));
    copy.setAttribute('width', String(width)); copy.setAttribute('height', String(height)); copy.setAttribute('x', '0'); copy.setAttribute('y', '40'); outer.append(copy);
    const label = (text, x, y, fill = colors.muted) => outer.append(svgNode('text', { x, y, fill, 'font-size': 11, 'font-family': 'sans-serif' }, text));
    label(dimensions.textContent.replace(' · 可拖动图形右下角调整尺寸', ''), 16, height + 58);
    label(scopeNote, 16, height + 76); if (truncated) label('注意：截断预览，仅反映已加载部分', 16, height + 94, colors.foreground);
    for (const [i, name] of names.entries()) {
      const x = 16 + i % columns * width / columns, y = height + 116 + Math.floor(i / columns) * 24;
      outer.append(svgNode('circle', { cx: x + 3, cy: y - 3, r: 4, fill: palette[i] })); label(short(name), x + 14, y, colors.foreground);
    }
    return { text: new win.XMLSerializer().serializeToString(outer), width, height: height + footer + 40 };
  }
  function downloadBlob(blob, filename) { const url = win.URL.createObjectURL(blob), link = make('a'); link.href = url; link.download = filename; doc.body.append(link); link.click(); link.remove(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1000); }
  async function save(format) {
    if (!table || !model || destroyed) return;
    try {
      if (format === 'json') return downloadBlob(new win.Blob([JSON.stringify({ version: 1, settings, data: table }, null, 2)], { type: 'application/json' }), 'chart.json');
      const image = svgExport(), blob = new win.Blob([image.text], { type: 'image/svg+xml;charset=utf-8' });
      if (format === 'svg') return downloadBlob(blob, 'chart-' + settings.type + '.svg');
      const token = ++saveSequence, url = win.URL.createObjectURL(blob), bitmap = new win.Image(); png.disabled = true;
      try {
        await new Promise((resolve, reject) => { bitmap.onload = resolve; bitmap.onerror = () => reject(new Error('PNG 生成失败，可先下载 SVG。')); bitmap.src = url; });
        if (destroyed || token !== saveSequence) return;
        const canvas = make('canvas'), scale = 2; canvas.width = Math.ceil(image.width * scale); canvas.height = Math.ceil(image.height * scale);
        const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器无法生成 PNG，请下载 SVG。'); context.scale(scale, scale); context.drawImage(bitmap, 0, 0, image.width, image.height);
        const result = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); if (!result) throw new Error('PNG 保存失败，请下载 SVG。');
        if (!destroyed && token === saveSequence) downloadBlob(result, 'chart-' + settings.type + '.png');
      } finally { win.URL.revokeObjectURL(url); if (!destroyed) png.disabled = !model; }
    } catch (error) { if (!destroyed) { status.textContent = error.message; status.dataset.error = 'true'; } }
  }
  const observer = win.MutationObserver ? new win.MutationObserver(() => { if (table && JSON.stringify(theme()) !== lastTheme) draw(); }) : null;
  observer?.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-appearance'] });
  const module = container.closest('[data-module-theme]'); if (module && module !== doc.documentElement) observer?.observe(module, { attributes: true, attributeFilter: ['data-theme'] });
  const resize = win.ResizeObserver ? new win.ResizeObserver(() => {
    if (!model || destroyed || resizing || !surface.clientHeight) return;
    const height = Math.max(240, Math.min(1200, Math.round(surface.getBoundingClientRect().height)));
    const width = surface.style.width.endsWith('px') ? Math.max(320, Math.min(2400, Math.round(surface.getBoundingClientRect().width))) : 0;
    if (height === settings.height && width === settings.width) return;
    resizing = true; change({ height, width }); resizing = false;
  }) : null; resize?.observe(surface);
  return {
    setData(value, { settings: incoming, note = '', truncated: partial = false } = {}) {
      table = value; scopeNote = note; truncated = partial;
      try { settings = { ...defaultChartSettings(table), ...chartSettings(incoming) }; updateControls(); onChange({ ...settings }); draw(); }
      catch (error) { release(); table = model = null; for (const action of [download, png, json]) action.disabled = true; legend.replaceChildren(); dataBody.replaceChildren(); status.dataset.error = 'true'; status.textContent = error.message; }
    },
    getSettings() { return settings && { ...settings }; },
    destroy() { destroyed = true; saveSequence++; table = model = null; observer?.disconnect(); resize?.disconnect(); release(); container.replaceChildren(); },
  };
}
