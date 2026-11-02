import { createEditorWindow } from './editor-window.js';
import { fileChangeLines, activityState } from './execution-view.js';
import { projectPath } from './project-paths.js';
import { highlightFileLines } from './vendor/markdown/document.js';
import { currentRequest } from './message-timing.js';

const set = (node, value = '') => { if (node.textContent !== String(value)) node.textContent = String(value); };
const storageKey = 'codex-desk:liveEdits';

export function highlightPatchRows(rows, path) {
  const html = new Map(); let group = [], limited = false;
  const color = entries => {
    const result = highlightFileLines(entries.map(({ row }) => row.text).join('\n'), path);
    limited ||= result.limited; return result.lines;
  };
  function flush() {
    const next = group.filter(({ row }) => row.kind !== 'remove'), old = group.filter(({ row }) => row.kind !== 'add');
    if (next.length) color(next).forEach((line, i) => html.set(next[i].index, line));
    if (group.some(({ row }) => row.kind === 'remove')) color(old).forEach((line, i) => { if (old[i].row.kind === 'remove') html.set(old[i].index, line); });
    group = [];
  }
  if (rows.every(row => row.kind === 'meta')) color(rows.map((row, index) => ({ row, index }))).forEach((line, index) => html.set(index, line));
  else {
    for (const [index, row] of rows.entries()) {
      if (['add', 'remove', 'context'].includes(row.kind)) group.push({ row, index });
      else flush();
    }
    flush();
  }
  return { html, limited };
}

// One latest proposal per path, scoped to the most recent user message.
// No disk reads, patch application, timers or editor buffer access.
export function liveEditFiles(thread, request = currentRequest(thread)) {
  const files = new Map(), turnId = request?.turnId;
  if (!turnId || request.user?.pending) return [];
  for (const item of request.items) {
    if (item.type !== 'fileChange' || item.turnId !== turnId) continue;
    for (const change of item.changes || []) {
      if (typeof change.path !== 'string' || !change.path) continue;
      files.set(change.path, { ...change, item, label: projectPath(change.path, thread.cwd) || change.path });
    }
  }
  return [...files.values()];
}

