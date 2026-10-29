// Local, bounded text processing. JSON numbers stay lexical tokens so IDs and
// decimals never pass through JavaScript's floating-point representation.
export const MAX_TEXT = 2_000_000;
export const MAX_FILE = 8 * 1024 * 1024;
const fail = message => { throw new Error(message); };
export function checkText(text) {
  if (typeof text !== 'string' || text.length > MAX_TEXT) fail('文本最多支持 200 万字符，请缩小范围。');
  return text;
}

export function parseJson(source) {
  checkText(source); let at = 0, nodes = 0;
  const error = message => {
    const before = source.slice(0, at), line = before.split('\n').length, column = at - before.lastIndexOf('\n');
    fail(`${message}（第 ${line} 行，第 ${column} 列）`);
  };
  const space = () => { while (/[\t\n\r ]/.test(source[at] || '\0')) at++; };
  function string() {
    const start = at++;
    while (at < source.length) {
      const char = source[at++];
      if (char === '"') {
        const raw = source.slice(start, at);
        try { return { type: 'string', raw, value: JSON.parse(raw) }; } catch { error('字符串或转义无效'); }
      }
      if (char === '\\') at++;
    }
    error('字符串缺少结束引号');
  }
  function value(depth = 0) {
    if (depth > 128 || ++nodes > 100_000) fail('JSON 超过 128 层或 10 万个节点，请缩小范围。');
    space(); const char = source[at];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      const object = char === '{', close = object ? '}' : ']'; at++; space(); const entries = [];
      if (source[at] === close) { at++; return { type: object ? 'object' : 'array', entries }; }
      while (at < source.length) {
        space(); let key;
        if (object) {
          if (source[at] !== '"') error('对象键需要双引号');
          key = string(); space(); if (source[at++] !== ':') { at--; error('对象键后缺少冒号'); }
        }
        const child = value(depth + 1); entries.push(object ? { key, node: child } : child); space();
        if (source[at] === close) { at++; return { type: object ? 'object' : 'array', entries }; }
        if (source[at++] !== ',') { at--; error('缺少逗号或结束括号'); }
      }
      error('缺少结束括号');
    }
    const match = source.slice(at).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/);
    if (!match) error('需要有效的 JSON 值');
    at += match[0].length; return { type: /^[-\d]/.test(match[0]) ? 'number' : 'literal', raw: match[0] };
  }
  const root = value(); space(); if (at !== source.length) error('JSON 结束后有多余内容'); return root;
}

export function printJson(node, { indent = 2, sort = false } = {}, depth = 0) {
  if (!node.entries) return node.raw;
  const object = node.type === 'object', [open, close] = object ? ['{', '}'] : ['[', ']'];
  if (!node.entries.length) return open + close;
  const entries = object && sort ? [...node.entries].sort((a, b) => a.key.value < b.key.value ? -1 : a.key.value > b.key.value ? 1 : 0) : node.entries;
  const pad = ' '.repeat(indent * (depth + 1)), end = ' '.repeat(indent * depth);
  const text = entries.map(entry => (object ? entry.key.raw + (indent ? ': ' : ':') : '') + printJson(object ? entry.node : entry, { indent, sort }, depth + 1));
  return indent ? `${open}\n${pad}${text.join(',\n' + pad)}\n${end}${close}` : open + text.join(',') + close;
}

