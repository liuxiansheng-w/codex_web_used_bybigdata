import { parseJson, parseChartInput } from '../public/toolbox-core.js';
import { chartTypes, defaultChartSettings, validateChartTable, prepareChart } from './chart-data.js';

const hex = /^#[0-9a-f]{6}$/i;
const bounded = (value, min, max, fallback) => value == null ? fallback : Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : (() => { throw new Error('图表尺寸或数字精度超出范围。'); })();
export function chartSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图表配置应为对象。');
  const result = {};
  for (const key of ['type', 'x', 'y', 'series', 'aggregate', 'order', 'title', 'xTitle', 'yTitle']) {
    if (value[key] != null) { if (typeof value[key] !== 'string' || value[key].length > 200) throw new Error('图表配置文字最多 200 字。'); result[key] = value[key]; }
  }
  for (const key of ['labels', 'legend', 'smooth', 'categoryColors']) if (value[key] != null) { if (typeof value[key] !== 'boolean') throw new Error('图表开关应为布尔值。'); result[key] = value[key]; }
  for (const [key, min, max, fallback] of [['height', 240, 1200, 360], ['width', 0, 2400, 0], ['precision', 0, 8, 2]]) result[key] = bounded(value[key], min, max, fallback);
  if (result.width && result.width < 320) throw new Error('图表宽度至少 320 像素，0 表示适应面板。');
  if (!Number.isInteger(result.precision)) throw new Error('数字精度应为整数。');
  if (value.ys != null) { if (!Array.isArray(value.ys) || value.ys.length > 12 || value.ys.some(c => typeof c !== 'string' || c.length > 200)) throw new Error('更多指标格式无效。'); result.ys = [...new Set(value.ys)]; }
  if (value.colors != null) { if (!Array.isArray(value.colors) || value.colors.length > 30 || value.colors.some(c => typeof c !== 'string' || !hex.test(c))) throw new Error('配色需为最多 30 个 #RRGGBB 颜色。'); result.colors = [...value.colors]; }
  if (value.colorOverrides != null) {
    const pairs = Object.entries(value.colorOverrides);
    if (typeof value.colorOverrides !== 'object' || Array.isArray(value.colorOverrides) || pairs.length > 500 || pairs.some(([name, color]) => name.length > 2000 || typeof color !== 'string' || !hex.test(color))) throw new Error('自定义颜色格式无效。');
    result.colorOverrides = Object.fromEntries(pairs);
  }
  if (result.type && !chartTypes.some(([id]) => id === result.type)) throw new Error('暂不支持此图表类型。');
  return result;
}
function lexicalJson(source) {
  const materialize = node => node.type === 'object' ? Object.fromEntries(node.entries.map(({ key, node: child }) => [key.value, materialize(child)])) : node.type === 'array' ? node.entries.map(materialize) : node.type === 'string' ? node.value : node.raw === 'true' ? true : node.raw === 'false' ? false : node.raw === 'null' ? null : node.raw;
  return materialize(parseJson(source));
}
export function readChartSpec(source) {
  if (typeof source !== 'string' || source.length > 1_000_000) throw new Error('AI 图表内容最多 100 万字符。');
  const spec = lexicalJson(source);
  if (!spec || Number(spec.version) !== 1 || !spec.data) throw new Error('需要 version: 1、settings 和 data 的图表 JSON。');
  const table = Array.isArray(spec.data) ? parseChartInput(JSON.stringify(spec.data), 'json') : validateChartTable(spec.data);
  const settings = { ...defaultChartSettings(table), ...chartSettings(spec.settings) };
  prepareChart(table, settings);
  return { table, settings };
}
export function chartAiConfig(settings = {}) {
  const fence = String.fromCharCode(96).repeat(3);
  return '请根据我的数据和绘图要求生成图表。直接返回可渲染的 ' + fence + 'chart JSON 代码块（可以有多张），不要生成 HTML、JavaScript 或远程链接。仅使用我提供的数据，不编造数值；数据不足或口径不明确时先问我。\n' +
    '格式：{"version":1,"settings":{"type":"line","x":"维度列","y":"指标列","ys":["其他指标列"],"title":"标题","xTitle":"维度名称","yTitle":"数值单位","labels":true,"legend":true,"height":360,"width":0,"colors":["#60a5fa","#a78bfa"]},"data":{"columns":["维度列","指标列"],"rows":[["分类",123]]}}。示例仅说明结构，必须替换为实际数据。\n' +
    '可选类型：' + chartTypes.map(([id, name]) => id + '（' + name + '）').join('、') + '。width=0 自适应，或 320—2400；height=240—1200。labels 显示数值；ys 添加指标；series 指定分组列；aggregate=none/sum/average/count（汇总前说明口径）；order=source/ascending；smooth 控制平滑线；precision=0—8；categoryColors 按分类着色；colorOverrides 可按分类/系列名指定 #RRGGBB。柱线组合图首个系列为柱，其余为线，共用同一数值轴，请统一单位；散点图横轴需为数值。饼图/环形图显示分类、数值和占比。\n\n当前图表配置：\n' + JSON.stringify(chartSettings(settings), null, 2);
}
export function chartAiData(table, note = '', truncated = false) {
  validateChartTable(table);
  return '以下为用于绘图的数据（' + table.rows.length + ' 行）。范围：' + note + (truncated ? '；注意：仅为截断预览，不能代表完整数据' : '') + '。请结合图表配置和我的要求处理。\n' + JSON.stringify({ columns: table.columns, rows: table.rows });
}
