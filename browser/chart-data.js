export const chartTypes = [['line', '折线图'], ['bar', '柱形图'], ['horizontal', '横向条形图'], ['area', '面积图'], ['stacked', '堆叠柱形图'], ['combo', '柱线组合图'], ['scatter', '散点图'], ['pie', '饼图'], ['donut', '环形图']];
const numberPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const empty = value => value == null || typeof value === 'string' && !value.trim();
export function chartNumber(value) {
  if (empty(value) || !['number', 'string'].includes(typeof value)) return null;
  const raw = String(value).trim().replace(/%$/, '');
  const text = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw) ? raw.replaceAll(',', '') : raw;
  if (!numberPattern.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : null;
}
export function validateChartTable(table) {
  const { columns, rows } = table || {};
  if (!Array.isArray(columns) || !columns.length || columns.length > 200 || columns.some(c => typeof c !== 'string' || !c.trim()) || new Set(columns).size !== columns.length) throw new Error('数据需有 1—200 个不重复的列名。');
  if (!Array.isArray(rows) || rows.length > 20_000 || rows.length * columns.length > 200_000) throw new Error('绘图输入最多 2 万行、20 万个单元格，请先筛选或汇总。');
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) && row.length > columns.length)) throw new Error('数据行格式不正确。');
  return table;
}
export const chartCell = (table, row, column) => Array.isArray(row) ? row[table.columns.indexOf(column)] : Object.hasOwn(row, column) ? row[column] : null;
export function defaultChartSettings(table) {
  validateChartTable(table);
  const numeric = table.columns.filter(column => {
    const values = table.rows.map(row => chartCell(table, row, column)).filter(value => !empty(value));
    return values.length && values.every(value => chartNumber(value) !== null);
  });
  const y = numeric.find(column => column !== table.columns[0]) || numeric[0] || table.columns[1] || table.columns[0];
  return { type: 'line', x: table.columns.find(column => column !== y) || table.columns[0], y, series: '', aggregate: 'none', order: 'source', labels: true, legend: true, height: 360, width: 0, title: '', xTitle: '', yTitle: '', smooth: false, precision: 2, colors: [], colorOverrides: {} };
}
export function prepareChart(table, settings) {
  validateChartTable(table);
  const { type, x, y, aggregate = 'none', order = 'source' } = settings;
  const round = ['pie', 'donut'].includes(type), series = round ? '' : settings.series || '';
  if (!chartTypes.some(([id]) => id === type) || !table.columns.includes(x) || !table.columns.includes(y) || series && !table.columns.includes(series)) throw new Error('请选择有效的图表类型和数据列。');
  if (!['none', 'sum', 'average', 'count'].includes(aggregate)) throw new Error('请选择有效的汇总方式。');
  if (series === x || series === y) throw new Error('分组列应与分类列、数值列不同。');
  const metrics = round || aggregate === 'count' ? [y] : [...new Set([y, ...(settings.ys || [])])];
  if (metrics.length > 12 || metrics.some(column => !table.columns.includes(column))) throw new Error('最多选择 12 个有效指标。');
  const groups = new Map(), categories = new Set(), seriesNames = new Set();
  let skipped = 0, percentage = false, plain = false;
  for (const [rowIndex, row] of table.rows.entries()) for (const metric of metrics) {
    const category = chartCell(table, row, x), value = chartCell(table, row, metric), group = series ? String(chartCell(table, row, series) ?? '') + (metrics.length > 1 ? ' · ' + metric : '') : metric;
    if (empty(category) || empty(series ? chartCell(table, row, series) : group) || aggregate !== 'count' && empty(value)) { skipped++; continue; }
    const label = String(category), name = String(group);
    if (label.length > 2000 || name.length > 2000) throw new Error('分类或分组名称过长，请缩短后绘图。');
    const number = aggregate === 'count' ? 1 : chartNumber(value);
    if (number === null) throw new Error(`「${y}」含非数值、非有限数或超出安全范围的大数，请更换指标或选择计数。`);
    if (aggregate !== 'count') { if (typeof value === 'string' && value.trim().endsWith('%')) percentage = true; else plain = true; }
    if (percentage && plain) throw new Error('数值列混用了百分比与普通数值，请统一单位后绘图。');
    if (round && number < 0) throw new Error('饼图和环形图不支持负数，请使用折线图或柱形图。');
    const nx = type === 'scatter' ? chartNumber(category) : null;
    if (type === 'scatter' && nx === null) throw new Error('散点图横轴需为数值，请选择数值列。');
    const key = JSON.stringify([label, name, type === 'scatter' && aggregate === 'none' ? rowIndex : null]), item = groups.get(key);
    if (item && aggregate === 'none') throw new Error('同一分类与分组有多行，请明确选择求和、平均值或计数。');
    if (item) { item.value += number; item.count++; if (!Number.isFinite(item.value) || Math.abs(item.value) > Number.MAX_SAFE_INTEGER) throw new Error('汇总数值超出安全范围，请缩小范围。'); }
    else groups.set(key, { key, label, series: name, metric, nx, value: number, count: 1 });
    categories.add(label); seriesNames.add(name);
    if (groups.size > 2000 || categories.size > (round ? 30 : 500) || seriesNames.size > 12) throw new Error(round ? '饼图和环形图最多 30 个分类，请先汇总。' : '最多绘制 2,000 个点、500 个分类和 12 个分组，请先筛选或汇总。');
  }
  const points = [...groups.values()].map(item => ({ ...item, value: aggregate === 'average' ? item.value / item.count : item.value }));
  if (!points.length) throw new Error('没有可绘制的数据，请检查筛选条件、空值和数据列。');
  if (order === 'ascending') points.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }));
  if (type === 'combo' && seriesNames.size < 2) throw new Error('柱线组合图需至少两个指标或分组，请在更多指标中勾选。');
  const stacks = new Map();
  for (const point of points) {
    const key = point.label + (point.value >= 0 ? '\u0000positive' : '\u0000negative'), start = stacks.get(key) || 0;
    point.start = type === 'stacked' ? start : 0; point.end = point.start + point.value; if (!Number.isFinite(point.end) || Math.abs(point.end) > Number.MAX_SAFE_INTEGER) throw new Error('堆叠数值超出安全范围，请缩小范围。'); stacks.set(key, point.end);
  }
  const total = points.reduce((sum, point) => sum + point.value, 0);
  if (!Number.isFinite(total) || Math.abs(total) > Number.MAX_SAFE_INTEGER) throw new Error('数据总量超出安全范围，请缩小范围。');
  if (round && total <= 0) throw new Error('饼图和环形图需要至少一个正数。');
  return { points, categories: [...new Set(points.map(point => point.label))], series: [...seriesNames], skipped, total, round, percentage, x, y: aggregate === 'count' ? '行数' : y + (percentage ? '（%）' : ''), type, aggregate, inputRows: table.rows.length, settings, metrics };
}