export function parseCsv(text, delimiter = ',') {
  checkText(text); text = text.replace(/^\uFEFF/, '');
  if (!text) return [];
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const cell = () => { row.push(field); field = ''; closed = false; if (row.length > 200) fail('最多支持 200 列。'); };
  const line = () => { cell(); rows.push(row); row = []; if (rows.length > 20_001) fail('最多支持 2 万行数据。'); };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quoted) {
      if (char === '"') { if (text[at + 1] === '"') { field += '"'; at++; } else { quoted = false; closed = true; } }
      else field += char;
    } else if (char === delimiter) cell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[at + 1] === '\n') at++; line(); }
    else if (char === '"' && !field && !closed) quoted = true;
    else { if (closed || char === '"') fail('CSV 引号或分隔符无效。'); field += char; }
  }
  if (quoted) fail('CSV 引号未闭合。');
  if (field || row.length || closed || !/[\r\n]$/.test(text)) line();
  return rows;
}
export function parseChartInput(input, format = 'auto') {
  checkText(input); const source = input.trim();
  let rows;
  if (format === 'json' || format === 'auto' && source.startsWith('[')) {
    const root = parseJson(source);
    if (root.type === 'array' && root.entries.every(row => row.type === 'array')) {
      rows = root.entries.map(row => row.entries.map(cell => cell.type === 'string' ? cell.value : cell.raw === 'null' ? '' : cell.raw));
    } else rows = jsonToRows(source);
  } else if (format === 'auto' && source.split(/\r?\n/, 1)[0].includes('|') && /^\s*\|?\s*:?-{3,}/m.test(source)) {
    const lines = source.split(/\r?\n/).filter(line => line.trim());
    const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll('\\|', '|'));
    rows = [cells(lines[0]), ...lines.slice(2).map(cells)];
  } else {
    const first = source.split(/\r?\n/, 1)[0];
    const delimiter = format === 'tsv' || format === 'auto' && first.includes('\t') ? '\t' : format === 'auto' && !first.includes(',') && first.includes(';') ? ';' : ',';
    rows = parseCsv(source, delimiter);
  }
  const columns = (rows[0] || []).map(String), values = rows.slice(1);
  if (!columns.length || columns.length > 200 || columns.some(c => !c.trim()) || new Set(columns).size !== columns.length || values.some(row => row.length > columns.length)) fail('首行需为不重复的表头，数据列数不能超过表头。');
  if (values.length > 20_000 || values.length * columns.length > 200_000) fail('绘图输入最多 2 万行、20 万个单元格。');
  return { columns, rows: values };
}
export function printCsv(rows, safe = false) {
  return rows.map(row => row.map(value => {
    let text = String(value ?? '');
    // Spreadsheet applications may execute CSV text as formulas on open.
    if (safe && (/^[\t\r]/.test(text) || /^[\s]*[=+@-]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text))) text = "'" + text;
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }).join(',')).join('\r\n');
}
export function rowsToJson(rows) {
  if (!rows.length) fail('没有可转换的数据。');
  const headers = rows[0].map(String);
  if (headers.some(key => !key.trim()) || new Set(headers).size !== headers.length) fail('首行表头不能为空或重复，请先修改表头。');
  return '[\n' + rows.slice(1).map(row => {
    if (row.length > headers.length) fail('数据列数超过表头列数。');
    return '  {' + headers.map((key, i) => JSON.stringify(key) + ': ' + JSON.stringify(String(row[i] ?? ''))).join(', ') + '}';
  }).join(',\n') + '\n]';
}
export function jsonToRows(text) {
  const root = parseJson(text); if (root.type !== 'array' || root.entries.some(row => row.type !== 'object')) fail('请输入对象数组，例如 [{"姓名":"小刘","数量":2}]。');
  if (root.entries.length > 20_000) fail('最多支持 2 万行数据。');
  const headers = [], maps = root.entries.map(row => {
    const cells = new Map();
    for (const { key, node } of row.entries) {
      if (cells.has(key.value)) fail('对象存在重复字段，无法转换为表格。');
      cells.set(key.value, node.type === 'string' ? node.value : node.raw === 'null' ? '' : printJson(node, { indent: 0 }));
      if (!headers.includes(key.value)) headers.push(key.value);
      if (headers.length > 200) fail('最多支持 200 列。');
    }
    return cells;
  });
  return [headers, ...maps.map(row => headers.map(key => row.get(key) ?? ''))];
}

