import { extractParams, substituteParams, createParameterMemory, sqlStatementKind, BUSINESS_DATE_PARAMETER, yesterdayBusinessDate, calendarDate, addBusinessDatePicker } from './sql-parameters.js';
import { createQueryHistory } from './query-history.js';
import { createResultsLayout } from './editor-window.js';

const $ = id => document.getElementById(id);
const resultKind = result => result?.sqlType || sqlStatementKind(result?.executedSql || result?.sql);
const isExecution = result => !['', 'SELECT', 'WITH', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'].includes(resultKind(result));
const resultStatus = result => result.loading ? (isExecution(result) ? '执行中' : '查询中') : result.ok ? (isExecution(result) ? '执行成功' : `${result.rowCount} 行`) : '未完成';
export function sqlFileFromRunnerLink(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '5177' || url.pathname !== '/' || url.username || url.password) return null;
    const path = new URLSearchParams(url.hash.slice(1)).get('path') || url.searchParams.get('path');
    return path?.startsWith('/') && /\.sql$/i.test(path) ? path : null;
  } catch { return null; }
}
export const cellText = value => value == null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
// Calculate from the displayed decimal values, without binary floating-point
// addition. Keep SQL DECIMAL strings and large integer strings exact.
export function selectionStatistics(values) {
  let count = 0, numericCount = 0, nonEmptyCount = 0, scale = 0, sum = 0n, min = null, max = null, unavailable = false;
  for (const value of values) {
    count++;
    if (value != null && String(value).trim() !== '') nonEmptyCount++;
    if (!['number', 'string'].includes(typeof value)) continue;
    const text = String(value).trim(), match = /^([+-]?)(\d*\.?\d+|\d+\.)(?:e([+-]?\d+))?$/i.exec(text);
    if (!match) continue;
    numericCount++;
    const exponent = Number(match[3] || 0);
    // Do not show partial aggregates if an unusually large value cannot be
    // processed safely in the browser. This never limits the query or its data.
    if (text.length > 2000 || Math.abs(exponent) > 1000) { unavailable = true; continue; }
    const fraction = match[2].split('.')[1]?.length || 0, power = exponent - fraction;
    let coefficient = BigInt(match[1] + match[2].replace('.', '')), places = Math.max(0, -power);
    if (power > 0) coefficient *= 10n ** BigInt(power);
    if (places > scale) {
      const multiplier = 10n ** BigInt(places - scale); sum *= multiplier;
      if (min != null) { min *= multiplier; max *= multiplier; }
      scale = places;
    } else coefficient *= 10n ** BigInt(scale - places);
    sum += coefficient; min = min == null || coefficient < min ? coefficient : min; max = max == null || coefficient > max ? coefficient : max;
  }
  const format = (value, places) => {
    const negative = value < 0n, digits = (negative ? -value : value).toString().padStart(places + 1, '0');
    const text = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}`.replace(/\.?0+$/, '') : digits;
    return `${negative ? '-' : ''}${text}`;
  };
  if (!numericCount || unavailable) return { count, nonEmptyCount, numericCount, unavailable, sum: null, average: null, min: null, max: null, approximate: false };
  const averageScale = Math.max(scale, 12), numerator = sum * 10n ** BigInt(averageScale - scale), denominator = BigInt(numericCount);
  const remainder = numerator % denominator;
  let average = numerator / denominator;
  if ((remainder < 0n ? -remainder : remainder) * 2n >= denominator) average += numerator < 0n ? -1n : 1n;
  return { count, nonEmptyCount, numericCount, unavailable, sum: format(sum, scale), average: format(average, averageScale), min: format(min, scale), max: format(max, scale), approximate: remainder !== 0n };
}
export function resultText(columns, rows, csv = false, includeHeader = true) {
  const value = item => {
    let text = item == null ? '' : cellText(item);
    // Preserve values as text when pasted/opened in a spreadsheet.
    if (/^[\s]*[=+@-]/.test(text) && typeof item !== 'number') text = `'${text}`;
    return csv ? `"${text.replaceAll('"', '""')}"` : text.replace(/[\t\r\n]+/g, ' ');
  };
  return [...(includeHeader ? [columns] : []), ...rows.map(row => columns.map((column, index) => Array.isArray(row) ? row[index] : row?.[column]))].map(row => row.map(value).join(csv ? ',' : '\t')).join(csv ? '\r\n' : '\n');
}
export const resultValue = (result, row, column) => Array.isArray(row) ? row[result.columns.indexOf(column)] : row?.[column];
export const columnValueKey = value => value == null ? 'null:' : `${typeof value}:${cellText(value)}`;
export function matchesColumn(value, { op, value: expected = '', values = [] }) {
  if (op === 'in') return values.includes(columnValueKey(value));
  if (op === 'empty') return value == null || value === '';
  if (op === 'notempty') return value != null && value !== '';
  if (value == null) return false;
  const actual = cellText(value).toLocaleLowerCase(), query = expected.toLocaleLowerCase();
  if (op === 'contains') return actual.includes(query);
  if (op === 'notcontains') return !actual.includes(query);
  if (op === 'equals') return actual === query;
  if (op === 'notequals') return actual !== query;
  const x = Number(value), y = Number(expected);
  if (String(value).trim() === '' || expected.trim() === '' || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  return { gt: x > y, gte: x >= y, lt: x < y, lte: x <= y }[op] || false;
}
export function filterRows(result, filter = '', sort = null, columnFilters = []) {
  const value = (row, column) => resultValue(result, row, column);
  const query = filter.trim().toLocaleLowerCase();
  const predicates = columnFilters.map(rule => {
    if (rule.op !== 'in') return row => matchesColumn(value(row, rule.column), rule);
    const selected = new Set(rule.values);
    return row => selected.has(columnValueKey(value(row, rule.column)));
  });
  const rows = result.rows.filter(row => (!query || result.columns.some(column => cellText(value(row, column)).toLocaleLowerCase().includes(query))) && predicates.every(matches => matches(row)));
  if (sort) rows.sort((a, b) => {
    const x = value(a, sort.column), y = value(b, sort.column);
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
    const numeric = value => typeof value === 'number' || typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value);
    return (numeric(x) && numeric(y) ? Number(x) - Number(y) : cellText(x).localeCompare(cellText(y), 'zh-CN', { numeric: true })) * sort.direction;
  });
  return rows;
}

// Count across every loaded page, respecting other columns while keeping this
// column's complete value universe available for expanding an existing filter.
export function columnOptions(result, column, filter = '', filters = []) {
  const options = new Map();
  for (const row of result.rows) {
    const value = resultValue(result, row, column), key = columnValueKey(value);
    if (!options.has(key)) options.set(key, { key, value, label: value == null ? '(空值 NULL)' : value === '' ? '(空字符串)' : cellText(value), count: 0 });
  }
  for (const row of filterRows(result, filter, null, filters.filter(rule => rule.column !== column))) options.get(columnValueKey(resultValue(result, row, column))).count++;
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }));
}

