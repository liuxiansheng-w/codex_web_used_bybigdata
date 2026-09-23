// Parameter syntax shared with the existing DGC runner: ${name}, {{name}}, :name, @name and ?.
// Keep expansion identical to the original runner. SQL policy belongs to that service.
// Named parameters are shared across files in a project/engine. Positional
// parameters are tied to the exact query, since param1 has no shared meaning.
export const BUSINESS_DATE_PARAMETER = 'bdp.system.bizdate';

export function yesterdayBusinessDate(now = new Date()) {
  const date = new Date(now); date.setDate(date.getDate() - 1);
  return `${String(date.getFullYear()).padStart(4, '0')}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

export function calendarDate(value) {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(value).trim());
  if (!match || Number(match[1]) < 1) return '';
  const [, year, month, day] = match, date = new Date(0);
  date.setFullYear(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return '';
  return `${year}-${month}-${day}`;
}

// The text field remains the only SQL parameter. The calendar is a transient
// editor for that value, with no form submission or parameter-memory side effects.
export function addBusinessDatePicker(input) {
  const doc = input.ownerDocument, win = doc.defaultView, field = doc.createElement('span'), picker = doc.createElement('span');
  field.className = 'sql-business-date';
  input.placeholder = 'YYYYMMDD'; input.inputMode = 'numeric';
  input.setAttribute('aria-label', input.name);
  picker.id = 'sql-business-calendar'; picker.className = 'sql-date-calendar'; picker.hidden = true;
  picker.setAttribute('role', 'dialog'); picker.setAttribute('aria-label', '选择业务日期');
  input.setAttribute('aria-haspopup', 'dialog'); input.setAttribute('aria-controls', picker.id); input.setAttribute('aria-expanded', 'false');
  // A popover stays in the modal's top layer and inherits its independent theme,
  // without being clipped by the parameter dialog's scrolling container.
  const floating = typeof picker.showPopover === 'function';
  if (floating) picker.setAttribute('popover', 'manual');
  picker.innerHTML = `<span class="sql-date-heading"><button type="button" data-date-nav="-1">‹</button><span class="sql-date-period"><button type="button" data-date-year></button><button type="button" data-date-month></button></span><button type="button" data-date-nav="1">›</button></span><span class="sql-date-grid" role="grid"></span><span class="sql-date-footer"><span><button type="button" data-date-shortcut="yesterday">昨天</button><button type="button" data-date-shortcut="today">今天</button></span><span class="sql-date-selection" aria-live="polite"></span></span>`;
  const grid = picker.querySelector('.sql-date-grid'), yearButton = picker.querySelector('[data-date-year]'), monthButton = picker.querySelector('[data-date-month]');
  const dateAt = (year, month, day) => { const date = new Date(0); date.setHours(12, 0, 0, 0); date.setFullYear(year, month, day); return date; };
  const parse = value => { const [y, m, d] = value.split('-').map(Number); return dateAt(y, m - 1, d); };
  const iso = date => `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  let opened = false, suppressFocus = false, listeners, view = 'days', cursor = parse(calendarDate(input.value) || calendarDate(yesterdayBusinessDate()));
  let year = cursor.getFullYear(), month = cursor.getMonth();
  const yearStart = () => Math.min(9988, Math.max(1, Math.floor(year / 12) * 12));
  function position() {
    if (!opened || !floating) return;
    const rect = input.getBoundingClientRect(), margin = 12, gap = 6;
    picker.style.width = `${Math.min(320, win.innerWidth - margin * 2)}px`;
    picker.style.maxHeight = `${win.innerHeight - margin * 2}px`;
    const naturalHeight = picker.getBoundingClientRect().height;
    const below = win.innerHeight - rect.bottom - gap - margin, above = rect.top - gap - margin;
    const upward = below < naturalHeight && above > below;
    picker.style.maxHeight = `${Math.max(0, upward ? above : below)}px`;
    const height = picker.getBoundingClientRect().height;
    picker.style.left = `${Math.max(margin, Math.min(rect.left, win.innerWidth - picker.getBoundingClientRect().width - margin))}px`;
    picker.style.top = `${Math.max(margin, upward ? rect.top - gap - height : rect.bottom + gap)}px`;
  }
  function render(focusValue) {
    const selected = calendarDate(input.value), today = iso(new Date());
    yearButton.textContent = view === 'years' ? `${yearStart()} – ${yearStart() + 11}` : `${year}年`;
    yearButton.setAttribute('aria-label', '选择年份'); yearButton.setAttribute('aria-expanded', String(view === 'years'));
    monthButton.textContent = `${month + 1}月`; monthButton.hidden = view === 'years';
    monthButton.setAttribute('aria-label', '选择月份'); monthButton.setAttribute('aria-expanded', String(view === 'months'));
    picker.querySelector('.sql-date-selection').textContent = selected || 'YYYYMMDD';
    picker.querySelectorAll('[data-date-nav]').forEach(button => {
      const previous = button.dataset.dateNav === '-1';
      button.setAttribute('aria-label', `${previous ? '上' : '下'}${view === 'days' ? '个月' : view === 'months' ? '一年' : '一组年份'}`);
      button.disabled = previous ? year <= 1 && (view !== 'days' || month === 0) : year >= 9999 && (view !== 'days' || month === 11);
    });
    grid.replaceChildren(); grid.dataset.view = view;
    grid.setAttribute('aria-label', view === 'days' ? `${year}年${month + 1}月` : view === 'months' ? `${year}年，选择月份` : '选择年份');
    if (view === 'days') {
      const week = doc.createElement('span'); week.className = 'sql-date-week'; week.setAttribute('role', 'row');
      for (const name of ['一', '二', '三', '四', '五', '六', '日']) { const day = doc.createElement('span'); day.textContent = name; day.setAttribute('role', 'columnheader'); week.append(day); }
      grid.append(week);
    }
    const columns = view === 'days' ? 7 : 3, count = view === 'days' ? 42 : 12;
    const first = dateAt(year, month, 1), offset = (first.getDay() + 6) % 7;
    let row;
    for (let i = 0; i < count; i++) {
      if (i % columns === 0) { row = doc.createElement('span'); row.className = 'sql-date-row'; row.setAttribute('role', 'row'); grid.append(row); }
      const button = doc.createElement('button'); button.type = 'button'; button.setAttribute('role', 'gridcell');
      let value, chosen, label;
      if (view === 'days') {
        const date = dateAt(year, month, i - offset + 1); value = iso(date); button.textContent = String(date.getDate());
        label = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
        chosen = value === selected; button.classList.toggle('outside-month', date.getMonth() !== month);
        button.disabled = date.getFullYear() < 1 || date.getFullYear() > 9999;
        if (value === today) { button.setAttribute('aria-current', 'date'); label += '，今天'; }
      } else {
        value = String(view === 'months' ? i : yearStart() + i);
        label = view === 'months' ? `${i + 1}月` : `${value}年`; button.textContent = label;
        chosen = Number(value) === (view === 'months' ? month : year);
      }
      button.dataset.dateValue = value; button.setAttribute('aria-label', label); button.setAttribute('aria-selected', String(chosen));
      button.tabIndex = value === (focusValue ?? (view === 'days' ? iso(cursor) : String(view === 'months' ? month : year))) ? 0 : -1;
      row.append(button);
    }
    if (!grid.querySelector('[tabindex="0"]')) grid.querySelector('button:not(:disabled)').tabIndex = 0;
    if (focusValue != null) grid.querySelector('[tabindex="0"]')?.focus();
    position();
  }
  function close(returnFocus = false) {
    opened = false; listeners?.abort(); input.setAttribute('aria-expanded', 'false');
    if (floating && picker.matches(':popover-open')) picker.hidePopover();
    picker.hidden = true;
    if (returnFocus) { suppressFocus = true; input.focus({ preventScroll: true }); suppressFocus = false; }
  }
  function open() {
    if (opened || suppressFocus || !field.isConnected) return;
    cursor = parse(calendarDate(input.value) || calendarDate(yesterdayBusinessDate())); year = cursor.getFullYear(); month = cursor.getMonth(); view = 'days';
    opened = true; picker.hidden = false; render(); if (floating) picker.showPopover(); position(); input.setAttribute('aria-expanded', 'true');
    listeners = new win.AbortController(); const options = { signal: listeners.signal };
    doc.addEventListener('pointerdown', event => { if (!field.contains(event.target)) close(); }, { ...options, capture: true });
    doc.addEventListener('focusin', event => { if (!field.contains(event.target)) close(); }, options);
    win.addEventListener('resize', position, options); doc.addEventListener('scroll', position, { ...options, capture: true });
    const dialog = input.closest('dialog');
    dialog?.addEventListener('close', () => { if (!dialog.open) close(); }, options);
  }
  function choose(value) {
    if (view === 'years') { year = Number(value); view = 'months'; render(String(month)); return; }
    if (view === 'months') { month = Number(value); cursor = dateAt(year, month, 1); view = 'days'; render(iso(cursor)); return; }
    input.value = value.replaceAll('-', ''); input.dispatchEvent(new win.Event('input', { bubbles: true })); close(true);
  }
  function navigate(direction) {
    if (view === 'days') { const date = dateAt(year, month + direction, 1); year = Math.max(1, Math.min(9999, date.getFullYear())); month = date.getMonth(); cursor = dateAt(year, month, 1); }
    else year = Math.max(1, Math.min(9999, year + direction * (view === 'years' ? 12 : 1)));
    render();
  }
  input.addEventListener('focus', open); input.addEventListener('click', open);
  input.addEventListener('input', () => {
    const value = calendarDate(input.value);
    if (value) { cursor = parse(value); year = cursor.getFullYear(); month = cursor.getMonth(); view = 'days'; }
    if (opened) render();
  });
  input.addEventListener('change', () => { const date = calendarDate(input.value); if (date) input.value = date.replaceAll('-', ''); });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); open(); grid.querySelector('[tabindex="0"]')?.focus(); }
    // Enter finishes manual date entry before a second Enter can submit the form.
    if (event.key === 'Enter' && opened) { event.preventDefault(); event.stopPropagation(); close(); }
  });
  picker.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.hasAttribute('data-date-value')) choose(button.dataset.dateValue);
    else if (button.hasAttribute('data-date-year')) { view = view === 'years' ? 'days' : 'years'; render(); }
    else if (button.hasAttribute('data-date-month')) { view = view === 'months' ? 'days' : 'months'; render(); }
    else if (button.hasAttribute('data-date-nav')) navigate(Number(button.dataset.dateNav));
    else if (button.hasAttribute('data-date-shortcut')) { view = 'days'; choose(button.dataset.dateShortcut === 'yesterday' ? calendarDate(yesterdayBusinessDate()) : iso(new Date())); }
  });
  field.addEventListener('keydown', event => {
    if (!opened || event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const button = event.target.closest('[data-date-value]'); if (!button) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose(button.dataset.dateValue); return; }
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: view === 'days' ? -7 : -3, ArrowDown: view === 'days' ? 7 : 3 };
    if (view === 'days' && ['PageUp', 'PageDown', 'Home', 'End', ...Object.keys(moves)].includes(event.key)) {
      event.preventDefault(); cursor = parse(button.dataset.dateValue);
      if (event.key.startsWith('Page')) {
        const next = dateAt(cursor.getFullYear(), cursor.getMonth() + (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1), 1);
        cursor = dateAt(next.getFullYear(), next.getMonth(), Math.min(cursor.getDate(), dateAt(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
      } else cursor.setDate(cursor.getDate() + (moves[event.key] ?? ((event.key === 'Home' ? 0 : 6) - (cursor.getDay() + 6) % 7)));
      if (cursor.getFullYear() < 1 || cursor.getFullYear() > 9999) return;
      year = cursor.getFullYear(); month = cursor.getMonth(); render(iso(cursor));
    } else if (moves[event.key] != null) {
      event.preventDefault(); const next = Number(button.dataset.dateValue) + moves[event.key];
      if (view === 'months' && next >= 0 && next <= 11 || view === 'years' && next >= 1 && next <= 9999) { if (view === 'years') year = next; render(String(next)); }
    }
  });
  field.append(input, picker); return { element: field, close };
}

// Presentation only; never use this classification to reject a SQL statement.
export function sqlStatementKind(sql) {
  const start = String(sql ?? '').replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  return start.match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0].toUpperCase() || '';
}