function base64(text, decode = false) {
  if (decode) {
    const clean = text.replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) fail('Base64 内容无效。');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(clean), c => c.charCodeAt(0))); }
    catch { fail('Base64 无效，或解码结果不是 UTF-8 文本。'); }
  }
  const bytes = new TextEncoder().encode(text); let binary = '';
  for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(binary);
}
function beijingTime(text, action) {
  let milliseconds;
  if (action === 'date') {
    const parts = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!parts) fail('请输入北京时间 YYYY-MM-DD HH:mm:ss，可带毫秒。');
    const [, y, m, d, h, min, s, ms = '0'] = parts, value = new Date(0);
    value.setUTCFullYear(Number(y), Number(m) - 1, Number(d)); value.setUTCHours(Number(h), Number(min), Number(s), Number(ms.padEnd(3, '0')));
    const expected = `${y}-${m}-${d}T${h}:${min}:${s}`;
    if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 19) !== expected) fail('日期或时间不存在，请检查年月日和时分秒。');
    milliseconds = value.getTime() - 8 * 3600000;
  } else {
    if (!/^-?\d+(?:\.\d+)?$/.test(text.trim())) fail('请输入有效的 Unix 时间戳。');
    milliseconds = Number(text) * (action === 'seconds' ? 1000 : 1);
  }
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8_639_999_971_200_000) fail('时间超出支持范围。');
  const value = new Date(milliseconds), local = new Date(value.getTime() + 8 * 3600000).toISOString().replace('T', ' ').replace('Z', '');
  return `北京时间（UTC+08:00）：${local}\nUnix 秒：${value.getTime() / 1000}\nUnix 毫秒：${value.getTime()}\nUTC：${value.toISOString()}`;
}

async function difference(before, after, vendor) {
  if (before.split('\n').length + after.split('\n').length > 20_000) fail('比较最多支持合计 2 万行，请缩小范围。');
  const { diffLines } = await vendor();
  const diff = diffLines(before, after, { timeout: 1200, maxEditLength: 2000 });
  if (!diff) fail('差异较大，比较已停止，请缩小范围。');
  const text = diff.map(part => part.value.split('\n').map((line, i, all) => i === all.length - 1 && !line ? '' : (part.added ? '+ ' : part.removed ? '- ' : '  ') + line).join('\n') + (part.value.endsWith('\n') ? '' : '\n')).join('');
  return { text: before === after ? '内容一致。' : text, diff, filename: 'compare.diff', insertable: false };
}

