import { filterRows, resultText, columnOptions, matchesColumn, createResultSelection } from './sql-query.js';
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
let nextSheetGrid = 0;
const button = (text, click) => { const el = node('button', text, 'secondary-button'); el.type = 'button'; el.addEventListener('click', click); return el; };

export function createArtifactViewer({ container, bytes, entry, result, api, state = {} }) {
  let disposed = false, generation = 0, loadingTask, pdf, rendering, observer, resizeTimer, textLayer, resume = () => {}, searchRevision = 0, disposeSheet = () => {};
  const root = node('section', null, 'document-preview'), status = node('p', '正在生成预览…', 'field-hint'); status.setAttribute('role', 'status');
  container.append(root); root.append(status);
  const fail = error => { if (!disposed) status.textContent = error.message || '无法预览，请下载文件后查看。'; };
  const copy = async text => { try { await navigator.clipboard.writeText(text); if (!disposed) status.textContent = '已复制。'; } catch { fail(new Error('剪贴板不可用，请选中文字后复制。')); } };

  async function spreadsheet() {
    let sheet = state.sheet || 0, grid, loading = false, columnContext = null;
    const grids = new Map(), requests = new Map(), id = ++nextSheetGrid; state.sheets ||= {};
    const doc = root.ownerDocument, win = doc.defaultView, listeners = new win.AbortController();
    const tabs = node('div', null, 'sheet-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '工作表');
    const toolbar = node('div', null, 'document-toolbar sheet-toolbar'), search = node('input'), info = node('span');
    search.type = 'search'; search.placeholder = '搜索所有列…'; search.setAttribute('aria-label', '筛选工作表');
    const chips = node('div', null, 'sql-filter-chips'), area = node('div', null, 'sheet-scroll');
    area.tabIndex = 0; area.setAttribute('aria-label', '工作表数据');
    const pagination = node('footer', null, 'document-pagination sheet-pagination'), pageSize = node('select'), stats = node('div', null, 'sql-selection-stats');
    pageSize.setAttribute('aria-label', '工作表每页行数'); for (const size of [50, 100, 200]) pageSize.append(new Option(`${size} 行 / 页`, size));
    stats.hidden = true; stats.setAttribute('role', 'status'); stats.setAttribute('aria-live', 'polite'); stats.setAttribute('aria-atomic', 'true');
    const selection = createResultSelection({ body: area, stats, copyText: copy });
    const columnMenu = node('section', null, 'sql-column-menu sheet-value-menu'); columnMenu.hidden = true; columnMenu.setAttribute('role', 'dialog'); columnMenu.setAttribute('aria-label', '工作表列操作');
    const menuHost = container.closest('dialog') || doc.body; menuHost.append(columnMenu);
    const selectedRows = () => grid ? filterRows(grid.result, grid.filter, grid.sort, grid.filters) : [];
    const remember = () => { if (grid && !root.closest('[hidden]')) { grid.top = area.scrollTop; grid.left = area.scrollLeft; state.sheet = sheet; state.sheets[sheet] = { page: grid.page, pageSize: grid.pageSize, query: grid.filter, sort: grid.sort, filters: grid.filters, top: grid.top, left: grid.left }; } };
    function closeColumn(focus = false) {
      const trigger = columnContext?.trigger; columnContext = null; columnMenu.hidden = true;
      trigger?.setAttribute('aria-expanded', 'false'); if (focus && trigger?.isConnected) trigger.focus({ preventScroll: true });
    }
    function changed() { grid.page = 0; grid.top = 0; closeColumn(); draw(); area.scrollTop = 0; remember(); }
    const prev = button('上一页', () => { grid.page--; closeColumn(); draw(); area.scrollTop = 0; remember(); });
    const next = button('下一页', () => { grid.page++; closeColumn(); draw(); area.scrollTop = 0; remember(); });
    const copyRows = button('复制表格', () => copy(resultText(grid.labels, selectedRows())));
    const copyHeaders = button('复制表头', () => copy(resultText(grid.labels, [])));
    const downloadFiltered = button('下载筛选', () => {
      const url = URL.createObjectURL(new Blob(['\uFEFF' + resultText(grid.labels, selectedRows(), true)], { type: 'text/csv;charset=utf-8' }));
      const link = node('a'); link.href = url; link.download = `${grid.data.sheets[sheet]}-筛选.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const clear = button('清空筛选', () => { grid.filter = ''; search.value = ''; grid.sort = null; grid.filters = []; changed(); });
    toolbar.append(search, copyRows, copyHeaders, downloadFiltered, clear); pagination.append(pageSize, prev, info, next, stats);
    root.append(tabs, toolbar, chips, area, node('p', '首行为表头 · 只读预览 · 筛选和复制覆盖所有已加载页，选区统计仅针对当前页。公式显示已保存结果，不运行宏。', 'field-hint'), pagination);
    search.addEventListener('input', () => { if (!grid || loading) return; grid.filter = search.value; changed(); });
    pageSize.addEventListener('change', () => { if (!grid || loading) return; grid.pageSize = Number(pageSize.value); changed(); });
    area.addEventListener('scroll', () => { remember(); closeColumn(); });
    function positionColumn() {
      if (!columnContext || columnMenu.hidden) return;
      const rect = columnContext.trigger.getBoundingClientRect(), menu = columnMenu.getBoundingClientRect();
      columnMenu.style.left = `${Math.max(8, Math.min(rect.left, win.innerWidth - menu.width - 8))}px`;
      columnMenu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, win.innerHeight - menu.height - 8))}px`;
    }
    function openColumn(index, trigger) {
      if (!grid || loading) return; closeColumn();
      const current = grid, column = grid.result.columns[index], label = grid.labels[index], rule = grid.filters.find(rule => rule.column === column);
      const options = columnOptions(grid.result, column, grid.filter, grid.filters);
      const selected = new Set(rule?.op === 'in' ? rule.values : options.filter(option => !rule || matchesColumn(option.value, rule)).map(option => option.key));
      const context = { trigger, current }; columnContext = context; let limit = 200;
      const valid = () => !disposed && !loading && grid === current && columnContext === context;
      const owner = container.closest('[data-module-theme]') || doc.documentElement;
      for (const key of ['theme', 'skin', 'appearance']) columnMenu.dataset[key] = owner.dataset[key] || doc.documentElement.dataset[key] || '';
      columnMenu.dataset.moduleTheme = owner.dataset.moduleTheme || 'editor';
      const header = node('header'), exit = button('×', () => closeColumn(true)); exit.className = 'icon-button'; exit.setAttribute('aria-label', '关闭列操作'); header.append(node('strong', `${label} · ${column} 列`), exit);
      const sorts = node('div', null, 'sql-column-sorts');
      for (const [text, direction] of [['升序 ↑', 1], ['降序 ↓', -1], ['原顺序', 0]]) sorts.append(button(text, () => { if (!valid()) return; grid.sort = direction ? { column, direction } : null; changed(); }));
      const form = node('form', null, 'sql-values-form'), valueSearch = node('input'), tools = node('div', null, 'sql-value-tools'), count = node('span'), list = node('div', null, 'sql-value-list'), hint = node('p', null, 'sql-value-hint'), actions = node('div', null, 'sql-value-actions');
      valueSearch.type = 'search'; valueSearch.placeholder = '搜索此列的值…'; valueSearch.setAttribute('aria-label', '搜索此列的值'); count.setAttribute('role', 'status'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', '勾选列值');
      const searched = () => options.filter(option => option.label.toLocaleLowerCase().includes(valueSearch.value.trim().toLocaleLowerCase()));
      const countSelected = () => { const matches = searched(); count.textContent = `已选 ${matches.filter(option => selected.has(option.key)).length} / ${matches.length} 项`; };
      const allButtons = [];
      for (const action of ['全选', '清空', '反选']) {
        const control = button(action, () => { if (!valid()) return; for (const option of searched()) { if (action === '清空' || action === '反选' && selected.has(option.key)) selected.delete(option.key); else selected.add(option.key); } renderOptions(); });
        tools.append(control); allButtons.push(control);
      }
      tools.append(count);
      function renderOptions() {
        const matches = searched(), top = list.scrollTop; list.replaceChildren();
        for (const option of matches.slice(0, limit)) {
          const row = node('label', null, 'sql-value-option'), input = node('input'), text = node('span', option.label), amount = node('small', `(${option.count})`);
          input.type = 'checkbox'; input.checked = selected.has(option.key); input.setAttribute('aria-label', option.label); input.dataset.valueKey = option.key;
          input.addEventListener('change', () => { if (input.checked) selected.add(option.key); else selected.delete(option.key); countSelected(); });
          text.title = option.label; amount.setAttribute('aria-label', `${option.count} 行`); row.classList.toggle('is-unavailable', !option.count); row.append(input, text, amount); list.append(row);
        }
        if (!matches.length) list.append(node('p', '没有匹配的值'));
        if (matches.length > limit) { const more = button(`显示更多（还有 ${matches.length - limit} 项）`, () => { limit += 200; renderOptions(); }); more.className = 'sql-values-more'; list.append(more); }
        for (const control of allButtons) control.disabled = !matches.length;
        hint.textContent = `${valueSearch.value.trim() ? '确认后仅保留搜索匹配的勾选项。' : '全选 / 清空 / 反选作用于全部值，确认后生效。'}${grid.result.truncated ? ' 数量仅统计已加载的工作表预览。' : ' 数量包含所有页，并受其他筛选影响。'}`;
        list.scrollTop = top; countSelected();
      }
      valueSearch.addEventListener('input', () => { limit = 200; list.scrollTop = 0; renderOptions(); });
      const apply = button('确认', () => {}); apply.type = 'submit'; apply.className = 'primary-button';
      actions.append(apply, button('取消', () => closeColumn(true)), button('清除此列筛选', () => { if (!valid()) return; grid.filters = grid.filters.filter(rule => rule.column !== column); changed(); }));
      form.append(valueSearch, tools, list, hint, actions);
      form.addEventListener('submit', event => {
        event.preventDefault(); if (!valid()) return;
        const values = new Set((valueSearch.value.trim() ? searched().filter(option => selected.has(option.key)).map(option => option.key) : [...selected]));
        grid.filters = grid.filters.filter(rule => rule.column !== column);
        if (grid.result.truncated || !options.every(option => values.has(option.key))) grid.filters.push({ column, op: 'in', values: [...values] });
        changed();
      });
      const condition = node('details', null, 'sql-column-details'), conditionForm = node('form'), operator = node('select'), input = node('input');
      operator.setAttribute('aria-label', '列筛选方式'); input.setAttribute('aria-label', '工作表列筛选值'); input.placeholder = '输入筛选值';
      for (const [value, text] of [['contains', '包含'], ['notcontains', '不包含'], ['equals', '等于'], ['notequals', '不等于'], ['gt', '大于（数值）'], ['gte', '大于等于（数值）'], ['lt', '小于（数值）'], ['lte', '小于等于（数值）'], ['empty', '为空'], ['notempty', '不为空']]) operator.append(new Option(text, value));
      operator.value = rule && rule.op !== 'in' ? rule.op : 'contains'; input.value = rule?.value || '';
      const operatorChanged = () => { input.disabled = ['empty', 'notempty'].includes(operator.value); }; operator.addEventListener('change', operatorChanged); operatorChanged();
      const conditionApply = button('应用条件', () => {}); conditionApply.type = 'submit'; conditionApply.className = 'primary-button';
      conditionForm.append(operator, input, conditionApply); condition.append(node('summary', '按条件筛选'), conditionForm);
      conditionForm.addEventListener('submit', event => { event.preventDefault(); if (!valid()) return; const op = operator.value, value = input.value; grid.filters = grid.filters.filter(rule => rule.column !== column); if (value !== '' || ['empty', 'notempty', 'equals', 'notequals'].includes(op)) grid.filters.push({ column, op, value }); changed(); });
      const copyDetails = node('details', null, 'sql-column-details'), copies = node('div', null, 'sql-column-copy');
      for (const action of ['复制此列数据', '复制此列（含表头）', '复制列名']) copies.append(button(action, () => { if (!valid()) return; void copy(action === '复制列名' ? label : resultText([label], selectedRows().map(row => [row[index]]), false, action === '复制此列（含表头）')); closeColumn(true); }));
      copyDetails.append(node('summary', '复制此列…'), copies, node('p', '复制当前筛选后的所有已加载页。'));
      for (const details of [condition, copyDetails]) details.addEventListener('toggle', positionColumn);
      columnMenu.replaceChildren(header, sorts, form, condition, copyDetails); renderOptions(); columnMenu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); positionColumn(); valueSearch.focus();
    }
    const options = { signal: listeners.signal };
    doc.addEventListener('pointerdown', event => { if (!columnMenu.hidden && !columnMenu.contains(event.target) && !columnContext?.trigger.contains(event.target)) closeColumn(); }, options);
    doc.addEventListener('keydown', event => { if (!columnMenu.hidden && event.key === 'Escape') { event.preventDefault(); closeColumn(true); } }, options);
    doc.addEventListener('workspace-layout', () => closeColumn(), options); win.addEventListener('resize', () => closeColumn(), options);
    const visibility = new win.MutationObserver(() => { if (root.closest('[hidden]') || menuHost.tagName === 'DIALOG' && !menuHost.open) { closeColumn(); selection.unmount(); } });
    for (let parent = container; parent && parent !== doc.body; parent = parent.parentElement) visibility.observe(parent, { attributes: true, attributeFilter: ['hidden', 'open'] });
    resume = () => { if (grid && !loading) { const { top, left } = grid; draw(); area.scrollTop = top; area.scrollLeft = left; remember(); } };
    disposeSheet = () => { selection.unmount(); closeColumn(); listeners.abort(); visibility.disconnect(); columnMenu.remove(); grids.clear(); requests.clear(); };
    function draw() {
      if (!grid || disposed) return; selection.unmount();
      const filtered = selectedRows(), pages = Math.max(1, Math.ceil(filtered.length / grid.pageSize)); grid.page = Math.max(0, Math.min(grid.page, pages - 1));
      prev.disabled = grid.page === 0; next.disabled = grid.page + 1 >= pages; pageSize.value = grid.pageSize;
      info.textContent = `${grid.page + 1} / ${pages} 页 · ${filtered.length} / ${grid.result.rows.length} 行`;
      const table = node('table', null, 'sql-table'), head = table.createTHead().insertRow(), body = table.createTBody();
      table.tabIndex = 0; table.setAttribute('role', 'grid'); table.setAttribute('aria-multiselectable', 'true'); table.setAttribute('aria-label', '工作表数据，拖动选择单元格查看统计；Shift 扩选，Ctrl 或 Command 加 C 复制选区');
      const number = node('th', '#'); number.scope = 'col'; number.title = '原 Excel 行号；点击行号复制此行'; head.append(number);
      for (const [index, column] of grid.result.columns.entries()) {
        const name = grid.labels[index], cell = node('th'), order = button(name + (grid.sort?.column === column ? grid.sort.direction === 1 ? ' ↑' : ' ↓' : ''), () => { grid.sort = grid.sort?.column === column ? grid.sort.direction === 1 ? { column, direction: -1 } : null : { column, direction: 1 }; changed(); });
        cell.scope = 'col'; cell.setAttribute('aria-sort', grid.sort?.column === column ? grid.sort.direction === 1 ? 'ascending' : 'descending' : 'none'); order.className = 'sql-column-sort'; order.title = `${name} · ${column} 列：升序 / 降序 / 原顺序`;
        const menu = button(grid.filters.some(rule => rule.column === column) ? '● ▾' : '▾', () => openColumn(index, menu)); menu.className = 'sql-column-trigger'; menu.setAttribute('aria-label', `${name}（${column}列）列操作：筛选、排序、复制`); menu.setAttribute('aria-haspopup', 'dialog'); menu.setAttribute('aria-expanded', 'false'); cell.append(order, menu); head.append(cell);
      }
      const pageRows = filtered.slice(grid.page * grid.pageSize, (grid.page + 1) * grid.pageSize);
      for (const [index, cells] of pageRows.entries()) {
        const line = body.insertRow(), number = node('th'), rowNumber = grid.indices.get(cells) + 2;
        const rowCopy = button(String(rowNumber), () => copy(resultText(grid.labels, [cells], false, false))); rowCopy.title = `复制 Excel 第 ${rowNumber} 行`; rowCopy.setAttribute('aria-label', rowCopy.title); number.scope = 'row'; number.append(rowCopy); line.append(number);
        for (const [column, value] of cells.entries()) {
          const td = line.insertCell(); td.textContent = value; td.dataset.resultRow = String(index); td.dataset.resultColumn = String(column); td.id = `sheet-${id}-${sheet}-${index}-${column}`; td.setAttribute('role', 'gridcell'); td.title = value + '\n拖动框选 · Shift 点击扩选 · 双击复制'; td.addEventListener('dblclick', () => copy(value));
        }
      }
      chips.replaceChildren();
      const operators = { contains: '包含', notcontains: '不包含', equals: '=', notequals: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', empty: '为空', notempty: '不为空' };
      for (const rule of grid.filters) { const label = grid.labels[grid.result.columns.indexOf(rule.column)], chip = button(`${label}：${rule.op === 'in' ? `已选 ${rule.values.length} 项` : `${operators[rule.op]} ${rule.value || ''}`} ×`, () => { grid.filters = grid.filters.filter(item => item !== rule); changed(); }); chip.className = 'sql-filter-chip'; chip.setAttribute('aria-label', `清除 ${label} 筛选`); chips.append(chip); }
      if (grid.sort) { const chip = button(`${grid.labels[grid.result.columns.indexOf(grid.sort.column)]} ${grid.sort.direction === 1 ? '升序' : '降序'} ×`, () => { grid.sort = null; changed(); }); chip.className = 'sql-filter-chip'; chip.title = '恢复原顺序'; chips.append(chip); }
      chips.hidden = !chips.children.length; clear.hidden = !grid.filter && !grid.filters.length && !grid.sort; downloadFiltered.hidden = !grid.filter && !grid.filters.length;
      area.replaceChildren(table); if (!filtered.length) area.append(node('p', grid.result.rows.length ? '没有匹配的行，调整或清空筛选后重试。' : '工作表没有数据行。', 'field-hint'));
      selection.mount(grid, pageRows); remember();
      status.textContent = `${grid.data.sheets[sheet]} · ${Math.max(0, grid.data.totalRows - 1)} 行数据 × ${grid.data.totalColumns} 列 · 首行为表头${grid.result.truncated ? ` · 已加载 ${grid.result.rows.length} 行、${grid.result.columns.length} 列，筛选与统计仅覆盖预览；完整内容可下载原文件` : ''}`;
      for (const tab of tabs.children) { const active = Number(tab.dataset.sheet) === sheet; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; }
    }
    async function load(index) {
      remember(); closeColumn(); selection.unmount(); const token = ++generation; loading = true; area.inert = true; status.textContent = '正在读取工作表…';
      for (const control of [...toolbar.querySelectorAll('button,input'), pageSize, prev, next]) control.disabled = true;
      try {
        if (!grids.has(index)) {
          if (!requests.has(index)) requests.set(index, api('/api/project/spreadsheet', { ...entry, sheet: index, version: result.version }));
          const data = await requests.get(index); requests.delete(index);
          if (disposed) return;
          if (!grids.has(index)) {
            const rows = data.rows.slice(1), saved = state.sheets[index] || {}, labels = data.columns.map((column, i) => { const label = String(data.rows[0]?.[i] ?? ''); return label.trim() ? label : `列 ${column}`; });
            grids.set(index, { data, labels, result: { columns: data.columns, rows, truncated: data.limited }, indices: new Map(rows.map((row, i) => [row, i])), page: saved.page || 0, pageSize: [50, 100, 200].includes(saved.pageSize) ? saved.pageSize : 100, filter: saved.query || '', sort: saved.sort || null, filters: saved.filters || [], top: saved.top || 0, left: saved.left || 0 });
          }
        }
        if (disposed || token !== generation) return;
        grid = grids.get(index); sheet = index; const { top, left } = grid; search.value = grid.filter;
        if (!tabs.children.length) for (const [i, name] of grid.data.sheets.entries()) { const tab = button(name, () => load(i)); tab.dataset.sheet = i; tab.setAttribute('role', 'tab'); tabs.append(tab); }
        loading = false; draw(); area.scrollTop = top; area.scrollLeft = left; remember();
      } catch (error) { requests.delete(index); if (token === generation && !disposed) { if (grid) draw(); fail(error); } }
      finally {
        if (!disposed && token === generation) { loading = false; area.inert = !grid; for (const control of [...toolbar.querySelectorAll('button,input'), pageSize]) control.disabled = !grid; prev.disabled = !grid || grid.page === 0; next.disabled = !grid || (grid.page + 1) * grid.pageSize >= selectedRows().length; }
      }
    }
    tabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !grid) return;
      event.preventDefault(); const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? grid.data.sheets.length - 1 : (Number(doc.activeElement.dataset.sheet ?? sheet) + (event.key === 'ArrowRight' ? 1 : -1) + grid.data.sheets.length) % grid.data.sheets.length;
      tabs.children[nextIndex]?.focus(); void load(nextIndex);
    });
    await load(sheet);
  }
  async function pdfPreview() {
    const pdfjs = await import('/vendor/pdfjs/build/pdf.min.mjs'); if (disposed) return;
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.min.mjs';
    loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false, cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/', iccUrl: '/vendor/pdfjs/icc/' });
    pdf = await loadingTask.promise; if (disposed) { await pdf.destroy(); return; }
    let page = state.page || 1, pageText = '';
    const toolbar = node('div', null, 'document-toolbar'), input = node('input'), count = node('span'), zoom = node('select');
    input.type = 'number'; input.min = 1; input.max = pdf.numPages; input.value = 1; input.setAttribute('aria-label', 'PDF 页码'); input.className = 'pdf-page-number';
    zoom.setAttribute('aria-label', 'PDF 缩放'); for (const [value, label] of [['fit', '适合宽度'], ['0.75', '75%'], ['1', '100%'], ['1.5', '150%'], ['2', '200%']]) zoom.append(new Option(label, value));
    const area = node('div', null, 'pdf-scroll'), paper = node('div', null, 'pdf-paper'), canvas = node('canvas'), textOverlay = node('div', null, 'textLayer'); canvas.setAttribute('role', 'img'); area.tabIndex = 0; paper.append(canvas, textOverlay); area.append(paper);
    zoom.value = state.zoom || 'fit'; area.addEventListener('scroll', () => { state.top = area.scrollTop; state.left = area.scrollLeft; });
    const text = node('details'), textBody = node('pre', '', 'pdf-text'); text.append(node('summary', '本页文字'), textBody);
    const prev = button('上一页', () => { page--; state.top = 0; void render(); }), next = button('下一页', () => { page++; state.top = 0; void render(); });
    const search = node('input'); search.type = 'search'; search.placeholder = '查找文档文字…'; search.setAttribute('aria-label', '查找 PDF 文字'); search.value = state.query || '';
    const find = button('查找下一个', async () => {
      const query = search.value.trim().toLocaleLowerCase(), token = ++searchRevision; if (!query) return; state.query = query; find.disabled = true;
      try {
        for (let offset = 0; offset < pdf.numPages; offset++) {
          if (disposed || token !== searchRevision) return;
          const target = (page - 1 + offset + (state.searched === query ? 1 : 0)) % pdf.numPages + 1;
          status.textContent = `正在查找第 ${target} / ${pdf.numPages} 页…`;
          const candidate = await pdf.getPage(target), content = await candidate.getTextContent();
          if (disposed || token !== searchRevision) return;
          if (content.items.map(item => item.str || '').join(' ').toLocaleLowerCase().includes(query)) { page = target; state.top = 0; state.searched = query; await render(); status.textContent += ' · 找到匹配'; return; }
        }
        if (!disposed && token === searchRevision) status.textContent = '整份文档未找到匹配文字（扫描图片需先进行文字识别）。';
      } catch (error) { if (!disposed && token === searchRevision) fail(error); } finally { if (!disposed && token === searchRevision) find.disabled = false; }
    });
    search.addEventListener('input', () => { searchRevision++; state.searched = ''; find.disabled = false; }); search.onkeydown = event => { if (event.key === 'Enter') find.click(); };
    toolbar.append(prev, input, count, next, zoom, button('复制本页文字', () => copy(pageText)), search, find); root.append(toolbar, area, text);
    input.addEventListener('change', () => { page = Math.max(1, Math.min(pdf.numPages, Number(input.value) || 1)); state.top = 0; void render(); });
    zoom.addEventListener('change', () => void render());
    async function render() {
      if (!area.clientWidth || disposed) return;
      const token = ++generation; rendering?.cancel(); textLayer?.cancel();
      try {
        if (rendering) await rendering.promise.catch(() => {});
        if (disposed || token !== generation) return;
        page = Math.max(1, Math.min(pdf.numPages, page)); state.page = page; state.zoom = zoom.value; input.value = page; prev.disabled = page === 1; next.disabled = page === pdf.numPages; count.textContent = `/ ${pdf.numPages}`;
        status.textContent = `正在显示第 ${page} 页…`; pageText = ''; textBody.textContent = '';
        const pdfPage = await pdf.getPage(page); if (disposed || token !== generation) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const scale = zoom.value === 'fit' ? Math.max(0.1, (area.clientWidth - 24) / natural.width) : Number(zoom.value);
        const viewport = pdfPage.getViewport({ scale }), ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(12_000_000 / (viewport.width * viewport.height)));
        paper.style.width = `${viewport.width}px`; paper.style.height = `${viewport.height}px`; paper.style.setProperty('--total-scale-factor', String(viewport.scale));
        canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio); canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`; canvas.setAttribute('aria-label', `${result.name} 第 ${page} 页`);
        rendering = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
        await rendering.promise; if (disposed || token !== generation) return;
        const content = await pdfPage.getTextContent(); if (disposed || token !== generation) return;
        textOverlay.replaceChildren(); textLayer = new pdfjs.TextLayer({ textContentSource: content, container: textOverlay, viewport }); await textLayer.render(); if (disposed || token !== generation) return;
        for (const span of textOverlay.querySelectorAll('span')) if (state.query && span.textContent.toLocaleLowerCase().includes(state.query)) span.classList.add('pdf-match');
        area.scrollTop = state.top || 0; area.scrollLeft = state.left || 0;
        pageText = content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join(''); textBody.textContent = pageText || '此页是图片或没有可提取的文字。';
        status.textContent = `${result.name} · 第 ${page} / ${pdf.numPages} 页`;
      } catch (error) { if (token === generation && !['RenderingCancelledException', 'AbortException'].includes(error.name)) fail(error); }
    }
    resume = () => { if (zoom.value === 'fit') void render(); };
    observer = new ResizeObserver(() => { clearTimeout(resizeTimer); if (zoom.value === 'fit') resizeTimer = setTimeout(() => void render(), 150); }); observer.observe(area);
    await render();
  }
  void (result.extension === '.pdf' ? pdfPreview() : spreadsheet()).catch(fail);
  return { resume() { resume(); }, dispose() { disposed = true; generation++; searchRevision++; clearTimeout(resizeTimer); disposeSheet(); observer?.disconnect(); rendering?.cancel(); textLayer?.cancel(); if (loadingTask) void loadingTask.destroy().catch(() => {}); root.remove(); } };
}
