import { beijingDate, beijingTime, describeSchedule, formatScheduleTime, normalizeSchedule, upcomingSchedule } from './schedule-time.js';

// Local, Monday-first calendar. The text field is still editable and stores YYYY-MM-DD.
function createDatePicker(input) {
  const doc = input.ownerDocument, win = doc.defaultView, lifecycle = new win.AbortController();
  const picker = doc.createElement('div'); picker.className = 'schedule-calendar'; picker.id = `${input.id}Calendar`; picker.hidden = true;
  picker.setAttribute('role', 'dialog'); picker.setAttribute('aria-label', '选择日期');
  picker.innerHTML = `<div class="schedule-calendar-head"><button type="button" data-nav="-1" aria-label="上个月">‹</button><select aria-label="年份"></select><select aria-label="月份"></select><button type="button" data-nav="1" aria-label="下个月">›</button></div><div class="schedule-calendar-grid" role="grid" aria-label="日期"></div><div class="schedule-calendar-foot"><button type="button" data-shortcut="0">今天</button><button type="button" data-shortcut="1">明天</button><button type="button" data-close>关闭</button></div>`;
  input.after(picker); input.setAttribute('aria-controls', picker.id); input.setAttribute('aria-haspopup', 'dialog'); input.setAttribute('aria-expanded', 'false');
  const [years, months] = picker.querySelectorAll('select'), grid = picker.querySelector('[role=grid]');
  for (let year = 2000; year < 2100; year++) years.add(new win.Option(`${year}年`, String(year)));
  for (let month = 1; month <= 12; month++) months.add(new win.Option(`${month}月`, String(month)));
  const parse = value => { if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return null; const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? date : null; };
  const iso = date => date.toISOString().slice(0, 10);
  let cursor, outside;
  function close(focus = false) { picker.hidden = true; input.setAttribute('aria-expanded', 'false'); outside?.abort(); if (focus) input.focus(); }
  function render(focus = false) {
    const year = cursor.getUTCFullYear(), month = cursor.getUTCMonth(); years.value = String(year); months.value = String(month + 1); grid.replaceChildren();
    const heading = doc.createElement('div'); heading.setAttribute('role', 'row');
    for (const day of '一二三四五六日') { const cell = doc.createElement('span'); cell.setAttribute('role', 'columnheader'); cell.textContent = day; heading.append(cell); } grid.append(heading);
    const first = new Date(Date.UTC(year, month, 1)), shift = (first.getUTCDay() + 6) % 7;
    for (let week = 0; week < 6; week++) { const row = doc.createElement('div'); row.setAttribute('role', 'row');
      for (let day = 0; day < 7; day++) { const date = new Date(Date.UTC(year, month, 1 - shift + week * 7 + day)), value = iso(date), button = doc.createElement('button'); button.type = 'button'; button.dataset.date = value; button.textContent = String(date.getUTCDate()); button.setAttribute('role', 'gridcell'); button.setAttribute('aria-label', `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`); button.setAttribute('aria-selected', String(value === input.value)); button.classList.toggle('outside-month', date.getUTCMonth() !== month); button.disabled = date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2099; button.tabIndex = value === iso(cursor) ? 0 : -1; if (value === beijingDate()) button.setAttribute('aria-current', 'date'); row.append(button); }
      grid.append(row);
    }
    if (focus) grid.querySelector('[tabindex="0"]')?.focus();
  }
  function open(focus = false) {
    cursor = parse(input.value) || parse(beijingDate()); picker.hidden = false; input.setAttribute('aria-expanded', 'true'); render(focus);
    outside?.abort(); outside = new win.AbortController();
    doc.addEventListener('pointerdown', event => { if (!input.parentElement.contains(event.target)) close(); }, { signal: outside.signal });
    doc.addEventListener('focusin', event => { if (!input.parentElement.contains(event.target)) close(); }, { signal: outside.signal });
  }
  function choose(value) { input.value = value; input.dispatchEvent(new win.Event('input', { bubbles: true })); close(true); }
  input.addEventListener('click', () => open(), { signal: lifecycle.signal });
  input.addEventListener('input', () => { const value = parse(input.value); if (!picker.hidden && value) { cursor = value; render(); } }, { signal: lifecycle.signal });
  input.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); open(true); } if (event.key === 'Escape' && !picker.hidden) { event.stopPropagation(); close(); } }, { signal: lifecycle.signal });
  picker.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.date) choose(button.dataset.date);
    else if (button.dataset.shortcut != null) choose(beijingDate(Date.now() + Number(button.dataset.shortcut) * 86400000));
    else if (button.hasAttribute('data-close')) close(true);
    else { const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + Number(button.dataset.nav), 1)); if (next.getUTCFullYear() >= 2000 && next.getUTCFullYear() <= 2099) { cursor = next; render(); } }
  });
  picker.addEventListener('change', () => { cursor = new Date(Date.UTC(Number(years.value), Number(months.value) - 1, 1)); render(); });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const movement = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (movement && event.target.dataset.date) { event.preventDefault(); const next = new Date(+parse(event.target.dataset.date) + movement * 86400000); if (next.getUTCFullYear() >= 2000 && next.getUTCFullYear() <= 2099) { cursor = next; render(true); } }
  });
  return { close, dispose() { close(); lifecycle.abort(); } };
}

