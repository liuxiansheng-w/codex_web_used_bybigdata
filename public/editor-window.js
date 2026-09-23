const margin = 8;
const viewport = () => ({ width: Math.max(1, window.innerWidth - margin * 2), height: Math.max(1, window.innerHeight - margin * 2) });
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function fitEditorRect(rect, area) {
  const width = clamp(rect.width, Math.min(420, area.width), area.width);
  const height = clamp(rect.height, Math.min(360, area.height), area.height);
  return { x: clamp(rect.x, margin, area.width + margin - width), y: clamp(rect.y, margin, area.height + margin - height), width, height };
}

export function resizeEditorRect(rect, edge, dx, dy, area) {
  const right = rect.x + rect.width, bottom = rect.y + rect.height;
  const minWidth = Math.min(420, area.width), minHeight = Math.min(360, area.height);
  const next = { ...rect };
  if (edge.includes('w')) { next.x = clamp(rect.x + dx, margin, right - minWidth); next.width = right - next.x; }
  if (edge.includes('n')) { next.y = clamp(rect.y + dy, margin, bottom - minHeight); next.height = bottom - next.y; }
  if (edge.includes('e')) next.width = clamp(rect.width + dx, minWidth, area.width + margin - rect.x);
  if (edge.includes('s')) next.height = clamp(rect.height + dy, minHeight, area.height + margin - rect.y);
  return fitEditorRect(next, area);
}

export function createEditorWindow({ pane, handle, maximize, reset, resizeHandles, enabled = () => true }) {
  let rect = null, maximized = false, gesture = null;
  function defaults() {
    const area = viewport(), width = Math.min(920, Math.max(640, area.width * .68));
    return fitEditorRect({ x: window.innerWidth - width - 24, y: 56, width, height: Math.min(760, window.innerHeight - 100) }, area);
  }
  function render() {
    if (!enabled()) return;
    rect ||= defaults();
    const area = viewport(); rect = fitEditorRect(rect, area);
    const shown = maximized ? { x: margin, y: margin, ...area } : rect;
    pane.style.left = `${shown.x}px`; pane.style.top = `${shown.y}px`;
    pane.style.width = `${shown.width}px`; pane.style.height = `${shown.height}px`;
    pane.classList.toggle('is-maximized', maximized);
    maximize.textContent = maximized ? '❐' : '□';
    maximize.title = maximized ? '还原窗口' : '最大化窗口（也可双击标题栏）';
    maximize.setAttribute('aria-label', maximized ? '还原窗口' : '最大化窗口');
    maximize.setAttribute('aria-pressed', String(maximized));
  }
  function finish(cancel = false) {
    if (!gesture) return;
    const old = gesture; gesture = null;
    if (cancel) { rect = old.rect; maximized = old.maximized; }
    if (old.target.hasPointerCapture?.(old.id)) old.target.releasePointerCapture(old.id);
    pane.classList.remove('is-moving'); render();
  }
  function start(event, edge = '') {
    if (!enabled() || event.button !== 0 || gesture || !edge && event.target.closest('button, select, a, input')) return;
    if (edge && maximized) return;
    event.preventDefault(); render();
    const original = { ...rect }, wasMaximized = maximized;
    gesture = { id: event.pointerId, target: event.currentTarget, edge, x: event.clientX, y: event.clientY, start: { ...rect }, rect: original, maximized: wasMaximized };
    event.currentTarget.setPointerCapture(event.pointerId);
    pane.classList.add('is-moving'); render();
  }
  function move(event) {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    // A click/double-click on a maximized title bar must not restore before dblclick fires.
    if (maximized) {
      if (Math.abs(dx) + Math.abs(dy) < 4) return;
      maximized = false;
      gesture.start = fitEditorRect({ ...rect, x: gesture.x - rect.width * (gesture.x / window.innerWidth), y: gesture.y - 24 }, viewport());
    }
    rect = gesture.edge ? resizeEditorRect(gesture.start, gesture.edge, dx, dy, viewport()) : fitEditorRect({ ...gesture.start, x: gesture.start.x + dx, y: gesture.start.y + dy }, viewport());
    render();
  }
  function toggle() { if (!enabled()) return; finish(); maximized = !maximized; render(); }
  for (const target of [handle, ...resizeHandles]) {
    target.addEventListener('pointerdown', event => start(event, target.dataset.edge || ''));
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', event => { if (gesture?.id === event.pointerId) finish(); });
    target.addEventListener('pointercancel', () => finish(true));
    target.addEventListener('lostpointercapture', () => finish());
  }
  handle.addEventListener('dblclick', event => { if (!event.target.closest('button, select, a, input')) toggle(); });
  handle.addEventListener('keydown', event => {
    if (!enabled() || event.target !== handle) return;
    if (event.key === 'Enter') { event.preventDefault(); toggle(); return; }
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!direction || maximized) return;
    event.preventDefault(); render();
    const [dx, dy] = direction.map(n => n * 10);
    rect = event.shiftKey ? resizeEditorRect(rect, 'se', dx, dy, viewport()) : fitEditorRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, viewport());
    render();
  });
  maximize.addEventListener('click', toggle);
  reset.addEventListener('click', () => { if (!enabled()) return; finish(); maximized = false; rect = defaults(); render(); });
  window.addEventListener('resize', () => { finish(); render(); });
  window.addEventListener('blur', () => finish());
  document.addEventListener('keydown', event => { if (gesture && event.key === 'Escape') { event.preventDefault(); finish(true); } });
  return { show: render, hide: () => finish() };
}