export function createParameterMemory(storage) {
  const prefix = 'lemon:sql-params:v1:';
  const key = (snapshot, name) => prefix + JSON.stringify([snapshot.cwd, snapshot.engine, /^param\d+$/.test(name) ? snapshot.sql : '', name]);
  const memory = new Map();
  return {
    get(snapshot, name) {
      const id = key(snapshot, name);
      if (memory.has(id)) return memory.get(id);
      try { const value = storage?.getItem(id); if (value != null && value.length <= 10000) return value; } catch { /* Storage can be disabled. */ }
      return memory.get(id) ?? '';
    },
    save(snapshot, values) {
      for (const [name, value] of Object.entries(values)) {
        const id = key(snapshot, name); memory.set(id, value);
        try { storage?.setItem(id, value); } catch { /* Continue with in-session memory. */ }
      }
    },
    clear(snapshot, names) {
      for (const name of names) { const id = key(snapshot, name); memory.set(id, ''); try { storage?.removeItem(id); } catch { /* Best effort. */ } }
    },
  };
}

function isNameStart(char) {
  return /[A-Za-z_]/.test(char || "");
}

function isNameChar(char) {
  return /[A-Za-z0-9_.-]/.test(char || "");
}

function sqlLiteralPart(value) {
  return String(value ?? "").replace(/'/g, "''");
}

export function extractParams(sql) {
  const names = [];
  const seen = new Set();
  let questionIndex = 0;
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  const add = (name) => {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1] || "";
    const prev = sql[i - 1] || "";

    if (!inSingle && !inDouble && !inBlockComment && char === "-" && next === "-") {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && char === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (char === "$" && next === "{") {
      const end = sql.indexOf("}", i + 2);
      if (end > -1) {
        const name = sql.slice(i + 2, end).trim();
        if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) add(name);
        i = end + 1;
        continue;
      }
    }
    if (char === "{" && next === "{") {
      const end = sql.indexOf("}}", i + 2);
      if (end > -1) {
        const name = sql.slice(i + 2, end).trim();
        if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) add(name);
        i = end + 2;
        continue;
      }
    }

    if (!inDouble && char === "'" && prev !== "\\") {
      inSingle = !inSingle;
      i += 1;
      continue;
    }
    if (!inSingle && char === '"' && prev !== "\\") {
      inDouble = !inDouble;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && char === "?") {
      questionIndex += 1;
      add(`param${questionIndex}`);
      i += 1;
      continue;
    }
    if (
      !inSingle &&
      !inDouble &&
      (char === ":" || char === "@") &&
      isNameStart(next) &&
      !/[A-Za-z0-9_:@.]/.test(prev)
    ) {
      let j = i + 1;
      while (j < sql.length && isNameChar(sql[j])) j += 1;
      add(sql.slice(i + 1, j));
      i = j;
      continue;
    }

    i += 1;
  }

  return names;
}