// Build the directory from received paths, including files whose tabs were
// closed. Disclosures and file buttons survive patch updates and new entries.
function createEditDirectory(document, onSelect) {
  const tree = document.getElementById('liveEditsTree'), project = document.getElementById('liveEditsProject');
  const views = new Map(); let revealed = '';
  function sync(files, cwd = '') {
    const root = { children: new Map() }, base = cwd.replace(/\/+$/, '');
    set(project, base.split('/').at(-1) || '当前项目'); project.title = cwd;
    for (const file of files) {
      const path = file.movePath || file.path;
      const inside = !!base && path.startsWith(`${base}/`), relative = inside ? path.slice(base.length + 1) : path;
      const outside = !inside && (path.startsWith('/') || path.split('/').includes('..'));
      const parts = relative.split('/').filter(Boolean); const name = parts.pop() || path;
      let parent = root, prefix = outside ? 'external' : 'project';
      if (outside) parts.unshift('项目外');
      for (const part of parts) {
        prefix += `/${part}`;
        const key = `directory:${prefix}`;
        if (!parent.children.has(key)) parent.children.set(key, { key, name: part, children: new Map() });
        parent = parent.children.get(key);
      }
      const key = `file:${file.path}`;
      parent.children.set(key, { key, name, file, location: path });
    }
    const seen = new Set();
    function render(parent, host) {
      const entries = [...parent.children.values()].sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
      let cursor = host.firstChild;
      for (const entry of entries) {
        seen.add(entry.key); let view = views.get(entry.key);
        if (!view) {
          if (entry.file) {
            const el = document.createElement('button'); el.type = 'button'; el.className = 'live-edits-tree-file';
            const dot = document.createElement('span'), name = document.createElement('span'), badge = document.createElement('small');
            dot.className = 'live-edit-dot'; dot.setAttribute('aria-hidden', 'true'); name.className = 'live-edits-tree-name';
            badge.textContent = '已关闭'; el.append(dot, name, badge); el.dataset.path = entry.file.path;
            el.addEventListener('click', () => onSelect(entry.file.path)); view = { el, name, badge };
          } else {
            const el = document.createElement('details'), name = document.createElement('summary'), children = document.createElement('div');
            el.className = 'live-edits-directory'; children.className = 'live-edits-directory-children'; el.open = true;
            el.append(name, children); view = { el, name, children };
          }
          views.set(entry.key, view);
        }
        set(view.name, entry.name);
        if (view.el !== cursor) host.insertBefore(view.el, cursor); else cursor = cursor.nextSibling;
        if (entry.file) { view.location = entry.location; view.el.title = entry.location; view.el.dataset.status = entry.file.item.status; }
        else render(entry, view.children);
      }
    }
    render(root, tree);
    for (const [key, view] of views) if (!seen.has(key)) { view.el.remove(); views.delete(key); }
    document.getElementById('liveEditsTreeEmpty').hidden = files.length > 0;
  }
  function mark(active, closed) {
    for (const [key, view] of views) {
      if (!key.startsWith('file:')) continue;
      const path = key.slice(5), selected = path === active;
      if (selected) view.el.setAttribute('aria-current', 'true'); else view.el.removeAttribute('aria-current');
      view.badge.hidden = !closed.has(path); view.el.classList.toggle('is-closed', closed.has(path));
    }
    const view = views.get(`file:${active}`), key = view ? `${active}\n${view.location}` : '';
    if (key && key !== revealed) {
      for (let parent = view.el.parentElement; parent && parent !== tree; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      view.el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    revealed = key;
  }
  return { sync, mark, reset() { views.clear(); tree.replaceChildren(); revealed = ''; } };
}

export function createLiveEdits({ document = globalThis.document, storage = globalThis.localStorage, getContext, onOpen = async () => {} }) {
  const $ = id => document.getElementById(id), pane = $('liveEditsWindow'), toggle = $('liveEditsToggle');
  const tabs = $('liveEditsTabs'), body = $('liveEditsBody'), lines = $('liveEditsLines'), hint = $('liveEditsHint');
  const status = $('liveEditsStatus'), follow = $('liveEditsFollow'), scroll = $('liveEditsScroll'), diff = $('liveEditsDiff');
  const tabViews = new Map(), scrolls = new Map(), closed = new Set();
  let enabled = false, scope = '', active = '', following = true, showDiff = false, current = [], signature = '', rowViews = [], counter = 0;
  let previousFiles = new Map(), pending = false, lastContext, latestPath = '', autoScroll = true, lastScrollTop = 0, observedScope = '';
  const directory = createEditDirectory(document, path => { closed.delete(path); sync(path); });
  const openFiles = () => current.filter(file => !closed.has(file.path));
  try { enabled = storage?.getItem(storageKey) === 'true'; } catch {}
  const floating = createEditorWindow({ pane, handle: $('liveEditsHandle'), maximize: $('liveEditsMaximize'), reset: $('liveEditsReset'), resizeHandles: pane.querySelectorAll('.editor-resize'), enabled: () => enabled });
  const selectionInside = () => { const selection = document.getSelection(); return selection && !selection.isCollapsed && (body.contains(selection.anchorNode) || body.contains(selection.focusNode)); };
  const saveScroll = () => { if (active) scrolls.set(active, { top: body.scrollTop, left: body.scrollLeft, autoScroll }); };
  const scrollLabel = () => { set(scroll, `自动滚动：${autoScroll ? '开' : '暂停'}`); scroll.setAttribute('aria-pressed', String(autoScroll)); };
  function position(top, left = body.scrollLeft) { body.scrollTop = top; body.scrollLeft = left; lastScrollTop = body.scrollTop; saveScroll(); }
  function pauseScroll() { autoScroll = false; scrollLabel(); saveScroll(); }
  function select(path, manual = false) {
    saveScroll();
    if (path !== active && selectionInside()) document.getSelection().removeAllRanges();
    if (manual) following = false;
    const saved = scrolls.get(path); autoScroll = manual ? saved?.autoScroll ?? true : true;
    active = path; signature = ''; paint();
    position(autoScroll ? body.scrollHeight : saved?.top || 0, saved?.left || 0);
    tabViews.get(path)?.button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  function closeTab(path) {
    const opened = openFiles(), index = opened.findIndex(file => file.path === path);
    if (index < 0) return;
    const wasActive = active === path, view = tabViews.get(path), hadFocus = view?.el.contains(document.activeElement);
    if (wasActive) saveScroll();
    closed.add(path); view?.el.remove(); tabViews.delete(path);
    if (wasActive) select(opened[index + 1]?.path || opened[index - 1]?.path || '', true);
    sync();
    if (hadFocus) (tabViews.get(active)?.button || document.querySelector('#liveEditsTree button') || follow).focus();
  }
  function paint() {
    const file = current.find(entry => entry.path === active), { thread, live } = lastContext || {};
    const waiting = file && thread?.requests?.some(request => request.params?.itemId === file.item.id);
    const state = file ? activityState({ ...file.item, turnStatus: thread?.busy ? 'inProgress' : thread?.completion }, { live, waiting, active: !!thread?.busy }) : 'empty';
    pane.dataset.executionState = state;
    $('liveEditsOpen').disabled = !file || !projectPath(file.movePath || file.path, thread?.cwd);
    $('liveEditsOpen').textContent = file?.kind === 'delete' ? '查看删除差异' : '打开当前文件';
    set(status, file ? ({ running: file.item.patchStreaming ? '正在接收编辑内容' : '正在编辑', waiting: '等待审批 · 尚未确认写入', completed: '此文件修改已完成', failed: '修改失败 · 写入结果需核对', interrupted: '修改已中断', unknown: '连接恢复后核对状态' })[state] || '状态待同步' : current.length ? '文件标签已关闭，可从左侧重新打开' : !thread ? '选择一个对话开始跟随' : !live ? '连接恢复后继续跟随' : thread.busy ? '等待本次提问的文件修改…' : '等待新任务，开始后显示编辑内容');
    set(follow, following ? '跟随文件：开' : '跟随文件：关'); follow.setAttribute('aria-pressed', String(following)); scrollLabel();
    diff.setAttribute('aria-pressed', String(showDiff));
    for (const [path, view] of tabViews) { const selected = path === active; view.el.classList.toggle('is-active', selected); view.button.setAttribute('aria-selected', String(selected)); view.button.tabIndex = view.close.tabIndex = selected ? 0 : -1; if (selected) body.setAttribute('aria-labelledby', view.button.id); }
    directory.mark(active, closed);
    set($('liveEditsPath'), file ? file.movePath ? `${file.label} → ${file.movePath}` : file.label : current.length ? '从左侧目录选择文件查看修改' : 'AI 编辑的文件会出现在这里');
    if (!file) { lines.replaceChildren(); rowViews = []; signature = ''; pending = false; body.removeAttribute('aria-labelledby'); set(hint, current.length ? '关闭标签只隐藏预览，AI 会继续编辑；点击目录中的文件可重新打开。' : '开启后，收到文件修改内容即显示。'); return; }
    const nextSignature = JSON.stringify([file.path, file.movePath, file.item.id, file.diff, showDiff]);
    if (signature === nextSignature) return;
    // Do not destroy text a user is selecting while a patch is replaced.
    if (selectionInside()) { pending = true; set(hint, '已收到新内容 · 取消文本选区后更新'); return; }
    pending = false;
    const oldTop = body.scrollTop, oldLeft = body.scrollLeft;
    const parsed = fileChangeLines(file.diff), rows = showDiff || file.kind === 'delete' ? parsed.rows : parsed.rows.filter(row => row.kind !== 'remove');
    const highlighted = highlightPatchRows(rows, file.movePath || file.path);
    while (rowViews.length > rows.length) rowViews.pop().el.remove();
    for (const [index, row] of rows.entries()) {
      let view = rowViews[index];
      if (!view) {
        const el = document.createElement('div'); el.className = 'live-edit-line';
        const number = document.createElement('span'), sign = document.createElement('span'), code = document.createElement('span');
        number.className = 'live-edit-number'; sign.className = 'live-edit-sign'; code.className = 'live-edit-code';
        number.setAttribute('aria-hidden', 'true'); sign.setAttribute('aria-hidden', 'true'); el.append(number, sign, code); lines.append(el);
        view = { el, number, sign, code }; rowViews.push(view);
      }
      view.el.dataset.kind = row.kind;
      set(view.number, row.newLine ?? row.oldLine ?? ''); set(view.sign, showDiff || file.kind === 'delete' ? row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : '' : '');
      const text = row.text || ' ', html = highlighted.html.get(index);
      // Only locally generated, escaped syntax spans enter this read-only node.
      if (html !== undefined) { if (view.html !== html) view.code.innerHTML = html || ' '; }
      else if (view.html !== undefined || view.code.textContent !== text) set(view.code, text);
      view.html = html;
    }
    signature = nextSignature;
    set(hint, !rows.length ? '等待运行时提供文本修改内容…' : `本次修改片段${file.kind === 'delete' ? ' · 删除内容' : showDiff ? ' · 增删对照' : ' · 新内容与上下文'}${parsed.truncated ? ' · 仅前 3,000 行 / 200,000 字符' : ''}${highlighted.limited ? ' · 长片段以纯文本显示' : ''}`);
    position(autoScroll ? body.scrollHeight : oldTop, oldLeft);
  }
  function sync(selectedPath) {
    if (!enabled) return;
    lastContext = getContext(); const { thread } = lastContext;
    const request = currentRequest(thread), nextScope = JSON.stringify([thread?.id, thread?.cwd, request.key]);
    if (scope !== nextScope) {
      scope = nextScope; observedScope = ''; active = ''; latestPath = ''; signature = ''; previousFiles.clear(); scrolls.clear(); closed.clear(); directory.reset(); tabViews.clear(); tabs.replaceChildren(); lines.replaceChildren(); rowViews = []; pending = false; following = true; autoScroll = true; lastScrollTop = 0;
    }
    if (thread?.busy && request.turnId && request.turnId === thread.turnId && !request.user?.pending) observedScope = nextScope;
    current = observedScope === nextScope ? liveEditFiles(thread, request) : [];
    directory.sync(current, thread?.cwd);
    const opened = openFiles(), paths = new Set(opened.map(file => file.path));
    for (const [path, view] of tabViews) if (!paths.has(path)) { view.el.remove(); tabViews.delete(path); }
    const knownPaths = new Set(current.map(file => file.path));
    for (const path of scrolls.keys()) if (!knownPaths.has(path)) scrolls.delete(path);
    let latest = '', cursor = tabs.firstChild;
    for (const file of opened) {
      const key = JSON.stringify([file.item.id, file.diff, file.movePath]);
      if (previousFiles.get(file.path) !== key) latest = file.path;
      let view = tabViews.get(file.path);
      if (!view) {
        const el = document.createElement('div'); el.className = 'live-edit-tab'; el.setAttribute('role', 'presentation');
        const button = document.createElement('button'); button.className = 'live-edit-tab-select'; button.type = 'button'; button.role = 'tab'; button.id = `live-edit-tab-${++counter}`; button.setAttribute('aria-controls', body.id);
        const name = document.createElement('span'), dot = document.createElement('span'); dot.className = 'live-edit-dot'; dot.setAttribute('aria-hidden', 'true'); button.append(dot, name);
        const close = document.createElement('button'); close.type = 'button'; close.className = 'live-edit-tab-close'; close.textContent = '×';
        close.addEventListener('click', () => closeTab(file.path));
        button.addEventListener('click', () => select(file.path, true)); el.append(button, close); tabs.append(el); view = { el, button, name, close }; tabViews.set(file.path, view);
      }
      const label = file.movePath ? projectPath(file.movePath, thread.cwd) || file.movePath : file.label;
      set(view.name, label.split('/').at(-1)); view.button.title = label; view.button.dataset.status = file.item.status;
      view.close.setAttribute('aria-label', `关闭文件标签：${label}`); view.close.title = `关闭 ${label}`;
      if (view.el !== cursor) tabs.insertBefore(view.el, cursor); else cursor = cursor.nextSibling;
    }
    previousFiles = new Map(current.map(file => [file.path, JSON.stringify([file.item.id, file.diff, file.movePath])]));
    if (latest) latestPath = latest;
    if (paths.has(selectedPath)) select(selectedPath, true);
    else if (!paths.has(active)) select(latest || opened[0]?.path || '');
    else if (following && autoScroll && latest && latest !== active && !selectionInside() && !tabs.contains(document.activeElement)) select(latest);
    else paint();
    set($('liveEditsCount'), current.length ? opened.length === current.length ? `${current.length} 个文件` : `${opened.length}/${current.length} 个文件` : '');
  }
  function changeEnabled(value) {
    enabled = value; pane.hidden = !enabled; toggle.setAttribute('aria-pressed', String(enabled)); set(toggle, `AI 编辑浮窗：${enabled ? '开' : '关'}`);
    try { storage?.setItem(storageKey, String(enabled)); } catch {}
    if (enabled) { floating.show(); sync(); if (autoScroll && !selectionInside()) position(body.scrollHeight); } else { observedScope = ''; floating.hide(); }
  }
  toggle.addEventListener('click', () => changeEnabled(!enabled));
  $('liveEditsClose').addEventListener('click', () => { changeEnabled(false); toggle.focus(); });
  follow.addEventListener('click', () => { following = !following; const opened = openFiles(); if (following && opened.length) select(opened.some(file => file.path === latestPath) ? latestPath : opened.at(-1).path); else paint(); });
  scroll.addEventListener('click', () => { autoScroll = !autoScroll; scrollLabel(); if (autoScroll && !selectionInside()) position(body.scrollHeight); else saveScroll(); });
  diff.addEventListener('click', () => { showDiff = !showDiff; paint(); });
  body.addEventListener('scroll', () => {
    if (body.scrollTop === lastScrollTop) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 8;
    if (body.scrollTop < lastScrollTop && !atBottom) autoScroll = false;
    else if (body.scrollTop > lastScrollTop && atBottom) autoScroll = true;
    lastScrollTop = body.scrollTop; scrollLabel(); saveScroll();
  });
  body.addEventListener('wheel', event => { if (event.deltaY < 0 && !event.ctrlKey && !event.shiftKey) pauseScroll(); }, { passive: true });
  body.addEventListener('keydown', event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) pauseScroll(); });
  const resizeObserver = document.defaultView?.ResizeObserver && new document.defaultView.ResizeObserver(() => { if (enabled && autoScroll && !selectionInside()) position(body.scrollHeight); });
  resizeObserver?.observe(body);
  tabs.addEventListener('keydown', event => {
    if (event.key === 'Delete' && active) { event.preventDefault(); closeTab(active); return; }
    const opened = openFiles();
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !opened.length) return;
    event.preventDefault(); const index = opened.findIndex(file => file.path === active), next = event.key === 'Home' ? 0 : event.key === 'End' ? opened.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + opened.length) % opened.length;
    select(opened[next].path, true); tabViews.get(active)?.button.focus();
  });
  $('liveEditsOpen').addEventListener('click', async () => { const file = current.find(item => item.path === active); if (!file) return; try { await onOpen(file, lastContext.thread); } catch (error) { set(hint, error.message); } });
  document.addEventListener('selectionchange', () => { if (enabled && pending && !selectionInside()) paint(); });
  pane.addEventListener('keydown', event => { if (event.key === 'Escape' && !pane.classList.contains('is-moving')) { event.stopPropagation(); changeEnabled(false); toggle.focus(); } });
  changeEnabled(enabled);
  return { sync };
}