export function dockSplit(length, ratio = .56, stacked = false) {
  const total = Math.max(1, length - 8);
  const min = Math.min(stacked ? 260 : 360, total * (stacked ? .35 : .45));
  const max = Math.max(min, total - Math.min(stacked ? 500 : 320, total * (stacked ? .65 : .45)));
  const size = clamp(total * (Number.isFinite(ratio) ? ratio : .56), min, max);
  return { size, total, min, max, ratio: size / total };
}

// Keep the exact same textarea nodes while switching layouts so native undo,
// selection, scrolling and in-flight saves continue to belong to their file.
export function createEditorLayout({ container, divider, modeButton, ...options }) {
  const { pane, handle, maximize, reset } = options;
  let mode = 'docked', ratio = .56, gesture = null, stacked = false;
  try {
    if (localStorage.getItem('codex-desk:editorLayout') === 'floating') mode = 'floating';
    const stored = Number(localStorage.getItem('codex-desk:editorSplit'));
    if (stored > 0 && stored < 1) ratio = stored;
  } catch {}
  const floating = createEditorWindow({ ...options, enabled: () => mode === 'floating' });
  const persist = () => { try { localStorage.setItem('codex-desk:editorLayout', mode); localStorage.setItem('codex-desk:editorSplit', String(ratio)); } catch {} };
  function measure() {
    const rect = container.getBoundingClientRect();
    const width = rect.width || window.innerWidth;
    stacked = width < 740;
    return dockSplit(stacked ? rect.height || window.innerHeight : width, ratio, stacked);
  }
  function render() {
    const docked = mode === 'docked';
    container.classList.toggle('editor-docked', docked); container.classList.toggle('editor-floating', !docked);
    pane.dataset.layout = mode; divider.hidden = !docked || pane.hidden;
    modeButton.textContent = docked ? '浮动窗口' : '平铺页面';
    modeButton.title = docked ? '切换为可拖动的浮动窗口，保留文件与编辑' : '切换为左右平铺，保留文件与编辑';
    modeButton.setAttribute('aria-label', modeButton.title);
    maximize.hidden = docked;
    handle.tabIndex = docked ? -1 : 0;
    handle.title = docked ? '平铺编辑器 · 拖动分隔线调整宽度' : '拖动移动 · 双击最大化';
    handle.setAttribute('aria-label', docked ? '平铺编辑器标题栏' : '浮动编辑器标题栏：拖动移动，回车最大化，方向键移动，Shift 加方向键调整大小');
    reset.title = docked ? '重置平铺比例' : '重置窗口位置和大小'; reset.setAttribute('aria-label', reset.title);
    if (!docked) { container.classList.remove('editor-stacked'); if (!pane.hidden) floating.show(); return; }
    for (const key of ['left', 'top', 'width', 'height']) pane.style[key] = '';
    pane.classList.remove('is-maximized');
    const split = measure();
    container.classList.toggle('editor-stacked', stacked);
    container.style.setProperty('--editor-split-size', `${split.size}px`);
    divider.setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical');
    divider.setAttribute('aria-valuemin', String(Math.round(split.min / split.total * 100)));
    divider.setAttribute('aria-valuemax', String(Math.round(split.max / split.total * 100)));
    divider.setAttribute('aria-valuenow', String(Math.round(split.ratio * 100)));
    divider.setAttribute('aria-valuetext', `编辑器 ${Math.round(split.ratio * 100)}%，对话 ${100 - Math.round(split.ratio * 100)}%`);
    divider.title = stacked ? '拖动调整上下高度 · 双击重置 · 上下方向键微调' : '拖动调整左右宽度 · 双击重置 · 左右方向键微调';
  }
  function finish(cancel = false) {
    if (!gesture) return;
    const previous = gesture; gesture = null;
    if (cancel) ratio = previous.ratio;
    if (divider.hasPointerCapture?.(previous.id)) divider.releasePointerCapture(previous.id);
    container.classList.remove('is-resizing-split'); render(); if (!cancel) persist();
  }
  divider.addEventListener('pointerdown', event => {
    if (gesture || event.button !== 0 || mode !== 'docked' || pane.hidden) return;
    event.preventDefault(); const split = measure();
    gesture = { id: event.pointerId, position: stacked ? event.clientY : event.clientX, ratio, size: split.size, total: split.total, stacked };
    divider.setPointerCapture(event.pointerId); container.classList.add('is-resizing-split');
  });
  divider.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const position = gesture.stacked ? event.clientY : event.clientX;
    const split = dockSplit(gesture.total + 8, (gesture.size + position - gesture.position) / gesture.total, gesture.stacked);
    ratio = split.ratio; render();
  });
  divider.addEventListener('pointerup', event => { if (gesture?.id === event.pointerId) finish(); });
  divider.addEventListener('pointercancel', () => finish(true));
  divider.addEventListener('lostpointercapture', () => finish());
  divider.addEventListener('dblclick', () => { finish(); ratio = .56; render(); persist(); });
  divider.addEventListener('keydown', event => {
    const split = measure(), direction = (stacked ? { ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1 })[event.key];
    if (!direction && !['Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    ratio = event.key === 'Home' ? split.min / split.total : event.key === 'End' ? split.max / split.total : event.key === 'Enter' ? .56 : (split.size + direction * (event.shiftKey ? 50 : 10)) / split.total;
    ratio = dockSplit(split.total + 8, ratio, stacked).ratio; render(); persist();
  });
  modeButton.addEventListener('click', () => { finish(); floating.hide(); mode = mode === 'docked' ? 'floating' : 'docked'; render(); persist(); });
  reset.addEventListener('click', () => { if (mode === 'docked') { finish(); ratio = .56; render(); persist(); } });
  window.addEventListener('resize', () => { finish(); render(); });
  window.addEventListener('blur', () => finish());
  document.addEventListener('keydown', event => { if (gesture && event.key === 'Escape') { event.preventDefault(); finish(true); } });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => render()).observe(container);
  render();
  return { show: render, hide() { finish(); floating.hide(); divider.hidden = true; }, get mode() { return mode; } };
}