export async function runTool({ category, action, input = '', secondary = '', file, indent = 2 }, vendor = () => import('./vendor/toolbox.js')) {
  checkText(input); checkText(secondary);
  let text = '', filename = 'result.txt', extra = {};
  if (category === 'json') {
    if (action === 'escape') text = JSON.stringify(input);
    else {
      const root = parseJson(input);
      if (action === 'unescape') { if (root.type !== 'string') fail('去除转义需要输入 JSON 字符串（包含外层双引号）。'); text = root.value; }
      else if (action === 'compare') {
        const options = { indent: 2, sort: true };
        return difference(printJson(root, options), printJson(parseJson(secondary), options), vendor);
      } else {
        const options = { indent: action === 'minify' ? 0 : indent === 4 ? 4 : 2, sort: action === 'sort' };
        text = printJson(root, options); filename = 'result.json';
        if (action === 'validate') extra.message = 'JSON 校验通过；数字原文与重复键均已保留。';
        if (action === 'tree') extra.tree = root;
      }
    }
  } else if (category === 'encoding') {
    if (action === 'base64-encode' || action === 'base64-decode') text = base64(input, action.endsWith('decode'));
    else if (action === 'url-encode') text = encodeURIComponent(input);
    else if (action === 'url-decode') { try { text = decodeURIComponent(input); } catch { fail('URL 编码无效，请检查百分号转义和 UTF-8。'); } }
    else if (action === 'unicode-encode') text = input.split('').map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    else if (action === 'unicode-decode') {
      if (/\\u(?![a-fA-F0-9]{4}|\{[a-fA-F0-9]{1,6}\})/.test(input)) fail('Unicode 转义无效。');
      text = input.replace(/\\u(?:([a-fA-F0-9]{4})|\{([a-fA-F0-9]{1,6})\})/g, (_, a, b) => {
        const point = parseInt(a || b, 16); if (point > 0x10ffff) fail('Unicode 码点超出范围。'); return String.fromCodePoint(point);
      });
    } else fail('未知的编码操作。');
  } else if (category === 'text') {
    if (action === 'compare') return difference(input, secondary, vendor);
    if (action === 'dedup') text = [...new Set(input.split(/\r\n|\r|\n/))].join('\n');
    else if (action === 'lines-comma') text = input.split(/\r\n|\r|\n/).join(',');
    else if (action === 'comma-lines') text = input.split(',').join('\n');
    else if (action === 'stats') { text = `字符数：${Array.from(input).length}\n非空白字符：${Array.from(input.replace(/\s/g, '')).length}\n行数：${input ? input.split(/\r\n|\r|\n/).length : 0}\nUTF-8 字节：${new TextEncoder().encode(input).length}`; extra.insertable = false; }
    else fail('未知的文本操作。');
  } else if (category === 'time') { text = beijingTime(input, action); extra.insertable = false; }
  else if (category === 'chart') {
    if (!['auto', 'json', 'csv', 'tsv'].includes(action)) fail('请选择有效的数据格式。');
    if (action === 'auto' && input.trim().startsWith('{')) {
      const { readChartSpec } = await import('./vendor/toolbox.js'), spec = readChartSpec(input);
      return { text: '已导入图表配置与数据。', table: spec.table, settings: spec.settings, filename: 'chart.json', insertable: false, message: '已恢复图表，可以继续调整或交给 AI 修改。' };
    }
    const table = parseChartInput(input, action);
    return { text: `已读取 ${table.rows.length} 行、${table.columns.length} 列。`, table, filename: 'chart.txt', insertable: false, message: '已识别数据，可直接绘图或将配置、数据加入 AI 对话。' };
  }
  else if (category === 'data') {
    if (action === 'csv-json') { text = rowsToJson(parseCsv(input)); filename = 'result.json'; extra.message = '首行作为表头；所有字段保留为文本。'; }
    else if (action === 'json-csv' || action === 'json-xlsx') {
      const rows = jsonToRows(input); text = printCsv(rows);
      if (action === 'json-csv') { filename = 'result.csv'; extra.downloadText = '\uFEFF' + printCsv(rows, true); extra.message = 'CSV 下载已对可能的公式文本加前缀；预览保留原值。'; }
      else {
        const xlsx = await vendor(), workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(rows), '数据');
        extra.binary = xlsx.write(workbook, { bookType: 'xlsx', type: 'array' }); filename = 'result.xlsx'; extra.insertable = false;
        extra.message = 'Excel 单元格按文本导出，保留大整数且不生成公式；右侧为 CSV 预览。';
      }
    } else if (action === 'xlsx-json') {
      if (!file || file.byteLength > MAX_FILE) fail('请导入不超过 8 MB 的 Excel 文件。');
      const xlsx = await vendor(), workbook = xlsx.read(file, { type: 'array', cellFormula: false, cellHTML: false, cellText: true, sheetRows: 20_002 });
      if (workbook.SheetNames.length > 50) fail('最多支持 50 个工作表。');
      let cells = 0;
      const sheets = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name], range = xlsx.utils.decode_range(sheet['!ref'] || 'A1');
        if (range.e.r >= 20_001 || range.e.c >= 200 || sheet['!fullref']) fail('Excel 最多支持每表 2 万行数据、200 列，请缩小文件。');
        const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: false });
        cells += rows.reduce((sum, row) => sum + row.length, 0); if (cells > 200_000) fail('工作簿超过 20 万个单元格，请缩小文件。');
        return { name, csv: checkText(printCsv(rows)) };
      });
      return { sheets, text: '', filename: 'result.json', insertable: false, message: '已读取本机 Excel。选择工作表后点击转换；使用已有值，不计算公式。' };
    } else fail('未知的数据转换。');
  } else fail('未知工具。');
  if (text.length > MAX_TEXT * 4) fail('结果超过 800 万字符，请缩小输入。');
  return { text, filename, ...extra };
}