export function createSchedules({ root, api, getContext, onThread, close }) {
  const doc = root.ownerDocument, $ = id => root.querySelector(`#${id}`);
  const node = (tag, text, className) => { const el = doc.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const button = (label, action, className = 'secondary-button') => { const el = node('button', label, className); el.type = 'button'; el.addEventListener('click', action); return el; };
  const projectName = cwd => cwd?.split('/').filter(Boolean).at(-1) || cwd || '未选择项目';
  let jobs = [], connected = true, editor = null, dirty = false, writing = false, readVersion = 0, timer, listSignature = '', originalRule = null, originalDraft = '', originalRuns = 0;
  root.innerHTML = `
    <div class="schedule-heading"><div><h3>定时任务</h3><p class="field-hint">把重复的事交给助手，按你设定的时间执行。</p></div><button id="scheduleNew" type="button" class="primary-button">＋ 新建任务</button></div>
    <div class="schedule-service"><span>北京时间 · 24 小时制</span><button id="scheduleRefresh" type="button" class="text-button">刷新</button></div>
    <p id="scheduleNotice" class="schedule-notice" role="status"></p>
    <form id="scheduleForm" hidden><fieldset id="scheduleFields"><div class="schedule-form-title"><h4 id="scheduleFormTitle">新建任务</h4><span id="scheduleProject" title=""></span></div>
      <label for="scheduleName">任务名称<input id="scheduleName" required maxlength="80" placeholder="例如：每日项目检查"></label>
      <fieldset class="schedule-plan"><legend>执行计划</legend>
        <div class="schedule-setting"><span class="schedule-field-label">执行方式</span><div class="schedule-frequency-options"><label><input type="radio" name="scheduleMode" value="once">仅一次</label><label><input type="radio" name="scheduleMode" value="repeat" checked>周期执行</label></div></div>
        <label id="scheduleCycleRow" class="schedule-setting"><span>执行周期</span><select id="scheduleCycle"><option value="daily">每天</option><option value="weekdays">周一至周五</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="interval">固定间隔</option></select></label>
        <div id="scheduleDaysRow" class="schedule-setting" hidden><span class="schedule-field-label">执行日</span><div><div id="scheduleDays" class="schedule-days"></div><span class="field-hint">可选择多个星期</span></div></div>
        <label id="scheduleMonthRow" class="schedule-setting" hidden><span>执行日</span><select id="scheduleMonthDay"></select></label>
        <div id="scheduleIntervalRow" class="schedule-setting" hidden><span class="schedule-field-label">执行间隔</span><div class="schedule-inline"><span>每</span><input id="scheduleIntervalValue" aria-label="间隔数值" type="number" min="1" max="43200" value="1" step="1"><select id="scheduleIntervalUnit" aria-label="时间单位"><option value="60">小时</option><option value="1">分钟</option><option value="1440">天</option></select><span>执行一次</span></div></div>
        <label id="scheduleClockRow" class="schedule-setting"><span id="scheduleClockLabel">执行时间</span><span class="schedule-inline"><input id="scheduleTime" aria-label="执行时间" placeholder="09:00" maxlength="5" pattern="([01][0-9]|2[0-3]):[0-5][0-9]" required><span class="field-hint">北京时间 · 24 小时制</span></span></label>
        <label id="scheduleDateRow" class="schedule-setting"><span id="scheduleDateLabel">生效日期</span><span class="schedule-date-field"><input id="scheduleDate" aria-label="生效日期" placeholder="YYYY-MM-DD" maxlength="10" autocomplete="off" required></span></label>
        <div id="scheduleEndRow" class="schedule-setting"><label for="scheduleEnd">结束条件</label><div><select id="scheduleEnd"><option value="never">长期有效</option><option value="date">指定日期结束</option><option value="count">执行指定次数后结束</option></select><span id="scheduleEndDateRow" class="schedule-date-field" hidden><input id="scheduleEndDate" aria-label="结束日期" placeholder="YYYY-MM-DD" maxlength="10" autocomplete="off"><span class="field-hint">含结束当天</span></span><span id="scheduleCountRow" class="schedule-inline" hidden><span>自动执行</span><input id="scheduleMaxRuns" aria-label="自动执行次数" type="number" min="1" max="10000" value="10" step="1"><span>次后结束</span></span></div></div>
        <p id="scheduleRuleHint" class="field-hint"></p>
        <div id="schedulePreview" class="schedule-preview" aria-live="polite"></div>
      </fieldset>
      <label for="scheduleText">任务内容<textarea id="scheduleText" rows="4" required maxlength="10000" placeholder="写清楚要检查的内容，以及希望得到的结果。"></textarea></label>
      <label class="schedule-enable"><input id="scheduleEnabled" type="checkbox" checked>保存后启用，到了时间自动执行</label>
      <p class="field-hint">任务以只读、无网络权限执行，每次运行会消耗模型额度。</p>
      <div class="schedule-form-actions"><button id="scheduleSave" class="primary-button">创建并启用</button><button id="scheduleCancel" type="button" class="secondary-button">取消</button></div>
    </fieldset></form>
    <div class="schedule-list-toolbar"><label class="sr-only" for="scheduleScope">项目范围</label><select id="scheduleScope"><option value="current">当前项目</option><option value="all">全部项目</option></select><label class="sr-only" for="scheduleFilter">任务状态</label><select id="scheduleFilter"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="paused">已暂停 / 已结束</option><option value="archived">已归档</option></select><span id="scheduleCount"></span></div>
    <div id="scheduleResults" class="schedule-results"></div>
    <details class="schedule-help"><summary>运行条件与记录说明</summary><p>电脑需保持唤醒，本机服务运行且助手已连接。关闭网页不影响运行；服务重启后需手动恢复任务。</p><p>错过多次执行时间只会合并触发一次，不会连续补跑。上一轮未完成时，不重复启动同一任务。</p><p>任务和最近 30 次运行记录保存在本机；归档会停止后续执行，可随时恢复。周一至周五按星期执行，不自动调整法定节假日或补班。</p></details>`;
  for (let day = 1; day <= 7; day++) { const label = node('label'), input = doc.createElement('input'); input.type = 'checkbox'; input.value = String(day); input.checked = day === 1; label.append(input, `周${'一二三四五六日'[day - 1]}`); $('scheduleDays').append(label); }
  for (let day = 1; day <= 31; day++) { const option = node('option', `${day} 日`); option.value = String(day); $('scheduleMonthDay').append(option); }
  const lastDay = node('option', '最后一天'); lastDay.value = 'last'; $('scheduleMonthDay').append(lastDay);
  const calendars = [$('scheduleDate'), $('scheduleEndDate')].map(input => createDatePicker(input));
  const say = (text = '', error = false) => { $('scheduleNotice').textContent = text; $('scheduleNotice').classList.toggle('is-error', error); };
  const kind = () => root.querySelector('[name="scheduleMode"]:checked').value === 'once' ? 'once' : $('scheduleCycle').value;
  function readRule() {
    const selected = kind(), time = $('scheduleTime').value.trim(), date = $('scheduleDate').value.trim();
    const value = { kind: selected === 'weekdays' ? 'weekly' : selected, time, date, startDate: date, day: $('scheduleMonthDay').value === 'last' ? 'last' : Number($('scheduleMonthDay').value), days: selected === 'weekdays' ? [1, 2, 3, 4, 5] : [...$('scheduleDays').querySelectorAll('input:checked')].map(input => Number(input.value)), minutes: Number($('scheduleIntervalValue').value) * Number($('scheduleIntervalUnit').value) };
    if (selected !== 'once' && $('scheduleEnd').value === 'date') value.endDate = $('scheduleEndDate').value.trim();
    if (selected !== 'once' && $('scheduleEnd').value === 'count') value.maxRuns = Number($('scheduleMaxRuns').value);
    if (!date) throw new Error(selected === 'once' ? '请选择执行日期。' : '请选择生效日期。');
    if (selected !== 'once' && $('scheduleEnd').value === 'date' && !value.endDate) throw new Error('请选择结束日期。');
    return normalizeSchedule(value);
  }
  function rule() { const value = readRule(); return originalRule && JSON.stringify(value) === originalDraft ? originalRule : value; }
  const completed = value => originalRule && JSON.stringify(normalizeSchedule(value)) === JSON.stringify(normalizeSchedule(originalRule)) ? originalRuns : 0;
  function preview() {
    const selected = kind(), repeat = selected !== 'once', end = $('scheduleEnd').value;
    for (const [id, show] of [['scheduleCycleRow', repeat], ['scheduleMonthRow', selected === 'monthly'], ['scheduleDaysRow', selected === 'weekly'], ['scheduleIntervalRow', selected === 'interval'], ['scheduleEndRow', repeat], ['scheduleEndDateRow', repeat && end === 'date'], ['scheduleCountRow', repeat && end === 'count']]) $(id).hidden = !show;
    $('scheduleEndDate').disabled = !(repeat && end === 'date'); $('scheduleMaxRuns').disabled = !(repeat && end === 'count'); $('scheduleIntervalValue').disabled = selected !== 'interval';
    $('scheduleEndDate').required = repeat && end === 'date'; $('scheduleMaxRuns').required = repeat && end === 'count'; $('scheduleIntervalValue').required = selected === 'interval';
    $('scheduleClockLabel').textContent = selected === 'interval' ? '首次执行时间' : '执行时间';
    $('scheduleDateLabel').textContent = repeat ? '生效日期' : '执行日期'; $('scheduleDate').setAttribute('aria-label', $('scheduleDateLabel').textContent);
    const hints = [];
    if (selected === 'weekdays') hints.push('按周一至周五执行，节假日和补班不自动调整。');
    if (selected === 'monthly' && Number($('scheduleMonthDay').value) > 28) hints.push('没有该日期的月份跳过；如需每个月末执行，请选择“最后一天”。');
    if (selected === 'interval') hints.push('以生效日期和首次执行时间为起点，最短间隔 15 分钟，最长 30 天。');
    if (repeat && end === 'count') hints.push('按自动触发次数计数，失败也计入；立即运行不计入。修改执行计划后重新计数。');
    $('scheduleRuleHint').textContent = hints.join(' ');
    $('scheduleSave').textContent = editor?.id ? '保存修改' : $('scheduleEnabled').checked ? '创建并启用' : '保存为暂停';
    const box = $('schedulePreview'), expanded = box.querySelector('details')?.open; box.replaceChildren();
    try {
      const value = rule(), runs = completed(value), times = upcomingSchedule(value, Date.now(), 3, runs);
      box.append(node('strong', describeSchedule(value)), node('span', value.endDate ? `有效至 ${value.endDate}（含当天）` : value.maxRuns ? `本计划自动执行 ${runs} / ${value.maxRuns} 次` : selected === 'once' ? '执行后自动结束' : '长期有效'));
      if (!times.length) box.append(node('p', '已无后续执行时间，请调整执行计划后再启用。', 'schedule-error'));
      else { box.append(node('p', `下次执行：${formatScheduleTime(times[0])}`)); if (times.length > 1) { const detail = node('details'), list = node('ol'); detail.open = !!expanded; detail.append(node('summary', `查看接下来 ${times.length} 次执行时间`)); for (const at of times) list.append(node('li', formatScheduleTime(at))); detail.append(list); box.append(detail); } }
    } catch (error) { box.append(node('p', error.message, 'schedule-error')); }
  }
  function edit(job) {
    if (writing || dirty && !confirm('放弃当前未保存的任务修改？')) return;
    calendars.forEach(calendar => calendar.close());
    editor = job ? { id: job.id, version: job.version, cwd: job.cwd } : { cwd: getContext().cwd }; dirty = false; originalRule = null; originalDraft = ''; originalRuns = job?.scheduleRuns || 0;
    $('scheduleForm').reset(); $('scheduleName').value = job?.name || ''; $('scheduleText').value = job?.text || '';
    const value = job?.schedule || { kind: 'daily', time: '09:00', startDate: beijingDate(Date.now() + (beijingTime() >= '09:00' ? 86400000 : 0)) };
    const selected = value.kind === 'weekly' && value.days.join(',') === '1,2,3,4,5' ? 'weekdays' : value.kind;
    root.querySelector(`[name="scheduleMode"][value="${selected === 'once' ? 'once' : 'repeat'}"]`).checked = true; $('scheduleCycle').value = selected === 'once' ? 'daily' : selected;
    $('scheduleTime').value = value.time || (value.anchorAt != null ? beijingTime(value.anchorAt) : '09:00');
    $('scheduleDate').value = value.date || value.startDate || (value.anchorAt != null ? beijingDate(value.anchorAt) : beijingDate()); $('scheduleMonthDay').value = String(value.day || 1);
    $('scheduleEnd').value = value.endDate ? 'date' : value.maxRuns ? 'count' : 'never'; $('scheduleEndDate').value = value.endDate || beijingDate(Date.now() + 30 * 86400000); $('scheduleMaxRuns').value = String(value.maxRuns || 10);
    for (const input of $('scheduleDays').querySelectorAll('input')) input.checked = (value.days || [1]).includes(Number(input.value));
    const minutes = value.minutes || 60, unit = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
    $('scheduleIntervalUnit').value = String(unit); $('scheduleIntervalValue').value = String(minutes / unit); $('scheduleEnabled').checked = job ? job.enabled : true;
    if (job) { originalDraft = JSON.stringify(readRule()); originalRule = normalizeSchedule(value); }
    $('scheduleFormTitle').textContent = job ? '编辑任务' : '新建任务'; $('scheduleProject').textContent = `所属项目：${projectName(editor.cwd)}`; $('scheduleProject').title = editor.cwd;
    $('scheduleForm').hidden = false; root.classList.add('is-editing'); preview(); say(); $('scheduleName').focus(); $('scheduleForm').scrollIntoView?.({ block: 'nearest' });
  }
  const stateLabel = job => job.archived ? '已归档' : job.running ? '运行中' : job.enabled ? '已启用' : job.pauseReason === 'finished' ? '已结束' : '已暂停';
  const runLabel = record => ({ running: '运行中', completed: '已完成', interrupted: '已停止', failed: '运行失败', submitted: '已发起，结果请查看会话' })[record.status] || '状态待核对';
  function render() {
    const scope = $('scheduleScope').value, filter = $('scheduleFilter').value;
    const signature = JSON.stringify([jobs, connected, writing, scope, filter, getContext().cwd]);
    if (signature === listSignature) return;
    listSignature = signature;
    const expanded = new Set([...$('scheduleResults').querySelectorAll('details[open]')].map(el => el.dataset.job));
    const matchesState = job => filter === 'archived' ? job.archived : !job.archived && (filter === 'all' || (filter === 'enabled' ? job.enabled : !job.enabled));
    const visible = jobs.filter(job => (scope === 'all' || job.cwd === getContext().cwd) && matchesState(job)).sort((a, b) => Number(b.running) - Number(a.running) || Number(b.enabled) - Number(a.enabled) || (a.nextAt || Infinity) - (b.nextAt || Infinity));
    $('scheduleCount').textContent = `${visible.length} 个任务`;
    $('scheduleResults').replaceChildren();
    if (!visible.length) { const empty = node('div', null, 'schedule-empty'); empty.append(node('strong', filter === 'all' ? '还没有定时任务' : '没有符合条件的任务'), node('p', filter === 'all' ? '例如：每天 09:00 检查项目、每周五整理本周变更。' : '可以切换项目范围或任务状态。')); if (filter === 'all') empty.append(button('创建第一个任务', () => edit(), 'primary-button')); $('scheduleResults').append(empty); }
    for (const job of visible) {
      const card = node('article', null, 'schedule-card'); card.dataset.job = job.id;
      const head = node('div', null, 'schedule-card-head'), badge = node('span', stateLabel(job), 'schedule-badge'); badge.dataset.state = job.running ? 'running' : job.enabled ? 'enabled' : 'paused'; head.append(node('h4', job.name), badge);
      card.append(head, node('p', describeSchedule(job.schedule), 'schedule-rule'));
      const next = job.enabled ? `下次执行：${formatScheduleTime(job.nextAt)}${job.nextAt <= Date.now() ? '（等待唤醒、连接或上一轮结束）' : ''}` : job.pauseReason === 'restart' ? '服务已重启，点击“启用”恢复定时执行。' : job.pauseReason === 'finished' ? '执行计划已结束，不再自动执行。' : job.archived ? '已停止后续执行，恢复后保持暂停。' : '定时执行已暂停。';
      card.append(node('p', next, 'schedule-next'));
      if (job.schedule.endDate) card.append(node('p', `有效至 ${job.schedule.endDate}（含当天）`, 'field-hint'));
      if (job.schedule.maxRuns) card.append(node('p', `本计划已自动执行 ${job.scheduleRuns || 0} / ${job.schedule.maxRuns} 次`, 'field-hint'));
      const project = node('p', `所属项目：${projectName(job.cwd)}`, 'field-hint'); project.title = job.cwd; card.append(project);
      const detail = node('details'); detail.dataset.job = job.id; detail.open = expanded.has(job.id); detail.append(node('summary', `任务内容与运行记录${job.history.length ? `（${job.history.length}）` : ''}`), node('p', job.text, 'schedule-prompt'));
      if (!job.history.length) detail.append(node('p', '尚未运行，到时会自动新建会话。', 'field-hint'));
      for (const record of job.history) { const row = node('div', null, 'schedule-history'); row.append(node('span', `${formatScheduleTime(record.at)} · ${runLabel(record)}`)); if (record.error) row.append(node('p', record.error, 'schedule-error')); if (record.threadId) row.append(button('查看结果', async () => { try { await onThread(record.threadId); close(); } catch (error) { say(error.message, true); } }, 'text-button')); detail.append(row); }
      if (job.history[0]) card.append(node('p', `最近一次：${runLabel(job.history[0])}`, job.history[0].status === 'failed' ? 'schedule-error' : 'field-hint'));
      const actions = node('div', null, 'schedule-card-actions');
      if (job.archived) actions.append(button('恢复任务', () => mutate({ action: 'restore', id: job.id, version: job.version }, '已恢复，任务保持暂停。')));
      else {
        actions.append(button('编辑', () => edit(job)), button(job.enabled ? '暂停' : '启用', () => mutate({ action: 'setEnabled', id: job.id, version: job.version, enabled: !job.enabled }, job.enabled ? '已暂停后续执行，当前运行不受影响。' : '任务已启用。')));
        const once = button(job.running ? '正在运行…' : '立即运行', () => { if (confirm(`立即运行“${job.name}”？\n会消耗模型额度，不改变原定执行时间。`)) void mutate({ action: 'run', id: job.id, version: job.version }, '已发起运行，可在记录中查看结果。'); }); once.disabled = job.running || !connected; actions.append(once, button('归档', () => mutate({ action: 'archive', id: job.id, version: job.version }, '已归档，可在“已归档”中恢复。'), 'text-button'));
        actions.firstChild.disabled = !!job.running; actions.lastChild.disabled = !!job.running;
      }
      for (const control of actions.children) control.disabled ||= writing;
      card.append(actions, detail); $('scheduleResults').append(card);
    }
  }
  async function load({ quiet = false } = {}) {
    if (writing) return;
    const version = ++readVersion;
    try { const data = await api('/api/schedules'); if (version !== readVersion) return; jobs = data.jobs.map(job => ({ ...job, name: job.name || job.text.slice(0, 40), schedule: job.schedule || { kind: 'interval', minutes: job.minutes } })); const reconnected = !connected && data.connected !== false; connected = data.connected !== false; render(); if (!connected) say('助手未连接，恢复连接后才能执行任务。'); else if (reconnected && $('scheduleNotice').textContent === '助手未连接，恢复连接后才能执行任务。') say(); }
    catch (error) { if (version === readVersion && !quiet) say(error.message, true); }
  }
  async function mutate(body, success) {
    if (writing) return false;
    writing = true; readVersion++; $('scheduleFields').disabled = true; $('scheduleNew').disabled = true; render(); say();
    try {
      const data = await api('/api/schedules/action', { ...body, confirmed: true }); jobs = data.jobs; connected = data.connected !== false;
      const failed = body.action === 'run' && jobs.find(job => job.id === body.id)?.history[0]?.status === 'failed';
      say(failed ? '本次运行未成功，请展开运行记录查看原因。' : success, failed); return true;
    } catch (error) { say(error.message, true); return false; }
    finally { writing = false; $('scheduleFields').disabled = false; $('scheduleNew').disabled = false; render(); }
  }
  $('scheduleNew').addEventListener('click', () => edit()); $('scheduleRefresh').addEventListener('click', () => load());
  $('scheduleScope').addEventListener('change', render); $('scheduleFilter').addEventListener('change', render);
  $('scheduleForm').addEventListener('input', event => { if (!event.target.closest('.schedule-calendar')) { dirty = true; preview(); } }); $('scheduleForm').addEventListener('change', event => { if (!event.target.closest('.schedule-calendar')) { dirty = true; preview(); } });
  $('scheduleCancel').addEventListener('click', () => { if (!dirty || confirm('放弃当前未保存的任务修改？')) { calendars.forEach(calendar => calendar.close()); $('scheduleForm').hidden = true; root.classList.remove('is-editing'); editor = null; dirty = false; } });
  $('scheduleForm').addEventListener('submit', async event => {
    event.preventDefault(); if (writing || !editor) return;
    try {
      const value = rule(); if ($('scheduleEnabled').checked && !upcomingSchedule(value, Date.now(), 3, completed(value)).length) throw new Error('已无后续执行时间，请调整执行计划。');
      const body = { action: editor.id ? 'update' : 'create', ...editor, name: $('scheduleName').value, text: $('scheduleText').value, schedule: value, enabled: $('scheduleEnabled').checked };
      if (!body.name.trim() || !body.text.trim()) throw new Error('请填写任务名称和任务内容。');
      if (await mutate(body, body.action === 'create' ? body.enabled ? '任务已创建并启用。' : '任务已保存，当前暂停。' : '任务修改已保存。')) { calendars.forEach(calendar => calendar.close()); $('scheduleForm').hidden = true; root.classList.remove('is-editing'); editor = null; dirty = false; }
    } catch (error) { say(error.message, true); }
  });
  function setVisible(visible) { if (!visible) calendars.forEach(calendar => calendar.close()); doc.defaultView.clearInterval(timer); if (visible) timer = doc.defaultView.setInterval(() => { if (doc.visibilityState !== 'hidden') void load({ quiet: true }); }, 15000); }
  return { load, render, setVisible, hasDraft: () => dirty, get pending() { return writing; }, dispose: () => { calendars.forEach(calendar => calendar.dispose()); doc.defaultView.clearInterval(timer); readVersion++; } };
}