export function resultSplit(available, ratio = .45) {
  const total = Math.max(1, available);
  const min = Math.min(200, total * .5), max = Math.max(min, total - Math.min(120, total * .3));
  const size = clamp(total * (Number.isFinite(ratio) ? ratio : .45), min, max);
  return { size, total, min, max, ratio: size / total };
}

// Move the existing results node between its dock and the document. Table state,
// scroll positions and event handlers survive every layout switch.
export function createResultsLayout({ container, pane, divider, handle, modeButton, maximize, reset, expand, resizeHandles, dock, onChange = () => {} }) {
  if (dock) return createBottomResultsLayout({ pane, divider, handle, modeButton, maximize, reset, expand, resizeHandles, dock, onChange });
  let mode = 'docked', ratio = .52, visible = false, expanded = false, gesture = null;
  try {
    if (window.localStorage.getItem('lemon:resultsLayout') === 'floating') mode = 'floating';
    const stored = Number(window.localStorage.getItem('lemon:resultsSplit'));
    if (stored > 0 && stored < 1) ratio = stored;
  } catch {}
  const floating = createEditorWindow({ pane, handle, maximize, reset, resizeHandles, enabled: () => visible && mode === 'floating' });
  const persist = () => { try { window.localStorage.setItem('lemon:resultsLayout', mode); window.localStorage.setItem('lemon:resultsSplit', String(ratio)); } catch {} };
  function relocate(attach) {
    const body = pane.querySelector('.sql-result-body'), top = body?.scrollTop, left = body?.scrollLeft;
    attach();
    if (body) { body.scrollTop = top; body.scrollLeft = left; }
  }
  function measure() {
    let occupied = 8;
    for (const child of container.children) {
      if (child === pane || child === divider || child.id === 'editorBuffers' || child.hidden) continue;
      const style = window.getComputedStyle(child);
      if (style.display !== 'none' && !['absolute', 'fixed'].includes(style.position)) occupied += child.getBoundingClientRect().height;
    }
    return resultSplit((container.getBoundingClientRect().height || window.innerHeight * .75) - occupied, ratio);
  }
  function render() {
    const docked = mode === 'docked';
    pane.hidden = !visible;
    pane.dataset.layout = mode;
    pane.classList.toggle('sql-results-floating', !docked);
    container.classList.toggle('sql-expanded', visible && docked && expanded);
    container.classList.toggle('has-docked-results', visible && docked && !expanded);
    divider.hidden = !visible || !docked || expanded;
    modeButton.textContent = docked ? '独立浮窗' : '放回下方';
    modeButton.title = docked ? '将查询结果独立浮动，可拖动和缩放' : '将查询结果放回编辑器下方';
    modeButton.setAttribute('aria-label', modeButton.title);
    maximize.hidden = reset.hidden = docked;
    expand.hidden = !docked;
    expand.textContent = expanded ? '还原' : '展开';
    expand.setAttribute('aria-expanded', String(expanded));
    handle.tabIndex = docked ? -1 : 0;
    handle.title = docked ? '拖动上方分隔线调整结果高度' : '拖动移动 · 双击最大化';
    handle.setAttribute('aria-label', docked ? '查询结果' : '查询结果浮窗：方向键移动，Shift 加方向键缩放，回车最大化');
    if (!docked) {
      if (pane.parentNode !== document.body) relocate(() => document.body.append(pane));
      if (visible) floating.show();
      return;
    }
    if (pane.parentNode === document.body) relocate(() => divider.after(pane));
    for (const key of ['left', 'top', 'width', 'height']) pane.style[key] = '';
    pane.classList.remove('is-maximized');
    if (!visible || expanded) return;
    const split = measure();
    container.style.setProperty('--sql-results-height', `${split.size}px`);
    divider.setAttribute('aria-valuemin', String(Math.round(split.min / split.total * 100)));
    divider.setAttribute('aria-valuemax', String(Math.round(split.max / split.total * 100)));
    divider.setAttribute('aria-valuenow', String(Math.round(split.ratio * 100)));
    divider.setAttribute('aria-valuetext', `结果占 ${Math.round(split.ratio * 100)}%，${Math.round(split.size)} 像素`);
  }
  function finish(cancel = false) {
    if (!gesture) return;
    const old = gesture; gesture = null;
    if (cancel) ratio = old.ratio;
    if (divider.hasPointerCapture?.(old.id)) divider.releasePointerCapture(old.id);
    container.classList.remove('is-resizing-results');
    render(); if (!cancel) persist();
  }
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0 || gesture || !visible || mode !== 'docked' || expanded) return;
    event.preventDefault(); onChange(); const split = measure();
    gesture = { id: event.pointerId, y: event.clientY, size: split.size, total: split.total, ratio };
    divider.setPointerCapture(event.pointerId); container.classList.add('is-resizing-results');
  });
  divider.addEventListener('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    ratio = resultSplit(gesture.total, (gesture.size + gesture.y - event.clientY) / gesture.total).ratio;
    render();
  });
  divider.addEventListener('pointerup', event => { if (gesture?.id === event.pointerId) finish(); });
  divider.addEventListener('pointercancel', () => finish(true));
  divider.addEventListener('lostpointercapture', () => finish());
  divider.addEventListener('dblclick', () => { finish(); ratio = .52; render(); persist(); });
  divider.addEventListener('keydown', event => {
    if (!visible || mode !== 'docked' || expanded) return;
    const direction = { ArrowUp: 1, ArrowDown: -1 }[event.key], split = measure();
    if (!direction && !['Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault(); onChange();
    const size = event.key === 'Home' ? split.min : event.key === 'End' ? split.max : event.key === 'Enter' ? split.total * .45 : split.size + direction * (event.shiftKey ? 50 : 10);
    ratio = resultSplit(split.total, size / split.total).ratio; render(); persist();
  });
  modeButton.addEventListener('click', () => {
    finish(); floating.hide(); onChange();
    mode = mode === 'docked' ? 'floating' : 'docked'; render(); persist(); modeButton.focus();
  });
  for (const target of [handle, ...resizeHandles]) target.addEventListener('pointerdown', () => { if (mode === 'floating') onChange(); });
  for (const button of [maximize, reset]) button.addEventListener('click', onChange);
  window.addEventListener('resize', () => { finish(); onChange(); render(); });
  window.addEventListener('blur', () => finish());
  document.addEventListener('keydown', event => { if (gesture && event.key === 'Escape') { event.preventDefault(); finish(true); } });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => render()); observer.observe(container);
    for (const child of container.children) if (child !== pane && child !== divider && child.id !== 'editorBuffers') observer.observe(child);
  }
  render();
  return {
    sync(next) { if (visible && !next.visible) { finish(); floating.hide(); } visible = !!next.visible; expanded = !!next.expanded; render(); },
    get mode() { return mode; },
  };
}