export function substituteParams(sql, params) {
  let out = "";
  let i = 0;
  let questionIndex = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  const valueFor = (name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new Error(`缺少参数：${name}`);
    }
    return params[name];
  };

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1] || "";
    const prev = sql[i - 1] || "";

    if (!inSingle && !inDouble && !inBlockComment && char === "-" && next === "-") {
      inLineComment = true;
      out += char + next;
      i += 2;
      continue;
    }
    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      out += char;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && char === "/" && next === "*") {
      inBlockComment = true;
      out += char + next;
      i += 2;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        out += char + next;
        i += 2;
      } else {
        out += char;
        i += 1;
      }
      continue;
    }

    if (char === "$" && next === "{") {
      const end = sql.indexOf("}", i + 2);
      if (end > -1) {
        const name = sql.slice(i + 2, end).trim();
        if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
          const value = valueFor(name);
          out += inSingle || inDouble ? sqlLiteralPart(value) : String(value ?? "");
          i = end + 1;
          continue;
        }
      }
    }
    if (char === "{" && next === "{") {
      const end = sql.indexOf("}}", i + 2);
      if (end > -1) {
        const name = sql.slice(i + 2, end).trim();
        if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) {
          const value = valueFor(name);
          out += inSingle || inDouble ? sqlLiteralPart(value) : String(value ?? "");
          i = end + 2;
          continue;
        }
      }
    }

    if (!inDouble && char === "'" && prev !== "\\") {
      inSingle = !inSingle;
      out += char;
      i += 1;
      continue;
    }
    if (!inSingle && char === '"' && prev !== "\\") {
      inDouble = !inDouble;
      out += char;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && char === "?") {
      questionIndex += 1;
      out += String(valueFor(`param${questionIndex}`) ?? "");
      i += 1;
      continue;
    }
    if (
      !inSingle &&
      !inDouble &&
      (char === ":" || char === "@") &&
      isNameStart(next) &&
      !/[A-Za-z0-9_:@.]/.test(prev)
    ) {
      let j = i + 1;
      while (j < sql.length && isNameChar(sql[j])) j += 1;
      out += String(valueFor(sql.slice(i + 1, j)) ?? "");
      i = j;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}