export function createSqlQuery({ editor, api, onContext, notice, bottomPanel }) {
  const states = new Map(), projects = new Map();
  let activeId = null, running = null, checked = false, available = null, pending = null, sequence = 0;
  let storage; try { storage = window.localStorage; } catch { /* Private browsing may disable storage. */ }
  const parameters = createParameterMemory(storage), historyStore = createQueryHistory(storage), archived = []; let persistTimer;
  const projectKey = () => editor.current?.cwd || editor.cwd || '';
  function projectFor(cwd = projectKey()) {
    if (!projects.has(cwd)) projects.set(cwd, { tabs: [], active: null, collapsed: false, expanded: false });
    return projects.get(cwd);
  }
  $('sqlTools').innerHTML = `<select id="sqlEngine" aria-label="查询引擎"><option value="huawei">华为 DLI</option><option value="aliyun">阿里 DataWorks</option></select><button id="sqlRun" class="primary-button" type="button" title="⌘ / Ctrl + Enter">查询</button><button id="sqlShowResults" class="text-button" type="button" hidden>结果</button><button id="sqlHistory" class="text-button" type="button">历史</button><button id="sqlConnection" class="sql-connection" type="button" aria-label="检查查询服务连接">●</button><span id="sqlScope" class="sr-only"></span>`;
  $('sqlResults').innerHTML = `<header id="sqlResultHandle" class="sql-result-header"><strong>查询结果</strong><span id="sqlSummary" role="status"></span><button id="sqlLayoutToggle" class="text-button" type="button">独立浮窗</button><button id="sqlWindowReset" class="icon-button" type="button" aria-label="重置结果窗口" title="重置窗口位置和大小" hidden>↺</button><button id="sqlWindowMaximize" class="icon-button" type="button" aria-label="最大化结果窗口" hidden>□</button><button id="sqlExpand" class="text-button" type="button" aria-expanded="false">展开</button><button id="sqlCollapse" class="icon-button" type="button" aria-label="收起查询结果">×</button></header><div id="sqlResultTabs" class="sql-result-tabs" role="tablist" aria-label="查询结果标签"></div><p id="sqlResultNote" class="sql-result-note"></p><div id="sqlResultActions" class="sql-result-actions"><input id="sqlFilter" type="search" placeholder="搜索所有列…" aria-label="筛选查询结果"><button id="sqlCopy" class="text-button" type="button">复制表格</button><button id="sqlCopyHeaders" class="text-button" type="button">复制表头</button><button id="sqlExportAll" class="text-button" type="button">下载全部</button><button id="sqlExport" class="text-button" type="button" hidden>下载筛选</button><button id="sqlRename" class="text-button" type="button">命名</button><button id="sqlRepeat" class="text-button" type="button">再次查询…</button><button id="sqlContext" class="text-button" type="button">加入对话</button><a id="sqlDownload" target="_blank" rel="noopener noreferrer" hidden>云端完整文件</a></div><div id="sqlFilterChips" class="sql-filter-chips" hidden></div><p id="sqlFeedback" role="status" class="sql-result-note"></p><div id="sqlResultBody" role="tabpanel" class="sql-result-body" tabindex="0" aria-label="查询数据表"></div><footer id="sqlPagination" class="sql-pagination"><label><select id="sqlPageSize" aria-label="每页行数"><option value="50">50 行 / 页</option><option value="100">100 行 / 页</option><option value="200">200 行 / 页</option></select></label><button id="sqlPrev" class="text-button" type="button">上一页</button><span id="sqlPage"></span><button id="sqlNext" class="text-button" type="button">下一页</button><div id="sqlSelectionStats" class="sql-selection-stats" role="status" aria-live="polite" aria-atomic="true" hidden></div></footer><details id="sqlSnapshot" class="sql-snapshot"><summary>本次查询 SQL</summary><pre id="sqlExecuted"></pre></details><span class="editor-resize sql-result-resize" data-edge="n" aria-hidden="true"></span><span class="editor-resize sql-result-resize" data-edge="s" aria-hidden="true"></span><span class="editor-resize sql-result-resize" data-edge="e" aria-hidden="true"></span><span class="editor-resize sql-result-resize" data-edge="w" aria-hidden="true"></span><span class="editor-resize sql-result-resize" data-edge="ne" aria-hidden="true"></span><span class="editor-resize sql-result-resize" data-edge="nw" aria-hidden="true"></span><span class="editor-resize sql-result-resize" data-edge="se" aria-hidden="true"></span><span class="editor-resize sql-result-resize" data-edge="sw" aria-hidden="true"></span>`;
  const selection = createResultSelection({ body: $('sqlResultBody'), stats: $('sqlSelectionStats'), copyText });
  const columnMenu = document.createElement('section'); columnMenu.id = 'sqlColumnMenu'; columnMenu.className = 'sql-column-menu'; columnMenu.hidden = true;
  columnMenu.setAttribute('role', 'dialog'); columnMenu.setAttribute('aria-labelledby', 'sqlColumnName');
  columnMenu.innerHTML = `<header><strong id="sqlColumnName"></strong><button id="sqlColumnClose" class="icon-button" type="button" aria-label="关闭列操作">×</button></header>
    <div class="sql-column-sorts"><button id="sqlSortAsc" type="button">升序 ↑</button><button id="sqlSortDesc" type="button">降序 ↓</button><button id="sqlSortReset" type="button">原顺序</button></div>
    <form id="sqlValuesForm" class="sql-values-form">
      <input id="sqlValueSearch" type="search" placeholder="搜索此列的值…" aria-label="搜索此列的值" autocomplete="off">
      <div class="sql-value-tools"><button id="sqlValuesAll" type="button">全选</button><button id="sqlValuesNone" type="button">清空</button><button id="sqlValuesInvert" type="button">反选</button><span id="sqlValueSelection" role="status"></span></div>
      <div id="sqlValueList" class="sql-value-list" role="group" aria-label="勾选列值"></div>
      <p id="sqlValueHint" class="sql-value-hint"></p>
      <div class="sql-value-actions"><button type="submit" class="primary-button">确认</button><button id="sqlValuesCancel" type="button">取消</button><button id="sqlColumnClear" type="button">清除此列筛选</button></div>
    </form>
    <details id="sqlConditionDetails" class="sql-column-details"><summary>按条件筛选</summary><form id="sqlColumnForm"><label>筛选方式<select id="sqlColumnOperator"><option value="contains">包含</option><option value="notcontains">不包含</option><option value="equals">等于</option><option value="notequals">不等于</option><option value="gt">大于（数值）</option><option value="gte">大于等于（数值）</option><option value="lt">小于（数值）</option><option value="lte">小于等于（数值）</option><option value="empty">为空</option><option value="notempty">不为空</option></select></label><input id="sqlColumnValue" aria-label="列筛选值" placeholder="输入筛选值"><button type="submit" class="primary-button">应用条件</button></form></details>
    <details id="sqlCopyDetails" class="sql-column-details"><summary>复制此列…</summary><div class="sql-column-copy"><button id="sqlColumnCopy" type="button">复制此列数据</button><button id="sqlColumnWithHeader" type="button">复制此列（含表头）</button><button id="sqlColumnTitle" type="button">复制列名</button></div><p>复制当前筛选后的所有页；双击单元格可复制原值。</p></details>`;
  document.body.append(columnMenu);
  let columnContext = null;
  const layout = createResultsLayout({
    dock: bottomPanel,
    container: $('fileEditor'), pane: $('sqlResults'), divider: $('sqlResultsDivider'),
    handle: $('sqlResultHandle'), modeButton: $('sqlLayoutToggle'), maximize: $('sqlWindowMaximize'),
    reset: $('sqlWindowReset'), expand: $('sqlExpand'), resizeHandles: [...$('sqlResults').querySelectorAll('.sql-result-resize')],
    onChange: () => closeColumnMenu(),
  });
  const syncLayout = state => layout.sync({ visible: (bottomPanel || editor.visible && !editor.current?.preview && document.getElementById('workSurface')?.dataset.mode !== 'chat') && !!state?.result && !projectFor().collapsed, expanded: projectFor().expanded });
  bottomPanel?.subscribe(() => { if (bottomPanel.visible('results') && projectFor().collapsed) { projectFor().collapsed = false; sync(); } });
  const dialog = document.createElement('dialog'); dialog.id = 'sqlParamsDialog'; dialog.className = 'sql-params-dialog';
  let datePickers = [];
  const closeDatePickers = () => datePickers.forEach(picker => picker.close());
  dialog.setAttribute('aria-labelledby', 'sqlParamsTitle');
  dialog.innerHTML = `<form id="sqlParamsForm"><h2 id="sqlParamsTitle">填写查询参数</h2><div id="sqlParamsFields"></div><details><summary>查看待执行 SQL</summary><pre id="sqlParamSql"></pre></details><div class="sql-param-actions"><button id="sqlParamsClear" type="button" class="text-button">清除已记住的值</button><button id="sqlParamsCancel" type="button" class="text-button">取消</button><button class="primary-button" type="submit">查询</button></div></form>`;
  document.body.append(dialog);
  for (const tab of historyStore.read().reverse()) { const project = projectFor(tab.result.cwd); project.tabs.push(tab); project.active = tab.id; sequence = Math.max(sequence, tab.id); }
  const historyDialog = document.createElement('dialog'); historyDialog.id = 'sqlHistoryDialog'; historyDialog.className = 'query-history-dialog'; historyDialog.setAttribute('aria-labelledby', 'queryHistoryTitle');
  historyDialog.innerHTML = '<div class="dialog-heading"><h2 id="queryHistoryTitle">查询历史</h2><button type="button" id="sqlHistoryClose" class="icon-button" aria-label="关闭查询历史">×</button></div><label class="query-cache-option"><input id="sqlKeepResults" type="checkbox">在本机保留查询和结果预览</label><p class="field-hint">开启后可在刷新后恢复。仅此浏览器保存，最多 20 次查询、每次前 1,000 行，总计约 4 MB；完整数据请下载保存。</p><p id="sqlCacheStatus" role="status"></p><div id="sqlHistoryList"></div>';
  document.body.append(historyDialog);
  const reviewDialog = document.createElement('dialog'); reviewDialog.id = 'sqlReviewDialog'; reviewDialog.className = 'query-review-dialog'; reviewDialog.innerHTML = '<form id="sqlReviewForm"><h2>核对后再次查询</h2><p id="sqlReviewTarget"></p><label>查询内容<textarea id="sqlReviewText" rows="12" required aria-label="待重新查询的 SQL"></textarea></label><p class="field-hint">这是上次执行的 SQL 快照，不会修改编辑器里的文件。</p><div class="dialog-actions"><button type="button" id="sqlReviewCancel">取消</button><button class="primary-button" type="submit">继续查询</button></div></form>'; document.body.append(reviewDialog); let repeatSnapshot = null;
  const renameDialog = document.createElement('dialog'); renameDialog.innerHTML = '<form id="sqlRenameForm"><h2>结果名称</h2><input id="sqlResultName" aria-label="结果名称" maxlength="60" required><div class="dialog-actions"><button type="button" id="sqlRenameCancel">取消</button><button type="submit" class="primary-button">保存名称</button></div></form>'; document.body.append(renameDialog); let renameTarget = null;
  function queuePersist() { clearTimeout(persistTimer); persistTimer = setTimeout(() => { try { historyStore.write(allHistory()); } catch (error) { $('sqlCacheStatus').textContent = error.message; notice(error.message); } }, 300); }
  function allHistory() { return [...new Map([...archived, ...[...projects.values()].flatMap(project => project.tabs)].map(tab => [tab.id, tab])).values()]; }
  function showHistory() {
    const list = $('sqlHistoryList'); list.replaceChildren(); $('sqlKeepResults').checked = historyStore.enabled();
    const tabs = allHistory().filter(tab => tab.result.cwd === projectKey()).sort((a, b) => b.result.startedAt - a.result.startedAt);
    if (!tabs.length) { const empty = document.createElement('p'); empty.textContent = '这个项目还没有查询记录。'; list.append(empty); }
    for (const tab of tabs) {
      const row = document.createElement('div'); row.className = 'query-history-row'; const label = document.createElement('strong'); label.textContent = tab.name || tab.result.path.split('/').at(-1); const meta = document.createElement('small'); meta.textContent = `${new Date(tab.result.startedAt).toLocaleString('zh-CN')} · ${engineName(tab.result.engine)} · ${resultStatus(tab.result)}`;
      const open = document.createElement('button'); open.textContent = '查看结果'; open.onclick = () => { const project = projectFor(); if (!project.tabs.includes(tab)) { if (project.tabs.length >= 20) return notice('请先关闭一个结果标签。'); project.tabs.push(tab); } project.active = tab.id; project.collapsed = false; historyDialog.close(); bottomPanel?.show('results'); sync(); render(); };
      const again = document.createElement('button'); again.textContent = isExecution(tab.result) ? '再次执行…' : '再次查询…'; again.disabled = !!running || tab.result.loading; again.onclick = () => { historyDialog.close(); reviewQuery(tab.result); }; row.append(label, meta, open, again); list.append(row);
    }
    historyDialog.showModal();
  }
  function reviewQuery(result) { if (running || pending) return notice('请等待当前执行完成。'); repeatSnapshot = { ...result, parameters: result.parameters || {} }; $('sqlReviewTarget').textContent = `${result.path} · ${engineName(result.engine)}`; $('sqlReviewText').value = result.sql; reviewDialog.querySelector('h2').textContent = isExecution(result) ? '核对后再次执行' : '核对后再次查询'; reviewDialog.querySelector('[type=submit]').textContent = isExecution(result) ? '继续执行' : '继续查询'; reviewDialog.showModal(); }
  $('sqlHistory').onclick = showHistory; $('sqlHistoryClose').onclick = () => historyDialog.close();
  $('sqlKeepResults').onchange = () => { try { historyStore.setEnabled($('sqlKeepResults').checked); queuePersist(); $('sqlCacheStatus').textContent = historyStore.enabled() ? '已开启，结果预览将保存在本机。' : '已关闭并清除本机记录；当前页面的结果仍保留。'; } catch (error) { $('sqlCacheStatus').textContent = error.message; } };
  $('sqlRepeat').onclick = () => { if (current()) reviewQuery(current().result); }; $('sqlReviewCancel').onclick = () => { repeatSnapshot = null; reviewDialog.close(); };
  $('sqlReviewForm').onsubmit = event => { event.preventDefault(); const snapshot = repeatSnapshot; if (!snapshot) return; snapshot.sql = $('sqlReviewText').value; repeatSnapshot = null; reviewDialog.close(); requestParameters(snapshot); };
  function renameResult(tab) { renameTarget = tab; $('sqlResultName').value = tab.name || `结果 ${tab.id}`; renameDialog.showModal(); }
  $('sqlRename').onclick = () => { if (current()) renameResult(current()); }; $('sqlRenameCancel').onclick = () => renameDialog.close(); $('sqlRenameForm').onsubmit = event => { event.preventDefault(); if (renameTarget) renameTarget.name = $('sqlResultName').value.trim().slice(0, 60); renameDialog.close(); render(); };
  const elapsedTimer = window.setInterval(() => { const result = current()?.result; if (result?.loading) $('sqlSummary').textContent = `${resultStatus(result)} · 已用 ${Math.floor((Date.now() - result.startedAt) / 1000)} 秒`; }, 1000);
  window.addEventListener('pagehide', () => { window.clearInterval(elapsedTimer); clearTimeout(persistTimer); try { historyStore.write(allHistory()); } catch {} });
  const current = () => { const project = projectFor(); return project.tabs.find(tab => tab.id === project.active); };
  const engineName = engine => engine === 'aliyun' ? '阿里云' : '华为云';
  const filteredRows = state => filterRows(state.result, state.filter, state.sort, state.filters);
  const hasFilters = state => !!state.filter.trim() || !!state.filters.length;
  function closeColumnMenu(restoreFocus = false) {
    const trigger = columnContext?.trigger; columnContext = null; columnMenu.hidden = true;
    trigger?.setAttribute('aria-expanded', 'false'); if (restoreFocus) trigger?.focus();
  }
  function openColumnMenu(column, trigger) {
    closeColumnMenu(); const state = current();
    const rule = state.filters.find(item => item.column === column);
    const options = columnOptions(state.result, column, state.filter, state.filters);
    const selected = new Set(rule?.op === 'in' ? rule.values : options.filter(option => !rule || matchesColumn(option.value, rule)).map(option => option.key));
    columnContext = { id: state.id, column, result: state.result, trigger, options, selected, limit: 200 };
    $('sqlColumnName').textContent = column;
    $('sqlValueSearch').value = ''; $('sqlConditionDetails').open = false; $('sqlCopyDetails').open = false;
    $('sqlColumnOperator').value = rule && rule.op !== 'in' ? rule.op : 'contains'; $('sqlColumnValue').value = rule?.value || '';
    $('sqlColumnValue').disabled = ['empty', 'notempty'].includes($('sqlColumnOperator').value);
    renderValueList();
    columnMenu.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    positionColumnMenu(); $('sqlValueSearch').focus();
  }
  function positionColumnMenu() {
    const trigger = columnContext?.trigger; if (!trigger || columnMenu.hidden) return;
    const rect = trigger.getBoundingClientRect(), menu = columnMenu.getBoundingClientRect();
    columnMenu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.width - 8))}px`;
    columnMenu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.height - 8))}px`;
  }
  function searchedOptions() {
    const search = $('sqlValueSearch').value.trim().toLocaleLowerCase();
    return columnContext.options.filter(option => option.label.toLocaleLowerCase().includes(search));
  }
  function renderValueSelection() {
    const options = searchedOptions(), { selected } = columnContext;
    $('sqlValueSelection').textContent = `已选 ${options.filter(option => selected.has(option.key)).length} / ${options.length} 项`;
  }
  function renderValueList() {
    const { selected, limit, result } = columnContext, options = searchedOptions(), list = $('sqlValueList');
    const scrollTop = list.scrollTop; list.replaceChildren();
    for (const option of options.slice(0, limit)) {
      const label = document.createElement('label'); label.className = 'sql-value-option'; label.classList.toggle('is-unavailable', !option.count);
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(option.key);
      input.setAttribute('aria-label', option.label); input.dataset.valueKey = option.key;
      input.addEventListener('change', () => { if (input.checked) selected.add(option.key); else selected.delete(option.key); renderValueSelection(); });
      const text = document.createElement('span'); text.textContent = option.label; text.title = `${option.label} · ${typeof option.value}`;
      const count = document.createElement('small'); count.textContent = `(${option.count})`; count.setAttribute('aria-label', `${option.count} 行`);
      label.append(input, text, count); list.append(label);
    }
    if (!options.length) { const empty = document.createElement('p'); empty.textContent = '没有匹配的值'; list.append(empty); }
    if (options.length > limit) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'sql-values-more'; more.textContent = `显示更多（还有 ${options.length - limit} 项）`;
      more.addEventListener('click', () => { columnContext.limit += 200; renderValueList(); }); list.append(more);
    }
    list.scrollTop = scrollTop; renderValueSelection();
    const searching = !!$('sqlValueSearch').value.trim();
    for (const id of ['sqlValuesAll', 'sqlValuesNone', 'sqlValuesInvert']) $(id).disabled = !options.length;
    $('sqlValueHint').textContent = `${searching ? `匹配 ${options.length} 项；确认后仅保留搜索匹配的勾选项。` : '全选 / 清空 / 反选作用于全部值，确认后生效。'}${result.truncated ? ' 数量仅统计已加载的结果预览。' : ' 数量包含所有页，并受其他筛选影响。'}`;
  }
  function menuState() {
    const state = current();
    return state && columnContext?.id === state.id && columnContext.result === state.result ? state : null;
  }
  async function copyText(text, message) {
    const state = current();
    try { await navigator.clipboard.writeText(text); if (current() === state) $('sqlFeedback').textContent = message; }
    catch { if (current() === state) $('sqlFeedback').textContent = '无法访问剪贴板，请使用下载或手动选择复制。'; }
  }
  function downloadCsv(state, rows, filtered) {
    const url = URL.createObjectURL(new Blob(['\uFEFF', resultText(state.result.columns, rows, true)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${state.result.path.split('/').at(-1).replace(/\.[^.]+$/, '')}-${filtered ? '筛选结果' : '全部结果'}.csv`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('sqlFeedback').textContent = `已下载${filtered ? '筛选后的' : '全部'} ${rows.length} 行（含所有页）。`;
  }
  function renderFilters(state) {
    const chips = $('sqlFilterChips'); chips.replaceChildren();
    const labels = { contains: '包含', notcontains: '不包含', equals: '=', notequals: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', empty: '为空', notempty: '不为空' };
    for (const rule of state.filters) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = rule.op === 'in' ? `${rule.column} 已选 ${rule.values.length} 项 ×` : `${rule.column} ${labels[rule.op]} ${rule.value || ''} ×`;
      button.title = `移除 ${rule.column} 的筛选`;
      button.addEventListener('click', () => { state.filters = state.filters.filter(item => item !== rule); state.page = 0; render(); }); chips.append(button);
    }
    if (state.sort) { const button = document.createElement('button'); button.type = 'button'; button.textContent = `${state.sort.column} ${state.sort.direction === 1 ? '升序' : '降序'} ×`; button.title = '恢复原始顺序'; button.addEventListener('click', () => { state.sort = null; state.page = 0; render(); }); chips.append(button); }
    if (hasFilters(state)) { const button = document.createElement('button'); button.type = 'button'; button.textContent = '清空筛选'; button.addEventListener('click', () => { state.filters = []; state.filter = ''; state.page = 0; render(); }); chips.append(button); }
    chips.hidden = !chips.childElementCount;
  }
  function stateFor(file) {
    if (!states.has(file.id)) states.set(file.id, { engine: 'huawei' });
    return states.get(file.id);
  }
  async function checkConnection() {
    checked = true; $('sqlConnection').dataset.state = 'checking';
    try { available = (await api('/api/sql/status')).available; } catch { available = false; }
    $('sqlConnection').dataset.state = available ? 'online' : 'offline';
    $('sqlConnection').setAttribute('aria-label', available ? '查询服务已连接，点击重新检查' : '查询服务未连接，点击重试');
    $('sqlConnection').title = available ? '使用本机 DGC SQL runner；点击重新检查连接' : '请启动本机 DGC SQL runner（默认端口 5177），然后点击重试';
  }
  function renderTabs() {
    const project = projectFor(), list = $('sqlResultTabs'); list.replaceChildren();
    for (const tab of project.tabs) {
      const wrapper = document.createElement('div'); wrapper.className = 'sql-result-tab';
      wrapper.classList.toggle('is-active', tab.id === project.active);
      const button = document.createElement('button'); button.type = 'button'; button.id = `sql-result-tab-${tab.id}`;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'sqlResultBody');
      button.setAttribute('aria-selected', String(tab.id === project.active)); button.tabIndex = tab.id === project.active ? 0 : -1;
      const status = ` · ${tab.result.loading || tab.result.ok ? resultStatus(tab.result) : '失败'}`;
      button.textContent = `${tab.name || `结果 ${tab.id} · ${tab.result.path.split('/').at(-1)}`} · ${new Date(tab.result.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}${status}`;
      button.addEventListener('dblclick', () => renameResult(tab));
      button.title = `${tab.result.path} · ${engineName(tab.result.engine)} · ${new Date(tab.result.startedAt).toLocaleTimeString('zh-CN')}`;
      button.addEventListener('click', () => { project.active = tab.id; closeColumnMenu(); sync(); render(); });
      button.addEventListener('keydown', event => {
        const index = project.tabs.indexOf(tab), last = project.tabs.length - 1;
        const next = { ArrowRight: (index + 1) % project.tabs.length, ArrowLeft: (index + last) % project.tabs.length, Home: 0, End: last }[event.key];
        if (next != null) { event.preventDefault(); project.active = project.tabs[next].id; closeColumnMenu(); sync(); render(); document.getElementById(`sql-result-tab-${project.active}`)?.focus(); }
        else if (event.key === 'Delete' && !tab.result.loading) { event.preventDefault(); closeTab(); }
      });
      const close = document.createElement('button'); close.type = 'button'; close.className = 'sql-result-tab-close'; close.textContent = '×';
      close.setAttribute('aria-label', `关闭结果 ${tab.id}`); close.title = tab.result.loading ? '查询完成后可关闭' : '关闭此结果'; close.disabled = !!tab.result.loading;
      function closeTab() {
        if (tab.result.loading) return;
        const index = project.tabs.indexOf(tab); project.tabs.splice(index, 1); archived.push(tab); if (archived.length > 20) archived.shift(); queuePersist();
        if (project.active === tab.id) project.active = project.tabs[Math.min(index, project.tabs.length - 1)]?.id ?? null;
        closeColumnMenu(); sync(); render(); document.getElementById(`sql-result-tab-${project.active}`)?.focus();
      }
      close.addEventListener('click', closeTab); wrapper.append(button, close); list.append(wrapper);
    }
    const active = current();
    if (active) {
      $('sqlResultBody').setAttribute('aria-labelledby', `sql-result-tab-${active.id}`);
      document.getElementById(`sql-result-tab-${active.id}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }
  function sync() {
    const file = editor.current, isSql = file?.language === 'sql';
    const tabs = new Set(editor.tabs.map(tab => tab.id));
    for (const id of states.keys()) if (!tabs.has(id) && running?.id !== id) states.delete(id);
    const state = current(), project = projectFor();
    $('sqlTools').hidden = !isSql && !state;
    $('sqlRun').hidden = $('sqlEngine').hidden = $('sqlConnection').hidden = !isSql;
    if (isSql) {
      const selected = file.content.slice(file.start, file.end).trim();
      const verb = isExecution({ sql: selected || file.content }) ? '执行' : '查询';
      $('sqlRun').disabled = !!running || !!pending || editor.locked || editor.tabs.find(tab => tab.id === file.id)?.loading || !file.content.trim();
      $('sqlRun').textContent = running?.id === file.id ? `${isExecution(running) ? '执行' : '查询'}中…` : `${verb}${selected ? '选区' : '全文'}`;
      $('sqlScope').textContent = running && running.id !== file.id ? '其他文件正在查询' : selected ? '执行选中的 SQL' : '执行当前编辑内容 · ⌘ / Ctrl + Enter';
      $('sqlEngine').disabled = !!running || !!pending; $('sqlEngine').value = stateFor(file).engine;
      if (!checked) void checkConnection();
    }
    $('sqlShowResults').hidden = !(state && project.collapsed);
    syncLayout(state);
    if (activeId !== state?.id) { closeColumnMenu(); activeId = state?.id; render(); }
    else renderNote();
  }
  function renderNote() {
    const file = editor.current, result = current()?.result;
    if (!result) return;
    $('sqlResultNote').textContent = `${result.path} · ${engineName(result.engine)} · ${new Date(result.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}${result.cwd === file?.cwd && result.path === file?.path && result.sourceContent !== file.content ? ' · 编辑内容已变化，结果对应查询时的版本' : ''}${result.restored ? ' · 本机恢复的预览' : ''}${result.truncated ? ` · 返回 ${result.rowCount} 行，仅展示和导出前 ${result.rows.length} 行` : ''}`;
    $('sqlResultNote').title = $('sqlResultNote').textContent;
  }
  function render() {
    const state = current(), result = state?.result;
    selection.unmount();
    syncLayout(state); renderTabs();
    if (!result) return;
    queuePersist();
    $('sqlFeedback').textContent = '';
    $('sqlFilter').value = state.filter;
    $('sqlPageSize').value = String(state.pageSize);
    renderFilters(state);
    $('sqlExecuted').textContent = result.executedSql || result.sql;
    renderNote();
    const body = $('sqlResultBody'); body.replaceChildren();
    $('sqlResultActions').hidden = result.loading;
    $('sqlPagination').hidden = !result.ok || !result.rows.length;
    $('sqlCopy').disabled = $('sqlExport').disabled = !result.ok || !result.rows.length;
    $('sqlCopyHeaders').disabled = !result.ok || !result.columns.length;
    $('sqlExportAll').disabled = !result.ok || (!result.rows.length && !result.downloadUrl) || result.truncated && !result.downloadUrl;
    $('sqlExportAll').title = result.downloadUrl ? '下载云端完整结果文件' : result.truncated ? '当前是截断预览，请重新查询获取完整结果' : `下载全部 ${result.rowCount || 0} 行，不受筛选和分页影响`;
    $('sqlExport').hidden = !hasFilters(state);
    $('sqlFilter').disabled = !result.ok || !result.rows.length;
    $('sqlContext').disabled = !!result.loading; $('sqlRepeat').disabled = !!running || !!pending; $('sqlRename').disabled = !!result.loading;
    $('sqlRepeat').textContent = isExecution(result) ? '再次执行…' : '再次查询…';
    $('sqlSnapshot').querySelector('summary').textContent = isExecution(result) ? '本次执行 SQL' : '本次查询 SQL';
    $('sqlDownload').hidden = !result.downloadUrl; $('sqlDownload').href = result.downloadUrl || '#';
    if (result.loading || !result.ok) {
      $('sqlSummary').textContent = result.loading ? (isExecution(result) ? '正在执行…' : '正在查询…') : (isExecution(result) ? '执行失败' : '未获取结果');
      const message = document.createElement('p'); message.className = result.loading ? 'sql-empty' : 'sql-error';
      message.textContent = result.loading ? 'SQL 在后台运行，可继续编辑或切换文件。当前服务没有提供中止接口，收起结果不会停止执行。' : result.error;
      if (!result.loading) message.setAttribute('role', 'alert'); body.append(message); return;
    }
    const rows = filteredRows(state), pageCount = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.page = Math.min(state.page, pageCount - 1);
    $('sqlSummary').textContent = `${isExecution(result) ? '执行成功' : `${rows.length}${hasFilters(state) ? ` / ${result.rows.length}` : ''} 行`} · ${(result.durationMs / 1000).toFixed(1)} 秒`;
    $('sqlPage').textContent = `${state.page + 1} / ${pageCount} 页`;
    $('sqlPrev').disabled = state.page === 0; $('sqlNext').disabled = state.page + 1 >= pageCount;
    let empty;
    if (!rows.length) { empty = document.createElement('p'); empty.className = 'sql-empty'; empty.textContent = isExecution(result) ? `${resultKind(result)} 执行成功，没有返回数据表格。` : hasFilters(state) ? '没有匹配的结果，调整或清空筛选后重试。' : result.downloadUrl ? '结果已生成，请点击「下载全部」。' : result.truncated ? '本机仅保留了查询记录，没有保存数据行；可核对后再次查询。' : '查询完成，没有返回数据。'; if (!result.rows.length) { body.append(empty); return; } }
    const table = document.createElement('table'), head = table.createTHead().insertRow(); table.className = 'sql-table';
    table.tabIndex = 0; table.setAttribute('role', 'grid'); table.setAttribute('aria-multiselectable', 'true'); table.setAttribute('aria-label', '查询结果，拖动选择单元格查看统计；Shift 扩选，Ctrl 或 Command 加 C 复制选区');
    const number = document.createElement('th'); number.textContent = '#'; number.scope = 'col'; head.append(number);
    for (const column of result.columns) {
      const th = document.createElement('th'), button = document.createElement('button'); th.scope = 'col'; button.type = 'button';
      th.setAttribute('aria-sort', state.sort?.column === column ? state.sort.direction === 1 ? 'ascending' : 'descending' : 'none');
      button.textContent = column + (state.sort?.column === column ? state.sort.direction === 1 ? ' ↑' : ' ↓' : '');
      button.title = `按 ${column} 排序：升序 / 降序 / 原顺序`; button.className = 'sql-column-sort';
      button.addEventListener('click', () => { closeColumnMenu(); state.sort = state.sort?.column === column && state.sort.direction === -1 ? null : { column, direction: state.sort?.column === column ? -state.sort.direction : 1 }; state.page = 0; render(); });
      const menu = document.createElement('button'); menu.type = 'button'; menu.className = 'sql-column-trigger'; menu.textContent = state.filters.some(rule => rule.column === column) ? '● ▾' : '▾';
      menu.setAttribute('aria-label', `${column} 列操作：筛选、排序、复制`); menu.setAttribute('aria-haspopup', 'dialog'); menu.setAttribute('aria-expanded', 'false'); menu.title = '筛选、排序、复制此列';
      menu.addEventListener('click', () => openColumnMenu(column, menu));
      th.append(button, menu); head.append(th);
    }
    const tbody = table.createTBody();
    const pageRows = rows.slice(state.page * state.pageSize, (state.page + 1) * state.pageSize);
    for (const [index, row] of pageRows.entries()) {
      const tr = tbody.insertRow(), number = tr.insertCell(), copyRow = document.createElement('button'); copyRow.type = 'button'; copyRow.textContent = String(state.page * state.pageSize + index + 1); copyRow.title = '复制此行'; copyRow.setAttribute('aria-label', `复制第 ${copyRow.textContent} 行`); copyRow.addEventListener('click', () => copyText(resultText(result.columns, [row], false, false), '已复制此行。')); number.append(copyRow);
      result.columns.forEach((column, i) => { const cell = tr.insertCell(), value = Array.isArray(row) ? row[i] : row?.[column]; cell.dataset.resultRow = String(index); cell.dataset.resultColumn = String(i); cell.id = `sql-cell-${state.id}-${index}-${i}`; cell.setAttribute('role', 'gridcell'); cell.textContent = cellText(value); cell.title = `${cell.textContent}\n拖动框选 · Shift 点击扩选 · 双击复制单元格`; cell.addEventListener('dblclick', () => copyText(value == null ? '' : cellText(value), '已复制单元格原值。')); if (value == null) cell.className = 'sql-null'; });
    }
    body.append(table); if (empty) body.append(empty); selection.mount(state, pageRows);
  }
  async function execute(snapshot, params = {}) {
    if (running) return;
    const project = projectFor(snapshot.cwd);
    if (project.tabs.length >= 20) { notice('已保留 20 个查询结果，请先关闭不需要的结果 Tab。'); return; }
    parameters.save(snapshot, params);
    running = snapshot;
    const state = { id: ++sequence, filter: '', filters: [], sort: null, page: 0, pageSize: 50,
      result: { cwd: snapshot.cwd, path: snapshot.path, sql: snapshot.sql, engine: snapshot.engine, parameters: params, sourceContent: snapshot.content ?? snapshot.sourceContent, startedAt: Date.now(), loading: true, rows: [], columns: [] } };
    project.tabs.push(state); project.active = state.id; project.collapsed = false; bottomPanel?.show('results');
    closeColumnMenu(); sync(); render();
    try {
      const result = await api('/api/sql/query', { sql: snapshot.sql, params, engine: snapshot.engine });
      state.result = { ...state.result, ...result, loading: false };
    } catch (error) { state.result = { ...state.result, loading: false, ok: false, error: error.message, executedSql: substituteParams(snapshot.sql, params) }; }
    finally { running = null; queuePersist(); sync(); if (projectKey() === snapshot.cwd) render(); }
  }
  function start() {
    const file = editor.current; if (!file || file.language !== 'sql' || running || pending || editor.locked) return;
    const sql = file.content.slice(file.start, file.end).trim() || file.content.trim(); if (!sql) return;
    requestParameters({ ...file, sql, engine: stateFor(file).engine });
  }
  function requestParameters(snapshot) {
    if (running || pending) return;
    const sql = snapshot.sql, names = extractParams(sql);
    if (!names.length) { void execute(snapshot); return; }
    if (projectFor(snapshot.cwd).tabs.length >= 20) { notice('已保留 20 个查询结果，请先关闭不需要的结果 Tab。'); return; }
    pending = snapshot;
    $('sqlParamsTitle').textContent = isExecution(snapshot) ? '填写执行参数' : '填写查询参数';
    $('sqlParamsForm').querySelector('[type=submit]').textContent = isExecution(snapshot) ? '执行' : '查询';
    $('sqlParamSql').textContent = sql;
    closeDatePickers(); datePickers = []; $('sqlParamsFields').replaceChildren();
    for (const name of names) {
      const label = document.createElement('label'), span = document.createElement('span'), input = document.createElement('input');
      const businessDate = name === BUSINESS_DATE_PARAMETER;
      span.textContent = name; input.name = name; input.autocomplete = 'off'; input.maxLength = 10000;
      input.value = snapshot.parameters?.[name] ?? (businessDate ? yesterdayBusinessDate() : parameters.get(snapshot, name));
      const picker = businessDate ? addBusinessDatePicker(input) : null;
      if (picker) datePickers.push(picker);
      label.append(span, picker ? picker.element : input); $('sqlParamsFields').append(label);
    }
    sync(); dialog.showModal(); $('sqlParamsFields').querySelector('input')?.focus();
  }
  $('sqlParamsForm').addEventListener('submit', event => {
    event.preventDefault(); if (!pending) return;
    const snapshot = pending; pending = null;
    const params = Object.fromEntries([...$('sqlParamsFields').querySelectorAll('input[name]')].map(input => [input.name, input.name === BUSINESS_DATE_PARAMETER ? calendarDate(input.value)?.replaceAll('-', '') || input.value : input.value]));
    closeDatePickers(); dialog.close(); void execute(snapshot, params); sync();
  });
  $('sqlParamsCancel').addEventListener('click', () => { pending = null; closeDatePickers(); dialog.close(); sync(); });
  dialog.addEventListener('cancel', () => { pending = null; closeDatePickers(); sync(); });
  $('sqlParamsClear').addEventListener('click', () => {
    if (!pending) return;
    const inputs = [...$('sqlParamsFields').querySelectorAll('input[name]')];
    parameters.clear(pending, inputs.map(input => input.name));
    for (const input of inputs) { input.value = ''; input.dispatchEvent(new dialog.ownerDocument.defaultView.Event('input', { bubbles: true })); }
    inputs[0]?.focus();
  });
  $('sqlRun').addEventListener('click', start);
  $('sqlEngine').addEventListener('change', () => { const file = editor.current; if (file) stateFor(file).engine = $('sqlEngine').value; });
  $('sqlConnection').addEventListener('click', checkConnection);
  $('sqlFilter').addEventListener('input', () => { const state = current(); state.filter = $('sqlFilter').value; state.page = 0; render(); });
  $('sqlPrev').addEventListener('click', () => { current().page--; render(); });
  $('sqlNext').addEventListener('click', () => { current().page++; render(); });
  $('sqlCollapse').addEventListener('click', () => { closeColumnMenu(); if (bottomPanel && layout.mode === 'docked') { bottomPanel.close(); return; } projectFor().collapsed = true; sync(); $('sqlShowResults').focus(); });
  $('sqlShowResults').addEventListener('click', () => { projectFor().collapsed = false; bottomPanel?.show('results'); sync(); render(); });
  $('sqlExpand').addEventListener('click', () => { projectFor().expanded = !projectFor().expanded; closeColumnMenu(); sync(); });
  $('sqlCopy').addEventListener('click', () => {
    const state = current(); if (!state?.result?.ok) return;
    void copyText(resultText(state.result.columns, filteredRows(state)), '已复制当前筛选后的表格，包含表头及所有页。');
  });
  $('sqlCopyHeaders').addEventListener('click', () => {
    const state = current(); if (state?.result?.ok) void copyText(resultText(state.result.columns, []), '已复制全部表头。');
  });
  $('sqlExport').addEventListener('click', () => {
    const state = current(); if (state?.result?.ok) downloadCsv(state, filteredRows(state), true);
  });
  $('sqlExportAll').addEventListener('click', () => {
    const state = current(); if (!state?.result?.ok) return;
    if (state.result.downloadUrl) { $('sqlDownload').click(); return; }
    if (!state.result.truncated) downloadCsv(state, state.result.rows, false);
  });
  $('sqlPageSize').addEventListener('change', () => { const state = current(); if (!state) return; state.pageSize = Number($('sqlPageSize').value); state.page = 0; render(); });
  $('sqlColumnClose').addEventListener('click', () => closeColumnMenu(true));
  $('sqlValuesCancel').addEventListener('click', () => closeColumnMenu(true));
  $('sqlValueSearch').addEventListener('input', () => { if (!menuState()) return closeColumnMenu(); columnContext.limit = 200; $('sqlValueList').scrollTop = 0; renderValueList(); });
  for (const id of ['sqlValuesAll', 'sqlValuesNone', 'sqlValuesInvert']) $(id).addEventListener('click', () => {
    if (!menuState()) return closeColumnMenu();
    const selected = columnContext.selected;
    for (const { key } of searchedOptions()) {
      if (id === 'sqlValuesNone' || id === 'sqlValuesInvert' && selected.has(key)) selected.delete(key); else selected.add(key);
    }
    renderValueList();
  });
  $('sqlValuesForm').addEventListener('submit', event => {
    event.preventDefault(); const state = menuState(); if (!state) return closeColumnMenu();
    const { column, options } = columnContext;
    const selected = $('sqlValueSearch').value.trim() ? new Set(searchedOptions().filter(option => columnContext.selected.has(option.key)).map(option => option.key)) : columnContext.selected;
    state.filters = state.filters.filter(rule => rule.column !== column);
    // An empty selection is an explicit zero-row filter. A complete selection
    // clears this column only when the loaded data is not a truncated preview.
    if (state.result.truncated || !options.every(option => selected.has(option.key))) state.filters.push({ column, op: 'in', values: [...selected] });
    state.page = 0; closeColumnMenu(); render();
  });
  for (const id of ['sqlConditionDetails', 'sqlCopyDetails']) $(id).addEventListener('toggle', positionColumnMenu);
  for (const [id, direction] of [['sqlSortAsc', 1], ['sqlSortDesc', -1], ['sqlSortReset', 0]]) $(id).addEventListener('click', () => {
    const state = menuState(); if (!state) return closeColumnMenu();
    state.sort = direction ? { column: columnContext.column, direction } : null; state.page = 0; closeColumnMenu(); render();
  });
  $('sqlColumnOperator').addEventListener('change', () => { $('sqlColumnValue').disabled = ['empty', 'notempty'].includes($('sqlColumnOperator').value); });
  $('sqlColumnForm').addEventListener('submit', event => {
    event.preventDefault(); const state = menuState(); if (!state) return closeColumnMenu();
    const column = columnContext.column, op = $('sqlColumnOperator').value, value = $('sqlColumnValue').value;
    state.filters = state.filters.filter(rule => rule.column !== column);
    if (value !== '' || ['empty', 'notempty', 'equals', 'notequals'].includes(op)) state.filters.push({ column, op, value });
    state.page = 0; closeColumnMenu(); render();
  });
  $('sqlColumnClear').addEventListener('click', () => {
    const state = menuState(); if (!state) return closeColumnMenu();
    state.filters = state.filters.filter(rule => rule.column !== columnContext.column); state.page = 0; closeColumnMenu(); render();
  });
  for (const id of ['sqlColumnCopy', 'sqlColumnWithHeader', 'sqlColumnTitle']) $(id).addEventListener('click', () => {
    const state = menuState(); if (!state) return closeColumnMenu();
    const column = columnContext.column, rows = filteredRows(state).map(row => [resultValue(state.result, row, column)]);
    const text = id === 'sqlColumnTitle' ? column : resultText([column], rows, false, id === 'sqlColumnWithHeader');
    void copyText(text, id === 'sqlColumnTitle' ? `已复制列名：${column}` : `已复制 ${column} 列的 ${rows.length} 行（全部筛选页）。`); closeColumnMenu(true);
  });
  document.addEventListener('pointerdown', event => { if (!columnMenu.hidden && !columnMenu.contains(event.target) && !columnContext?.trigger.contains(event.target)) closeColumnMenu(); });
  document.addEventListener('keydown', event => { if (!columnMenu.hidden && event.key === 'Escape') { event.preventDefault(); closeColumnMenu(true); } });
  window.addEventListener('resize', () => closeColumnMenu());
  $('sqlContext').addEventListener('click', () => {
    const state = current(), result = state?.result; if (!result || result.loading) return;
    const rows = result.ok ? filteredRows(state) : [];
    onContext(`请帮我${result.ok ? '分析以下查询结果' : '排查以下查询错误'}：\n文件：${result.cwd}/${result.path}\n引擎：${engineName(result.engine)}\n查询时间：${new Date(result.startedAt).toLocaleString('zh-CN')}\nSQL（查询时快照${(result.executedSql || result.sql).length > 8000 ? '，截取前 8000 字符' : ''}）：\n${(result.executedSql || result.sql).slice(0, 8000)}\n\n${result.ok ? `返回 ${result.rowCount} 行${result.truncated ? `，本页保留前 ${result.rows.length} 行` : ''}；当前筛选 ${rows.length} 行，以下仅取前 20 行、最多 12000 字符：\n${resultText(result.columns, rows.slice(0, 20)).slice(0, 12000)}` : result.error.slice(0, 4000)}`);
    notice('查询内容已加入输入框，可补充问题后发送。');
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && event.target.matches?.('.editor-input') && editor.visible && !dialog.open && !event.isComposing) { event.preventDefault(); event.stopPropagation(); start(); }
  });
  window.addEventListener('beforeunload', event => { if (running) { event.preventDefault(); event.returnValue = ''; } });
  sync(); return { sync };
}

export function createResultSelection({ body, stats, copyText }) {
  const doc = body.ownerDocument, win = doc.defaultView, memory = new WeakMap();
  let view = null, drag = null;
  const requestFrame = callback => win.requestAnimationFrame ? win.requestAnimationFrame(callback) : win.setTimeout(callback, 16);
  const cancelFrame = frame => win.cancelAnimationFrame ? win.cancelAnimationFrame(frame) : win.clearTimeout(frame);
  const point = cell => ({ row: Number(cell.dataset.resultRow), column: Number(cell.dataset.resultColumn) });
  const cellAt = position => view?.table.querySelector(`[data-result-row="${position.row}"][data-result-column="${position.column}"]`);
  const bounds = range => ({ top: Math.min(range.anchor.row, range.focus.row), bottom: Math.max(range.anchor.row, range.focus.row), left: Math.min(range.anchor.column, range.focus.column), right: Math.max(range.anchor.column, range.focus.column) });
  function values(range) {
    const { top, bottom, left, right } = bounds(range), columns = view.state.result.columns;
    return view.rows.slice(top, bottom + 1).map(row => columns.slice(left, right + 1).map((column, offset) => Array.isArray(row) ? row[left + offset] : row?.[column]));
  }
  function selectionText() {
    const { left, right } = bounds(view.saved.range);
    return resultText(view.state.result.columns.slice(left, right + 1), values(view.saved.range), false, false);
  }
  function paint() {
    const range = view?.saved.range, area = range && bounds(range);
    if (view) for (const cell of view.cells) {
      const { row, column } = point(cell), selected = !!area && row >= area.top && row <= area.bottom && column >= area.left && column <= area.right;
      cell.setAttribute('aria-selected', String(selected)); cell.classList.toggle('is-selected', selected);
      for (const edge of ['top', 'bottom', 'left', 'right']) cell.classList.toggle(`selection-${edge}`, selected && (edge === 'top' || edge === 'bottom' ? row : column) === area[edge]);
      cell.classList.toggle('selection-focus', !!range && row === range.focus.row && column === range.focus.column);
    }
    stats.replaceChildren(); stats.hidden = !range; stats.parentElement.classList.toggle('has-selection', !!range);
    if (!range) { view?.table.removeAttribute('aria-activedescendant'); return; }
    view.table.setAttribute('aria-activedescendant', cellAt(range.focus).id);
    const result = selectionStatistics(values(range).flat());
    stats.title = `本页选中 ${result.count} 个单元格，非空 ${result.nonEmptyCount} 个，数值 ${result.numericCount} 个。空值、空白、文本和布尔值不参与数值计算。${view.state.result.truncated ? '当前数据为截断预览。' : ''}`;
    const entries = [['计数', String(result.count)], ['数值', String(result.numericCount)]];
    if (result.numericCount && !result.unavailable) entries.push(['求和', result.sum], ['平均值', `${result.approximate ? '≈' : ''}${result.average}`], ['最大值', result.max], ['最小值', result.min]);
    for (const [label, value] of entries) {
      const item = doc.createElement('span'), number = doc.createElement('b');
      item.className = 'sql-selection-stat'; number.textContent = value; item.append(`${label} `, number);
      item.title = `${label}：${value}${label === '平均值' && result.approximate ? '（四舍五入；至少保留 12 位小数精度）' : ''}`; stats.append(item);
    }
    if (result.unavailable) { const message = doc.createElement('span'); message.textContent = '数值过长，无法统计'; stats.append(message); }
  }
  function update(focus, extend = false) {
    if (!view?.rows.length) return;
    const previous = view.saved.range, anchor = extend && previous ? previous.anchor : focus;
    if (previous && previous.anchor.row === anchor.row && previous.anchor.column === anchor.column && previous.focus.row === focus.row && previous.focus.column === focus.column) return;
    view.saved.range = { anchor: { ...anchor }, focus: { ...focus } }; paint();
  }
  function stopDrag() {
    if (!drag) return;
    const previous = drag; drag = null; previous.listeners.abort(); cancelFrame(previous.frame);
    try { previous.capture.releasePointerCapture?.(previous.id); } catch { /* Capture may already be released. */ }
  }
  function hit(x, y) {
    if (!view) return null;
    const rect = body.getBoundingClientRect(), header = view.table.tHead.getBoundingClientRect();
    const element = doc.elementFromPoint?.(Math.max(rect.left + 2, Math.min(x, rect.right - 14)), Math.max(header.bottom + 2, Math.min(y, rect.bottom - 14)));
    const cell = element?.closest('[data-result-row]'); return cell && body.contains(cell) ? cell : null;
  }
  function scrollDrag() {
    if (!drag?.moved || !view) return;
    const rect = body.getBoundingClientRect(), header = view.table.tHead.getBoundingClientRect();
    const speed = (value, start, end) => value < start + 24 ? -Math.min(24, Math.max(2, (start + 24 - value) / 2)) : value > end - 24 ? Math.min(24, Math.max(2, (value - end + 24) / 2)) : 0;
    const x = speed(drag.x, rect.left, rect.right), y = speed(drag.y, header.bottom, rect.bottom);
    if (x || y) {
      body.scrollLeft += x; body.scrollTop += y;
      const cell = hit(drag.x, drag.y); if (cell) update(point(cell), true);
    }
    drag.frame = requestFrame(scrollDrag);
  }
  body.addEventListener('pointerdown', event => {
    const cell = event.target.closest('[data-result-row]');
    if (!view || !cell || event.button !== 0 || event.isPrimary === false) return;
    // CSS disables text selection. Keep the native pointer default so browsers
    // still emit mouse/double-click events for the existing copy interaction.
    stopDrag(); view.table.focus({ preventScroll: true });
    win.getSelection()?.removeAllRanges(); update(point(cell), event.shiftKey);
    drag = { id: event.pointerId, capture: cell, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, listeners: new win.AbortController(), frame: null };
    const options = { signal: drag.listeners.signal };
    doc.addEventListener('pointermove', move => {
      if (!drag || move.pointerId !== drag.id) return;
      drag.x = move.clientX; drag.y = move.clientY;
      if (!drag.moved) {
        if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 4 && move.target === drag.capture) return;
        drag.moved = true;
        // Capture only a real drag, on its originating cell. A simple click or
        // double-click near an edge must not scroll or change its native target.
        try { cell.setPointerCapture?.(event.pointerId); } catch { /* Document listeners remain available. */ }
        drag.frame = requestFrame(scrollDrag);
      }
      const target = hit(drag.x, drag.y) || move.target.closest?.('[data-result-row]');
      if (target && body.contains(target)) update(point(target), true);
    }, options);
    doc.addEventListener('pointerup', event => { if (event.pointerId === drag?.id) stopDrag(); }, options);
    doc.addEventListener('pointercancel', stopDrag, options); win.addEventListener('blur', stopDrag, options);
  });
  body.addEventListener('lostpointercapture', stopDrag);
  body.addEventListener('keydown', event => {
    if (!view?.rows.length || event.isComposing || event.target.closest('button,input,select,textarea')) return;
    const command = event.ctrlKey || event.metaKey, range = view.saved.range, key = event.key.toLowerCase();
    if (command && key === 'c' && range) { event.preventDefault(); void copyText(selectionText(), '已复制选中单元格。'); return; }
    if (command && key === 'a') {
      event.preventDefault(); view.saved.range = { anchor: { row: 0, column: 0 }, focus: { row: view.rows.length - 1, column: view.state.result.columns.length - 1 } }; paint(); return;
    }
    if (event.key === 'Escape' && range) { event.preventDefault(); event.stopPropagation(); stopDrag(); view.saved.range = null; paint(); return; }
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (!moves[event.key] && !['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const focus = { ...(range?.focus || { row: 0, column: 0 }) };
    if (moves[event.key] && range) { focus.row += moves[event.key][0]; focus.column += moves[event.key][1]; }
    else if (event.key === 'Home' || event.key === 'End') { focus.column = event.key === 'Home' ? 0 : view.state.result.columns.length - 1; if (command) focus.row = event.key === 'Home' ? 0 : view.rows.length - 1; }
    focus.row = Math.max(0, Math.min(view.rows.length - 1, focus.row)); focus.column = Math.max(0, Math.min(view.state.result.columns.length - 1, focus.column));
    update(focus, event.shiftKey); cellAt(focus)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
  body.addEventListener('copy', event => {
    if (!view?.saved.range || !event.clipboardData || !body.contains(doc.activeElement)) return;
    event.preventDefault(); event.clipboardData.setData('text/plain', selectionText());
  });
  return {
    mount(state, rows) {
      const key = JSON.stringify([state.page, state.pageSize, state.filter, state.sort, state.filters]);
      let saved = memory.get(state);
      if (!saved || saved.key !== key || saved.source !== state.result.rows) { saved = { key, source: state.result.rows, range: null }; memory.set(state, saved); }
      view = { state, rows, saved, table: body.querySelector('table'), cells: [...body.querySelectorAll('[data-result-row]')] };
      paint();
    },
    unmount() { stopDrag(); view = null; paint(); },
  };
}