// A shared bottom panel owns space, not task state. Tabs hide existing nodes;
// they never rerun commands, rebuild tables or replace editor buffers.
export function createBottomPanel({ surface }) {
  const doc = surface.ownerDocument, win = doc.defaultView;
  const divider = doc.createElement('div'); divider.id = 'bottomPanelDivider'; divider.className = 'bottom-panel-divider';
  divider.setAttribute('role', 'separator'); divider.tabIndex = 0; divider.setAttribute('aria-label', '调整底部面板高度'); divider.setAttribute('aria-orientation', 'horizontal'); divider.setAttribute('aria-controls', 'bottomPanel');
  const panel = doc.createElement('section'); panel.id = 'bottomPanel'; panel.className = 'bottom-panel'; panel.setAttribute('aria-label', '底部工具面板');
  panel.innerHTML = `<header class="bottom-panel-header"><div role="tablist" aria-label="底部面板"><button id="bottomTabTerminal" type="button" role="tab" aria-controls="bottomTerminal" data-bottom-tab="terminal">终端</button><button id="bottomTabResults" type="button" role="tab" aria-controls="bottomResultsHost" data-bottom-tab="results">查询结果</button></div><span class="bottom-panel-spacer"></span><div id="bottomResultControls" class="bottom-result-controls"></div><button id="bottomPanelExpand" class="icon-button" type="button" aria-label="展开底部面板" title="展开底部面板">⌃</button><button id="bottomPanelClose" class="icon-button" type="button" aria-label="收起底部面板" title="收起底部面板">×</button></header><div id="bottomTerminal" class="bottom-terminal" role="tabpanel" aria-labelledby="bottomTabTerminal"></div><div id="bottomResultsHost" class="bottom-results-host" role="tabpanel" aria-labelledby="bottomTabResults"><div id="bottomResultsEmpty" class="bottom-panel-empty"><span>尚无查询结果，在编辑器中执行查询后显示。</span><button id="bottomResultsReturn" class="text-button" type="button" hidden>放回下方</button></div></div>`;
  surface.append(divider, panel); surface.classList.add('has-bottom-panel');
  const $ = id => doc.getElementById(id), tabs = [...panel.querySelectorAll('[data-bottom-tab]')], listeners = new Set();
  let active = 'terminal', open = false, expanded = false, height = 300, gesture = null, available = false, floating = false;
  try { const saved = JSON.parse(win.localStorage.getItem('lemon:bottomPanel') || 'null'); if (saved) { active = saved.tab === 'results' ? 'results' : 'terminal'; open = saved.open === true; if (Number.isFinite(saved.height) && saved.height >= 140 && saved.height <= 1400) height = saved.height; } } catch {}
  function placement() {
    const panes = $('workspacePanes');
    const underEditor = surface.dataset.mode === 'both' && !$('fileEditor')?.hidden && panes?.classList.contains('editor-docked') && !panes.classList.contains('editor-stacked');
    surface.classList.toggle('bottom-under-editor', !!underEditor);
    surface.style.setProperty('--bottom-panel-width', underEditor ? panes.style.getPropertyValue('--editor-split-size') || '56%' : '100%');
    return !!underEditor;
  }
  function bounds() {
    const underEditor = placement();
    const total = surface.getBoundingClientRect().height || win.innerHeight;
    const bar = surface.querySelector('.workspace-bar')?.getBoundingClientRect().height || 48;
    const available = Math.max(36, total - bar);
    const sharesChat = !underEditor && surface.dataset.mode !== 'files';
    const heading = doc.querySelector('.conversation-heading')?.getBoundingClientRect().height || 48;
    const composer = doc.querySelector('.composer-area')?.getBoundingClientRect().height || 180;
    const chatReserve = Math.max(280, heading + composer + 120);
    surface.style.setProperty('--conversation-min-height', `${chatReserve}px`);
    const stacked = surface.dataset.mode === 'both' && $('workspacePanes')?.classList.contains('editor-stacked');
    const reserve = sharesChat ? chatReserve + (stacked ? 152 : 0) : 144;
    const max = Math.max(36, available - reserve - 6);
    return { min: Math.min(180, max), max, full: sharesChat ? max : Math.max(36, available - 84) };
  }
  function persist() { try { win.localStorage.setItem('lemon:bottomPanel', JSON.stringify({ tab: active, open, height })); } catch {} }
  function render() {
    const { min, max, full } = bounds(), size = expanded ? full : clamp(height, min, max);
    surface.style.setProperty('--bottom-panel-height', `${open ? size : 36}px`);
    surface.style.setProperty('--bottom-divider-height', open && !expanded ? '6px' : '0px');
    panel.classList.toggle('is-collapsed', !open); divider.hidden = !open || expanded;
    for (const tab of tabs) { const selected = tab.dataset.bottomTab === active; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }
    $('bottomTerminal').hidden = !open || active !== 'terminal'; $('bottomResultsHost').hidden = !open || active !== 'results';
    $('bottomResultControls').hidden = !open || active !== 'results' || !available || floating;
    $('bottomResultsEmpty').hidden = available && !floating;
    $('bottomResultsEmpty').querySelector('span').textContent = available && floating ? '查询结果已在独立浮窗中打开。' : '尚无查询结果，在编辑器中执行查询后显示。';
    $('bottomResultsReturn').hidden = !available || !floating;
    $('bottomPanelClose').hidden = !open;
    $('bottomPanelExpand').textContent = open && expanded ? '⌄' : '⌃';
    $('bottomPanelExpand').setAttribute('aria-expanded', String(open && expanded));
    $('bottomPanelExpand').setAttribute('aria-label', open && expanded ? '还原底部面板高度' : '展开底部面板');
    $('bottomPanelExpand').title = $('bottomPanelExpand').getAttribute('aria-label');
    divider.setAttribute('aria-valuemin', String(Math.round(min))); divider.setAttribute('aria-valuemax', String(Math.round(max))); divider.setAttribute('aria-valuenow', String(Math.round(size))); divider.setAttribute('aria-valuetext', `${Math.round(size)} 像素`);
  }
  function changed() { render(); persist(); for (const listener of listeners) listener(); }
  function show(tab) { active = tab === 'results' ? 'results' : 'terminal'; open = true; changed(); }
  for (const tab of tabs) {
    tab.addEventListener('click', () => show(tab.dataset.bottomTab));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs[(tabs.indexOf(tab) + 1) % 2]; show(next.dataset.bottomTab); next.focus();
    });
  }
  $('bottomPanelClose').addEventListener('click', () => { open = false; changed(); tabs.find(tab => tab.dataset.bottomTab === active).focus(); });
  $('bottomPanelExpand').addEventListener('click', () => { expanded = open ? !expanded : false; open = true; changed(); });
  function finish(cancel = false) {
    if (!gesture) return; const old = gesture; gesture = null; if (cancel) height = old.height;
    if (divider.hasPointerCapture?.(old.id)) divider.releasePointerCapture(old.id); surface.classList.remove('is-resizing-bottom'); changed();
  }
  divider.addEventListener('pointerdown', event => { if (event.button !== 0 || gesture) return; event.preventDefault(); const {min,max}=bounds(); gesture = {id:event.pointerId,y:event.clientY,start:clamp(height,min,max),height}; divider.setPointerCapture(event.pointerId); surface.classList.add('is-resizing-bottom'); });
  divider.addEventListener('pointermove', event => { if (gesture?.id !== event.pointerId) return; const {min,max}=bounds(); height=clamp(gesture.start+gesture.y-event.clientY,min,max); render(); });
  divider.addEventListener('pointerup', () => finish()); divider.addEventListener('pointercancel', () => finish(true)); divider.addEventListener('lostpointercapture', () => finish());
  divider.addEventListener('dblclick', () => { finish(); height=300; expanded=false; changed(); });
  divider.addEventListener('keydown', event => { const direction={ArrowUp:1,ArrowDown:-1}[event.key]; if (!direction && !['Home','End','Enter'].includes(event.key)) return; event.preventDefault(); const {min,max}=bounds(); height=event.key==='Home'?min:event.key==='End'?max:event.key==='Enter'?300:clamp(height,min,max)+direction*(event.shiftKey?50:10); height=clamp(height,min,max); changed(); });
  doc.addEventListener('keydown', event => { if (gesture && event.key==='Escape') {event.preventDefault();finish(true);} });
  win.addEventListener('blur', () => finish()); win.addEventListener('resize', () => { finish(); render(); });
  // Split resizing, editor docking and layout switches only change geometry.
  // Keep all editor/chat/result nodes in place, including native undo buffers.
  if (win.MutationObserver) {
    const observer = new win.MutationObserver(render);
    observer.observe(surface, { attributes: true, attributeFilter: ['data-mode'] });
    if ($('workspacePanes')) observer.observe($('workspacePanes'), { attributes: true, attributeFilter: ['class', 'style'] });
    if ($('fileEditor')) observer.observe($('fileEditor'), { attributes: true, attributeFilter: ['hidden'] });
  }
  if (win.ResizeObserver) {
    const observer = new win.ResizeObserver(render);
    observer.observe(surface);
    const composer = doc.querySelector('.composer-area'); if (composer) observer.observe(composer);
  }
  render();
  return {
    show, close() { open=false; changed(); }, visible(tab) { return open && active===tab; },
    get activeTab() { return active; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    attachTerminal(node) { node.hidden=false; node.removeAttribute('role'); node.removeAttribute('aria-labelledby'); $('bottomTerminal').append(node); },
    get resultsHost() { return $('bottomResultsHost'); },
    get resultsControls() { return $('bottomResultControls'); },
    updateResults(next) { const differs=available!==next.available || floating!==next.floating; available=next.available; floating=next.floating; if (differs) render(); },
    onReturn(fn) { $('bottomResultsReturn').onclick=fn; },
  };
}

function createBottomResultsLayout({ pane, divider, handle, modeButton, maximize, reset, expand, resizeHandles, dock, onChange }) {
  let mode='docked', visible=false;
  try { if (window.localStorage.getItem('lemon:resultsLayout')==='floating') mode='floating'; } catch {}
  const floating=createEditorWindow({pane,handle,maximize,reset,resizeHandles,enabled:()=>visible && mode==='floating'});
  function render() {
    const isFloating=mode==='floating'; dock.updateResults({available:visible,floating:isFloating});
    const parent=isFloating?document.body:dock.resultsHost;
    const headerParent=isFloating?pane:dock.resultsControls;
    if(handle.parentNode!==headerParent) { if(isFloating)pane.prepend(handle);else headerParent.append(handle); }
    if (pane.parentNode!==parent) { const body=pane.querySelector('.sql-result-body'),top=body?.scrollTop,left=body?.scrollLeft; parent.append(pane); if(body){body.scrollTop=top;body.scrollLeft=left;} }
    pane.hidden=!visible || (!isFloating && !dock.visible('results')); pane.dataset.layout=mode; pane.classList.toggle('sql-results-floating',isFloating);
    divider.hidden=true; maximize.hidden=reset.hidden=!isFloating; expand.hidden=true;
    modeButton.textContent=isFloating?'放回下方':'独立浮窗'; modeButton.title=isFloating?'将查询结果放回底部面板':'将查询结果独立浮动，可拖动和缩放'; modeButton.setAttribute('aria-label',modeButton.title);
    handle.tabIndex=isFloating?0:-1; handle.setAttribute('aria-label',isFloating?'查询结果浮窗：方向键移动，Shift 加方向键缩放，回车最大化':'查询结果');
    if(isFloating) { if(visible) floating.show(); }
    else { for(const key of ['left','top','width','height']) pane.style[key]=''; pane.classList.remove('is-maximized'); }
  }
  function toggle() { floating.hide(); mode=mode==='docked'?'floating':'docked'; try{window.localStorage.setItem('lemon:resultsLayout',mode);}catch{} onChange(); render(); if(mode==='docked')dock.show('results'); }
  modeButton.addEventListener('click',toggle); dock.onReturn(toggle); dock.subscribe(()=>{onChange();render();});
  for(const target of [handle,...resizeHandles]) target.addEventListener('pointerdown',()=>{if(mode==='floating')onChange();});
  for(const target of [maximize,reset]) target.addEventListener('click',onChange);
  render();
  return {sync(next){if(visible && !next.visible)floating.hide();visible=!!next.visible;render();},get mode(){return mode;}};
}
