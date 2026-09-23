import { detectLanguage, highlightCode, findCodeMatches, markCodeMatches } from './code-highlight.js';
import { createEditorLayout } from './editor-window.js';
import { popupLayout } from './interactions.js';
import { markdown } from './markdown.js';
import { enhanceMarkdown } from './markdown-preview.js';

const $ = id => document.getElementById(id);
const sessionKey = 'lemon:openFiles:v1';
const positionNumber = value => Number.isFinite(value) ? Math.max(0, Math.min(1e9, Math.floor(value))) : 0;
const validRoot = value => typeof value === 'string' && value.startsWith('/') && value.length < 4096 && !value.includes('\0');
const validFile = value => typeof value === 'string' && value.length > 0 && value.length < 4096 && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..');
const markdownFile = path => /\.(md|markdown|mdown)$/i.test(path || '');
const markdownPreview = doc => !!doc?.markdown && doc.markdown.mode === 'preview';
const markdownPosition = state => ({ mode: state?.mode === 'source' ? 'source' : 'preview', top: positionNumber(state?.top), left: positionNumber(state?.left) });

// Resolve document-relative links within the existing project boundary only.
export function resolveMarkdownLink(target, entry) {
  let decoded;
  try { decoded = decodeURIComponent(target); } catch { throw new Error('文件链接编码无效。'); }
  if (/[\x00-\x1f\x7f\\]/.test(decoded) || decoded.startsWith('//')) throw new Error('文件链接无效。');
  const match = decoded.match(/^(.*?)(?::(\d+)|#(.*))?$/);
  let path = match[1];
  if (/^[a-zA-Z][\w+.-]*:/.test(path)) throw new Error('不支持此文件链接。');
  const root = entry.cwd.replace(/\/$/, '');
  const parts = path.startsWith('/') ? [] : entry.path.split('/').slice(0, -1);
  if (path.startsWith('/')) {
    if (!path.startsWith(root + '/')) throw new Error('此文件不在当前项目中，请先切换项目。');
    path = path.slice(root.length + 1);
  }
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('此文件不在当前项目中。'); parts.pop(); }
    else parts.push(part);
  }
  path = parts.join('/');
  if (!validFile(path)) throw new Error('文件链接无效。');
  return { cwd: entry.cwd, path, line: Number(match[2] || match[3]?.match(/^L(\d+)$/)?.[1] || 0), anchor: match[3] || '' };
}

// Conservative line-based three-way merge. Unique unchanged lines anchor edits;
// ambiguous/repeated regions remain one change and are never guessed apart.
const textLines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
function lineChanges(base, target) {
  const edits = [], tasks = [[0, base.length, 0, target.length]]; let budget = 200000;
  while (tasks.length) {
    let [a, endA, b, endB] = tasks.pop();
    while (a < endA && b < endB && base[a] === target[b]) { a++; b++; }
    while (a < endA && b < endB && base[endA - 1] === target[endB - 1]) { endA--; endB--; }
    if (a === endA && b === endB) continue;
    const fallback = () => edits.push({ start: a, end: endA, lines: target.slice(b, endB) });
    budget -= endA - a + endB - b;
    if (a === endA || b === endB || budget < 0) { fallback(); continue; }
    const left = new Map(), right = new Map();
    for (let i = a; i < endA; i++) left.set(base[i], left.has(base[i]) ? -1 : i);
    for (let i = b; i < endB; i++) right.set(target[i], right.has(target[i]) ? -1 : i);
    const pairs = [...left].filter(([line, i]) => i >= 0 && right.has(line) && right.get(line) >= 0).map(([line, i]) => [i, right.get(line)]);
    // Longest increasing chain keeps anchors in source order on both sides.
    const tails = [], previous = [];
    for (let i = 0; i < pairs.length; i++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (pairs[tails[mid]][1] < pairs[i][1]) lo = mid + 1; else hi = mid; }
      previous[i] = lo ? tails[lo - 1] : -1; tails[lo] = i;
    }
    if (!tails.length) { fallback(); continue; }
    const anchors = []; for (let i = tails.at(-1); i >= 0; i = previous[i]) anchors.push(pairs[i]); anchors.reverse();
    for (const [nextA, nextB] of anchors) { tasks.push([a, nextA, b, nextB]); a = nextA + 1; b = nextB + 1; }
    tasks.push([a, endA, b, endB]);
  }
  return edits.sort((a, b) => a.start - b.start || a.end - b.end);
}
export function mergeEditorChanges(baseline, local, disk) {
  if (local === disk || local === baseline) return disk;
  if (disk === baseline) return local;
  const base = textLines(baseline), ours = lineChanges(base, textLines(local)), theirs = lineChanges(base, textLines(disk));
  const counts = new Map(); for (const line of base) counts.set(line, (counts.get(line) || 0) + 1);
  // A deletion in repeated source can have multiple equally valid alignments.
  // Leave those cases for comparison instead of applying edits to the wrong copy.
  if ([...ours, ...theirs].some(edit => edit.end - edit.start !== edit.lines.length && base.slice(edit.start, edit.end).some(line => counts.get(line) > 1))) return null;
  const merged = [...ours]; let first = 0;
  for (const remote of theirs) {
    while (first < ours.length && ours[first].end < remote.start) first++;
    let duplicate = false;
    for (let i = first; i < ours.length && ours[i].start <= remote.end; i++) {
      const own = ours[i];
      if (own.start === remote.start && own.end === remote.end && own.lines.join('') === remote.lines.join('')) { duplicate = true; continue; }
      const overlap = own.start === own.end || remote.start === remote.end
        ? own.start <= remote.end && remote.start <= own.end
        : own.start < remote.end && remote.start < own.end;
      if (overlap) return null;
    }
    if (!duplicate) merged.push(remote);
  }
  merged.sort((a, b) => a.start - b.start || a.end - b.end);
  const result = []; let cursor = 0;
  for (const edit of merged) { result.push(base.slice(cursor, edit.start).join(''), edit.lines.join('')); cursor = edit.end; }
  result.push(base.slice(cursor).join('')); return result.join('');
}

function relocatedSelection(before, after, positions) {
  const lines = textLines(before), offsets = [0]; for (const line of lines) offsets.push(offsets.at(-1) + line.length);
  const edits = lineChanges(lines, textLines(after));
  return positions.map(position => {
    let delta = 0;
    for (const edit of edits) {
      const start = offsets[edit.start], end = offsets[edit.end], length = edit.lines.join('').length;
      if (position < start) break;
      if (position < end) return start + delta + Math.min(position - start, length);
      delta += length - (end - start);
    }
    return Math.min(after.length, position + delta);
  });
}
function readingPosition(state = {}) {
  const sheets = {};
  for (const [key, value] of Object.entries(state.sheets || {})) if (/^\d{1,2}$/.test(key) && value) sheets[key] = { page: positionNumber(value.page), top: positionNumber(value.top), left: positionNumber(value.left), ...([50, 100, 200].includes(value.pageSize) ? { pageSize: value.pageSize } : {}) };
  return { page: Math.max(1, positionNumber(state.page)), sheet: Math.min(99, positionNumber(state.sheet)), zoom: ['fit', '0.75', '1', '1.5', '2'].includes(state.zoom) ? state.zoom : 'fit', top: positionNumber(state.top), left: positionNumber(state.left), sheets };
}

// Store navigation metadata only. File contents and drafts use separate policies.
export function normalizeEditorSession(value) {
  if (value?.version !== 1 || !Array.isArray(value.files) || !Array.isArray(value.projects)) return { version: 1, files: [], projects: [] };
  const files = new Map(), projects = new Map();
  for (const file of value.files) {
    if (!file || !validRoot(file.cwd) || !validFile(file.path)) continue;
    files.set(JSON.stringify([file.cwd, file.path]), { cwd: file.cwd, path: file.path, language: ['auto', 'sql', 'python', 'text'].includes(file.language) ? file.language : 'auto', start: positionNumber(file.start), end: positionNumber(file.end), direction: ['forward', 'backward'].includes(file.direction) ? file.direction : 'none', top: positionNumber(file.top), left: positionNumber(file.left), preview: readingPosition(file.preview || {}), ...(markdownFile(file.path) ? { markdown: markdownPosition(file.markdown) } : {}) });
  }
  for (const project of value.projects) if (project && validRoot(project.cwd)) projects.set(project.cwd, { cwd: project.cwd, active: validFile(project.active) ? project.active : null, visible: project.visible !== false });
  return { version: 1, files: [...files.values()], projects: [...projects.values()] };
}

// Work on complete selected lines; an end at the next line's start excludes it.
export function lineEdit(content, start, end, language, action) {
  const width = language === 'python' ? 4 : 2, marker = language === 'sql' ? '--' : language === 'python' ? '#' : null;
  if (action === 'comment' && !marker) return null;
  if (action === 'indent' && start === end) return { from: start, to: end, text: ' '.repeat(width), start: start + width, end: end + width };
  const from = start === 0 ? 0 : content.lastIndexOf('\n', start - 1) + 1;
  const last = end > start && content[end - 1] === '\n' ? end - 1 : end;
  const newline = content.indexOf('\n', last), to = newline < 0 ? content.length : newline;
  const lines = content.slice(from, to).split('\n'), changes = [];
  const nonempty = lines.filter(line => line.trim());
  const uncomment = action === 'comment' && nonempty.length > 0 && nonempty.every(line => line.trimStart().startsWith(marker));
  let offset = from;
  for (const line of lines) {
    if (action === 'indent') changes.push({ at: offset, remove: 0, text: ' '.repeat(width) });
    else if (action === 'outdent') {
      const count = line.startsWith('\t') ? 1 : line.match(new RegExp(`^ {1,${width}}`))?.[0].length || 0;
      if (count) changes.push({ at: offset, remove: count, text: '' });
    } else if (action === 'comment' && (line.trim() || lines.length === 1)) {
      const at = offset + line.match(/^[\t ]*/)[0].length;
      const remove = uncomment ? marker.length + (content[at + marker.length] === ' ' ? 1 : 0) : 0;
      changes.push({ at, remove, text: uncomment ? '' : marker + ' ' });
    }
    offset += line.length + 1;
  }
  if (!changes.length) return null;
  let text = content.slice(from, to);
  for (const change of changes.slice().reverse()) { const index = change.at - from; text = text.slice(0, index) + change.text + text.slice(index + change.remove); }
  const position = value => {
    let delta = 0;
    for (const change of changes) {
      if (value < change.at) break;
      if (value <= change.at + change.remove) return change.at + delta + change.text.length;
      delta += change.text.length - change.remove;
    }
    return value + delta;
  };
  return { from, to, text, start: position(start), end: position(end) };
}

export function createFileEditor({ api, onAttach, onChange = () => {}, onSessionError = () => {}, onReveal = () => {} }) {
  const documents = [], views = new Map(), projectViews = new Map();
  const emptyView = { panel: $('editorEmptyPanel'), input: $('fileEditorText'), numbers: $('editorLineNumbers'), highlight: $('editorHighlight') };
  let active = null, project = '', nextId = 0, guard = null, comparison = null, closingAll = false, savingAll = false;
  let searchQuery = '';
  let workspaceStorage, sessionTimer, lastSession = '', sessionErrorShown = false;
  let savedSession = normalizeEditorSession(null);
  try { workspaceStorage = window.localStorage; const raw = workspaceStorage.getItem(sessionKey); if (raw && raw.length <= 2000000) savedSession = normalizeEditorSession(JSON.parse(raw)); } catch { /* Storage may be unavailable or contain an old invalid record. */ }
  const floating = createEditorLayout({ container: $('workspacePanes'), divider: $('editorDivider'), modeButton: $('editorLayoutToggle'), pane: $('fileEditor'), handle: $('editorDragHandle'), maximize: $('editorMaximize'), reset: $('editorResetWindow'), resizeHandles: ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'].map(edge => $('editorResize' + edge)) });
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { if (searchQuery) highlight(active); else syncScroll(); });
  const visible = () => !$('fileEditor').hidden;
  const exists = doc => documents.includes(doc);
  const dirty = doc => !doc?.preview && !!doc?.file && doc.view.input.value !== doc.baseline;
  const anyDirty = () => documents.some(dirty);
  const sameProject = doc => !project || doc?.aliases.has(project);
  const projectDocuments = () => documents.filter(sameProject);
  const writable = doc => !!doc?.file?.writable && sameProject(doc);
  const busySaving = () => savingAll || documents.some(doc => doc.saving);
  const uiLocked = () => !!guard || closingAll;
  const filename = doc => doc.path.split('/').at(-1);
  const tabMenu = $('editorTabMenu'), tabMenuPath = $('editorTabMenuPath'), tabMenuStatus = $('editorTabMenuStatus');
  let menuTarget = null, menuOpener = null;
  const fullPath = doc => `${(doc.file?.cwd || doc.cwd).replace(/\/$/, '')}/${doc.path}`;
  function closeTabMenu(focus = false) {
    tabMenu.hidden = true; menuTarget = null;
    menuOpener?.setAttribute('aria-expanded', 'false');
    if (focus && menuOpener?.isConnected) menuOpener.focus({ preventScroll: true });
  }
  function openTabMenu(doc, opener, pointer) {
    if (!exists(doc) || !sameProject(doc)) return;
    closeTabMenu(); menuTarget = doc; menuOpener = opener; tabMenuPath.value = fullPath(doc); tabMenuPath.title = tabMenuPath.value; tabMenuStatus.textContent = '';
    tabMenu.hidden = false; opener.setAttribute('aria-expanded', 'true');
    const anchor = pointer ? { left: pointer.clientX, top: pointer.clientY, bottom: pointer.clientY } : opener.getBoundingClientRect();
    const layout = popupLayout(anchor, { width: window.innerWidth, height: window.innerHeight }, 340, tabMenu.getBoundingClientRect().height);
    for (const [key, value] of Object.entries({ left: layout.left, top: layout.top, width: layout.width, maxHeight: layout.maxHeight })) tabMenu.style[key] = `${value}px`;
    tabMenu.querySelector('[role=menuitem]').focus({ preventScroll: true });
  }
  for (const button of tabMenu.querySelectorAll('[data-tab-action]')) button.addEventListener('click', async () => {
    const doc = menuTarget; if (!doc || !exists(doc)) return closeTabMenu();
    const action = button.dataset.tabAction;
    if (action === 'reveal') { closeTabMenu(true); activate(doc, { focus: false }); await onReveal({ cwd: doc.file?.cwd || doc.cwd, path: doc.path }); return; }
    const text = action === 'name' ? filename(doc) : action === 'relative' ? doc.path : fullPath(doc);
    try { await window.navigator.clipboard.writeText(text); if (menuTarget === doc) tabMenuStatus.textContent = `${button.textContent.replace('复制', '已复制')}。`; }
    catch { if (menuTarget === doc) { tabMenuPath.value = text; tabMenuPath.focus(); tabMenuPath.select(); tabMenuStatus.textContent = '剪贴板不可用，已选中文本，请按 ⌘ / Ctrl + C 复制。'; } }
  });
  tabMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeTabMenu(true); return; }
    if (event.target === tabMenuPath) return;
    const buttons = [...tabMenu.querySelectorAll('[role=menuitem]')], index = buttons.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); buttons[next].focus(); }
  });
  tabMenu.addEventListener('focusout', event => { if (event.relatedTarget && !tabMenu.contains(event.relatedTarget)) closeTabMenu(); });
  document.addEventListener('pointerdown', event => { if (!tabMenu.hidden && !tabMenu.contains(event.target) && !menuOpener?.contains(event.target)) closeTabMenu(); });
  window.addEventListener('resize', () => closeTabMenu());

  const matches = expected => !!active?.file && !markdownPreview(active) && active.id === expected?.id && active.file.cwd === expected.cwd && active.path === expected.path && active.view.input.value === expected.content && active.view.input.selectionStart === expected.start && active.view.input.selectionEnd === expected.end && writable(active) && !active.loading && !active.composing && !uiLocked() && visible();

  function persistSession() {
    window.clearTimeout?.(sessionTimer);
    if (!project || !workspaceStorage) return;
    const projects = new Map(projectViews);
    projects.set(project, { id: active?.id, visible: visible() });
    const data = JSON.stringify(normalizeEditorSession({ version: 1,
      files: documents.map(doc => ({ cwd: doc.cwd, path: doc.path, language: doc.language,
        start: doc.sessionPosition?.start ?? doc.view.input.selectionStart, end: doc.sessionPosition?.end ?? doc.view.input.selectionEnd, direction: doc.sessionPosition?.direction ?? doc.view.input.selectionDirection,
        top: doc.sessionPosition?.top ?? (active === doc && visible() && !markdownPreview(doc) ? doc.view.input.scrollTop : doc.position?.top), left: doc.sessionPosition?.left ?? (active === doc && visible() && !markdownPreview(doc) ? doc.view.input.scrollLeft : doc.position?.left), preview: doc.previewState, markdown: doc.markdown })),
      projects: [...projects].map(([cwd, view]) => ({ cwd, active: documents.find(doc => doc.id === view.id)?.path, visible: view.visible })) }));
    if (data === lastSession) return;
    try { if (data.length > 2000000) throw new Error(); workspaceStorage.setItem(sessionKey, data); lastSession = data; sessionErrorShown = false; }
    catch { if (!sessionErrorShown) { sessionErrorShown = true; onSessionError('打开的文件标签未能记住，请检查浏览器存储空间。当前文件仍可继续使用。'); } }
  }
  function queueSession() { if (!project || !workspaceStorage) return; window.clearTimeout(sessionTimer); sessionTimer = window.setTimeout(persistSession, 200); }
  function rememberSource(doc) { if (doc && !markdownPreview(doc)) doc.position = { top: doc.view.input.scrollTop, left: doc.view.input.scrollLeft }; }
  function renderMarkdown(doc) {
    if (!doc?.markdown) return;
    const showing = markdownPreview(doc), { source, numbers, reader, article, input, panel } = doc.view;
    panel.classList.toggle('is-markdown-preview', showing);
    source.hidden = numbers.hidden = showing; reader.hidden = !showing;
    if (showing && doc.file && doc.renderedMarkdown !== input.value) {
      doc.markdownViewer?.dispose();
      article.innerHTML = input.value.trim() ? markdown(input.value, { document: true }) : '<p class="markdown-empty">这个 Markdown 文件还是空的，切换到源码开始编写。</p>';
      doc.renderedMarkdown = input.value;
      doc.markdownViewer = enhanceMarkdown(article, { api, entry: { cwd: doc.file.cwd, path: doc.path }, resolveLink: resolveMarkdownLink });
    }
    if (showing) doc.markdownViewer?.refresh();
    if (showing) { reader.scrollTop = doc.markdown.top; reader.scrollLeft = doc.markdown.left; }
  }
  function setMarkdownMode(mode, { focus = false } = {}) {
    if (!active?.markdown || !['preview', 'source'].includes(mode) || uiLocked() || active.loading) return false;
    if (mode !== active.markdown.mode) {
      rememberSource(active); active.markdown.mode = mode; active.view.ghost = null;
      if (mode === 'preview') { searchQuery = ''; $('editorFindBar').hidden = true; $('editorFindToggle').setAttribute('aria-expanded', 'false'); }
      update();
      if (mode === 'source') { active.view.input.scrollTop = active.position?.top || 0; active.view.input.scrollLeft = active.position?.left || 0; syncScroll(); }
    }
    if (focus) (markdownPreview(active) ? active.view.reader : active.view.input).focus({ preventScroll: true });
    return true;
  }
  $('editorMarkdownPreview').addEventListener('click', () => setMarkdownMode('preview'));
  $('editorMarkdownSource').addEventListener('click', () => setMarkdownMode('source', { focus: true }));
  function scrollMarkdownAnchor(doc, anchor) {
    try { anchor = decodeURIComponent(anchor); } catch { return; }
    const heading = [...doc.view.article.querySelectorAll('[data-markdown-heading]')].find(node => node.dataset.markdownHeading === anchor);
    if (heading) { heading.scrollIntoView?.({ block: 'start' }); heading.focus({ preventScroll: true }); }
  }
  function selectText(start, end = start) {
    if (!active) return;
    setMarkdownMode('source'); active.view.input.focus(); active.view.input.setSelectionRange(start, end);
    active.view.input.scrollTop = Math.max(0, active.view.input.value.slice(0, start).split('\n').length - 4) * 22; update();
  }
  function ensureLoaded(doc) {
    if (doc.file) return Promise.resolve(true);
    if (!doc.readPromise) doc.readPromise = readDocument(doc, true).finally(() => { doc.readPromise = null; });
    return doc.readPromise;
  }

  function applyKeyboardEdit(doc, edit, { reveal = false } = {}) {
    if (!edit || !writable(doc) || doc.loading || doc.composing || uiLocked()) return;
    const { input } = doc.view, direction = input.selectionDirection, top = input.scrollTop, left = input.scrollLeft;
    if (input.value.length - (edit.to - edit.from) + edit.text.length > input.maxLength) { $('editorToolStatus').textContent = '修改后超过文件编辑大小上限。'; return; }
    doc.view.ghost = null;
    let inserted = false, notified = false;
    const changed = () => { notified = true; }; input.addEventListener('input', changed);
    input.setSelectionRange(edit.from, edit.to);
    try { inserted = !!input.ownerDocument.execCommand?.(edit.text ? 'insertText' : 'delete', false, edit.text); } catch { /* Fallback for browsers without native editing commands. */ }
    input.removeEventListener('input', changed);
    if (!inserted) input.setRangeText(edit.text, edit.from, edit.to, 'end');
    input.setSelectionRange(edit.start, edit.end, direction); input.scrollTop = top; input.scrollLeft = left;
    if (!notified) input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
    update(); if (reveal) revealCaret(doc);
  }

  function setCurrentIds(view) {
    for (const item of [emptyView, ...documents.map(doc => doc.view)]) {
      for (const key of ['input', 'numbers', 'highlight']) item[key].removeAttribute('id');
    }
    view.input.id = 'fileEditorText'; view.numbers.id = 'editorLineNumbers'; view.highlight.id = 'editorHighlight';
  }
  function syncScroll(doc = active) {
    const view = doc?.view || emptyView, { input, highlight, numbers } = view;
    highlight.style.width = `${input.clientWidth}px`; highlight.style.height = `${input.clientHeight}px`;
    highlight.scrollTop = input.scrollTop; highlight.scrollLeft = input.scrollLeft;
    numbers.scrollTop = input.scrollTop;
  }
  function revealCaret(doc) {
    if (doc !== active || doc.preview || doc.loading || doc.composing || !visible()) return;
    const { input } = doc.view;
    if (document.activeElement !== input || !input.clientHeight || input.scrollHeight <= input.clientHeight) return;
    const style = input.ownerDocument.defaultView?.getComputedStyle(input);
    const lineHeight = parseFloat(style?.lineHeight) || 22, padding = parseFloat(style?.paddingTop) || 0;
    const caret = input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd;
    const top = padding + (input.value.slice(0, caret).split('\n').length - 1) * lineHeight;
    const margin = Math.min(lineHeight * 2, Math.max(0, (input.clientHeight - lineHeight) / 2));
    let next = input.scrollTop;
    if (top < next + margin) next = top - margin;
    else if (top + lineHeight > next + input.clientHeight - margin) next = top + lineHeight + margin - input.clientHeight;
    input.scrollTop = Math.max(0, Math.min(Math.max(0, input.scrollHeight - input.clientHeight), next));
    doc.position = { top: input.scrollTop, left: input.scrollLeft }; syncScroll(doc); queueSession();
  }
  function setError(doc, message = '', conflict = false) {
    if (!doc || !exists(doc)) return;
    doc.error = message; doc.conflict = conflict; update();
  }
  function searchState(doc) {
    const content = doc?.view.input.value || '';
    if (!doc || doc.preview || markdownPreview(doc) || doc.loading) return { positions: [], index: -1 };
    if (doc.search?.query !== searchQuery || doc.search?.content !== content) {
      const positions = findCodeMatches(content, searchQuery);
      let index = positions.findIndex(at => at >= doc.view.input.selectionStart);
      if (index < 0 && positions.length) index = 0;
      doc.search = { query: searchQuery, content, positions, index };
    }
    return doc.search;
  }
  function highlight(doc) {
    const found = searchState(doc);
    $('editorFindCount').textContent = !searchQuery ? '' : doc?.preview ? '仅查找文本' : found.positions.length ? `${found.index + 1} / ${found.positions.length}` : '无匹配';
    $('editorFind').setAttribute('aria-invalid', String(!!searchQuery && !found.positions.length));
    for (const id of ['editorFindNext', 'editorFindPrevious']) $(id).disabled = !found.positions.length;
    $('editorReplaceAll').disabled = !found.positions.length || !writable(doc) || uiLocked();
    if (doc?.preview) return;
    if (markdownPreview(doc)) { $('editorLanguageStatus').textContent = 'Markdown · 预览'; $('editorCursor').textContent = ''; return; }
    const view = doc?.view || emptyView, text = view.input.value;
    const language = !doc || doc.language === 'auto' ? detectLanguage(doc?.path) : doc.language;
    if (view.ghost && (searchQuery || !matches(view.ghost.snapshot) || language !== 'sql')) view.ghost = null;
    const ghost = view.ghost;
    if (view.lastText !== text || view.lastLanguage !== language || view.lastGhost !== ghost) {
      const result = highlightCode(text, language);
      view.syntaxColored = language !== 'text' && !result.limited; view.limited = result.limited;
      view.baseHtml = result.html + ' ';
      view.highlight.innerHTML = view.syntaxColored ? view.baseHtml : '';
      view.lastSearchPaint = null;
      if (ghost && view.syntaxColored) {
        view.highlight.innerHTML = highlightCode(text.slice(0, ghost.snapshot.start), language).html;
        const span = document.createElement('span'); span.className = 'editor-ai-ghost'; span.textContent = ghost.text;
        view.highlight.append(span);
        const suffix = document.createElement('span'); suffix.innerHTML = highlightCode(text.slice(ghost.snapshot.end), language).html + ' ';
        view.highlight.append(suffix);
      }
      const padding = ghost ? `${28 + ghost.text.split('\n').length * 22}px` : '';
      view.input.style.paddingBottom = padding; view.highlight.style.paddingBottom = padding; view.numbers.style.paddingBottom = padding;
      view.lastGhost = ghost;
      view.lastText = text; view.lastLanguage = language;
    }
    view.colored = view.syntaxColored || !!searchQuery;
    const lineHeight = parseFloat(window.getComputedStyle(view.input).lineHeight) || 22;
    const firstLine = Math.max(0, Math.floor(view.input.scrollTop / lineHeight) - 2);
    const lastLine = firstLine + Math.ceil((view.input.clientHeight || 600) / lineHeight) + 5;
    const paint = `${searchQuery}:${found.index}:${firstLine}:${lastLine}`;
    if (view.lastSearchPaint !== paint) {
      if (!ghost) view.highlight.innerHTML = view.colored ? view.baseHtml : '';
      if (searchQuery && found.positions.length) {
        const lines = text.split('\n');
        const from = lines.slice(0, firstLine).reduce((sum, line) => sum + line.length + 1, 0);
        const to = from + lines.slice(firstLine, lastLine).reduce((sum, line) => sum + line.length + 1, 0);
        markCodeMatches(view.highlight, found.positions, searchQuery.length, found.positions[found.index], from, to);
      }
      view.lastSearchPaint = paint;
    }
    $('fileEditor').classList.toggle('has-highlight', !!view.colored);
    $('editorLanguageStatus').textContent = view.limited ? '大文件 · 纯文本' : doc?.markdown && language === 'text' ? 'Markdown · 源码' : ({ sql: 'SQL', python: 'Python', text: '纯文本' })[language];
    $('editorLanguageStatus').title = view.limited ? '超过 20 万字符时暂停高亮；仍可正常编辑和保存。' : '高亮仅影响显示，不改变文件内容';
    const count = text.split('\n').length;
    if (view.lineCount !== count || view.numberGhost !== ghost) {
      view.lineCount = count; view.numberGhost = ghost;
      const labels = Array.from({ length: count }, (_, n) => String(n + 1));
      if (ghost) labels.splice(text.slice(0, ghost.snapshot.start).split('\n').length, 0, ...Array(ghost.text.split('\n').length - 1).fill(''));
      view.numbers.textContent = labels.join('\n');
    }
    const before = text.slice(0, view.input.selectionStart || 0).split('\n');
    $('editorCursor').textContent = `行 ${before.length}，列 ${before.at(-1).length + 1}`;
    syncScroll(doc);
  }
  function update({ restoring = false } = {}) {
    if (markdownPreview(active)) { searchQuery = ''; $('editorFindBar').hidden = true; $('editorFindToggle').setAttribute('aria-expanded', 'false'); }
    for (const doc of documents) {
      const tab = views.get(doc.id), changed = dirty(doc), selected = active === doc;
      const duplicateName = documents.some(other => other !== doc && filename(other) === filename(doc));
      if (tab.label.textContent !== filename(doc)) tab.label.textContent = filename(doc);
      tab.parent.textContent = duplicateName ? doc.path.split('/').slice(0, -1).join('/') || doc.cwd : '';
      tab.parent.hidden = !duplicateName;
      tab.state.textContent = doc.loading || doc.saving ? '…' : doc.error ? '!' : changed ? '●' : '';
      tab.state.title = doc.error || (changed ? '未保存' : '');
      tab.row.classList.toggle('is-active', selected); tab.row.classList.toggle('is-dirty', changed);
      tab.row.classList.toggle('has-error', !!doc.error);
      tab.row.hidden = !sameProject(doc);
      tab.button.setAttribute('aria-selected', String(selected)); tab.button.tabIndex = selected ? 0 : -1;
      tab.button.setAttribute('aria-label', `${doc.path}${changed ? '，未保存' : ''}${doc.error ? '，需要处理' : ''}`);
      tab.button.title = `${doc.cwd}/${doc.path}`;
      tab.button.disabled = uiLocked();
      tab.close.disabled = doc.saving || doc.closing || uiLocked() || savingAll;
      doc.view.input.readOnly = !writable(doc) || doc.loading;
    }
    const changed = dirty(active), loading = !!active?.loading, saving = !!active?.saving;
    const currentDocuments = projectDocuments(), unsaved = currentDocuments.filter(dirty).length;
    $('editorTabCount').textContent = `${currentDocuments.length} 个文件${unsaved ? ` · ${unsaved} 未保存` : ''}`;
    $('editorDirty').hidden = !changed;
    $('editorFilename').textContent = active ? filename(active) : '打开项目文件';
    $('editorPath').textContent = active ? `${active.file?.cwd || active.cwd}/${active.path}` : '';
    $('editorPath').title = $('editorPath').textContent;
    $('editorFormat').textContent = active?.file ? `UTF-8${active.file.bom ? ' BOM' : ''} · ${active.file.newline}` : 'UTF-8';
    $('editorSave').disabled = !changed || !writable(active) || saving || loading || savingAll || uiLocked();
    $('editorSave').textContent = saving ? '保存中…' : '保存';
    $('editorSaveAll').disabled = !unsaved || busySaving() || uiLocked();
    $('editorSaveAll').textContent = savingAll ? '正在全部保存…' : '全部保存';
    $('editorReload').disabled = !active || saving || loading || uiLocked() || savingAll;
    $('editorAttach').disabled = !active?.file || saving || loading || active.attaching || !sameProject(active) || uiLocked();
    $('editorClose').disabled = busySaving() || uiLocked();
    $('editorLanguage').disabled = !active;
    $('editorLanguage').value = active?.language || 'auto';
    $('fileEditor').setAttribute('aria-busy', String(loading || saving));
    $('fileEditorError').textContent = active?.error || ''; $('fileEditorError').hidden = !active?.error || !!active?.conflict;
    $('fileConflict').hidden = !active?.conflict;
    $('fileConflictText').textContent = active?.error || '磁盘有新代码，未保存编辑已保留。';
    $('compareFileVersions').disabled = !active || active.comparing || loading || saving;
    $('viewLatestFile').disabled = $('compareFileVersions').disabled;
    $('undoFileSync').hidden = !active?.mergeUndo || !!active?.conflict;
    $('undoFileSync').disabled = !active || active.view.input.value !== active.mergeUndo?.after || loading || saving || uiLocked();
    $('editorStatus').textContent = loading ? '正在读取文件…' : saving ? '正在写入磁盘…' : !active?.file ? '尚未读取文件' : !sameProject(active) ? '请切回原项目' : active.diskChanged ? '磁盘有更新 · 草稿已保留' : active.syncError ? '自动同步暂不可用' : !active.file.writable ? active.file.readOnlyReason : changed ? active.mergeUndo ? '已合并磁盘更新 · 未保存' : '未保存' : active.syncedAt ? '已自动同步' : '已同步';
    $('editorStatus').title = active?.syncError || (active?.syncedAt ? `最近同步：${new Date(active.syncedAt).toLocaleTimeString('zh-CN')}` : '自动检查磁盘更新；未保存的编辑不会被覆盖');
    $('fileEditor').classList.toggle('preview-active', !!active?.preview);
    if (active?.preview) { $('editorStatus').textContent = loading ? '正在读取文档…' : active.error || (active.syncError ? '文档自动同步暂不可用' : active.diskChanged ? '文件已更新，可重新读取' : '文档预览 · 自动检查文件更新'); $('editorFormat').textContent = ''; $('editorCursor').textContent = ''; }
    highlight(active);
    $('editorMarkdownModes').hidden = !active?.markdown;
    for (const [id, mode] of [['editorMarkdownPreview', 'preview'], ['editorMarkdownSource', 'source']]) {
      $(id).setAttribute('aria-pressed', String(active?.markdown?.mode === mode)); $(id).disabled = loading || uiLocked();
    }
    $('fileEditor').classList.toggle('markdown-preview-active', markdownPreview(active));
    renderMarkdown(active);
    if (active?.markdown) {
      $('editorLanguageStatus').textContent = markdownPreview(active) ? 'Markdown · 预览' : 'Markdown · 源码';
      if (markdownPreview(active)) $('editorCursor').textContent = '';
    }
    onChange({ restoring }); queueSession();
  }
  function activate(doc, { focus = true, force = false, restoring = false } = {}) {
    if (!exists(doc) || !sameProject(doc) || !force && uiLocked()) return false;
    if (active !== doc) {
      closeTabMenu();
      if (active) {
        rememberSource(active);
        active.view.panel.hidden = true;
      }
      active = doc; emptyView.panel.hidden = true; doc.view.panel.hidden = false; setCurrentIds(doc.view);
    }
    $('fileEditor').hidden = false; $('appShell').classList.add('editor-open'); floating.show(); update({ restoring });
    if (doc.preview) doc.viewer?.resume?.();
    if (focus && !doc.preview) (markdownPreview(doc) ? doc.view.reader : doc.view.input).focus({ preventScroll: true });
    doc.view.input.scrollTop = doc.position?.top || 0; doc.view.input.scrollLeft = doc.position?.left || 0;
    syncScroll(doc); views.get(doc.id).button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (doc.sessionPosition && !doc.file) void ensureLoaded(doc);
    if (doc.file && Date.now() - (doc.checkedAt || 0) > 2500) void syncDocument(doc);
    return true;
  }
  function showEmpty() {
    if (active) active.view.panel.hidden = true;
    active = null; emptyView.panel.hidden = false; setCurrentIds(emptyView);
    $('fileEditor').hidden = true; $('appShell').classList.remove('editor-open'); floating.hide(); update();
    $('prompt').focus();
  }
  function removeDocument(doc) {
    if (menuTarget === doc) closeTabMenu();
    const index = documents.indexOf(doc); if (index < 0) return;
    doc.readSequence++; doc.viewer?.dispose(); doc.markdownViewer?.dispose(); if (doc.previewUrl) URL.revokeObjectURL(doc.previewUrl); observer?.unobserve(doc.view.input); doc.view.panel.remove();
    views.get(doc.id).row.remove(); views.delete(doc.id); documents.splice(index, 1);
    if (active === doc) {
      // Drop the old ids before giving them to the neighboring document.
      for (const key of ['input', 'numbers', 'highlight']) doc.view[key].removeAttribute('id');
      active = null;
      const remaining = projectDocuments();
      if (remaining.length) activate(remaining[Math.min(index, remaining.length - 1)], { force: true });
      else showEmpty();
    } else update();
  }
  function makeDocument(entry) {
    const doc = { preview: /\.(pdf|xlsx|xls|xlsm)$/i.test(entry.path), markdown: markdownFile(entry.path) ? markdownPosition(entry.markdown) : null, previewState: {}, id: ++nextId, cwd: entry.cwd, path: entry.path, aliases: new Set([entry.cwd]), file: null, baseline: '', language: 'auto', loading: false, saving: false, error: '', conflict: false, readSequence: 0 };
    const panel = document.createElement('div'); panel.className = 'editor-code'; panel.id = `editorPanel-${doc.id}`; panel.hidden = true;
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `editorTab-${doc.id}`);
    const numbers = document.createElement('pre'); numbers.className = 'editor-line-numbers'; numbers.setAttribute('aria-hidden', 'true');
    const source = document.createElement('div'); source.className = 'editor-source';
    const rendered = document.createElement('pre'); rendered.className = 'editor-highlight'; rendered.setAttribute('aria-hidden', 'true');
    const input = document.createElement('textarea');
    Object.assign(input, { className: 'editor-input', spellcheck: false, wrap: 'off', maxLength: 1048576, readOnly: true });
    input.setAttribute('aria-label', `编辑文件内容：${doc.path}`); input.setAttribute('aria-describedby', 'editorHelp');
    for (const [name, value] of [['autocapitalize', 'off'], ['autocomplete', 'off'], ['autocorrect', 'off']]) input.setAttribute(name, value);
    source.append(rendered, input); panel.append(numbers, source); $('editorBuffers').append(panel);
    doc.view = { panel, numbers, source, highlight: rendered, input }; observer?.observe(input);
    if (doc.markdown) {
      const reader = document.createElement('div'), article = document.createElement('article');
      reader.className = 'editor-markdown-reader'; reader.tabIndex = 0; reader.setAttribute('role', 'region'); reader.setAttribute('aria-label', `Markdown 预览：${doc.path}`);
      article.className = 'editor-markdown-content'; reader.append(article); panel.append(reader); Object.assign(doc.view, { reader, article });
      reader.addEventListener('scroll', () => { if (active === doc && visible() && !doc.loading && doc.file && markdownPreview(doc)) { doc.markdown.top = reader.scrollTop; doc.markdown.left = reader.scrollLeft; queueSession(); } });
      reader.addEventListener('click', async event => {
        const link = event.target.closest?.('[data-file-link], [data-markdown-anchor]'); if (!link) return;
        if (link.hasAttribute('data-markdown-anchor')) { scrollMarkdownAnchor(doc, link.dataset.markdownAnchor); return; }
        try {
          const entry = resolveMarkdownLink(link.dataset.fileLink, { cwd: doc.file.cwd, path: doc.path });
          if (!await openFile(entry) || active?.file?.cwd !== entry.cwd || active?.path !== entry.path) return;
          if (entry.line) selectText(active.view.input.value.split('\n').slice(0, entry.line - 1).reduce((n, line) => n + line.length + 1, 0));
          else if (entry.anchor && active.markdown) { setMarkdownMode('preview'); scrollMarkdownAnchor(active, entry.anchor); }
        } catch (error) { $('editorToolStatus').textContent = error.message; }
      });
    }
    if (doc.preview) { panel.classList.add('editor-document'); numbers.hidden = source.hidden = true; const host = document.createElement('div'); host.className = 'editor-document-host'; panel.append(host); doc.previewHost = host; for (const type of ['input', 'change', 'click', 'scroll']) host.addEventListener(type, queueSession, true); }
    for (const type of ['input', 'keyup', 'click', 'select']) input.addEventListener(type, update);
    // Follow edits and keyboard navigation, not scroll/select events: scrolling
    // up to read earlier code must not snap back to the insertion point.
    input.addEventListener('input', event => { if (!event.isComposing) revealCaret(doc); });
    input.addEventListener('keyup', event => { if (!event.isComposing && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) revealCaret(doc); });
    input.addEventListener('compositionstart', () => { doc.composing = true; update(); });
    input.addEventListener('compositionend', () => { doc.composing = false; update(); revealCaret(doc); });
    input.addEventListener('scroll', () => { if (!doc.loading && !doc.view.panel.hidden) rememberSource(doc); if (active === doc) { if (searchQuery) highlight(doc); else syncScroll(doc); } queueSession(); });
    input.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.isComposing || doc.composing || document.querySelector('dialog[open]')) return;
      if (event.key === 'Escape') { doc.navigateByTab = true; $('editorToolStatus').textContent = '再按 Tab 或 Shift + Tab 移出编辑区'; return; }
      const navigate = doc.navigateByTab; doc.navigateByTab = false;
      if (navigate && event.key === 'Tab') return;
      const language = doc.language === 'auto' ? detectLanguage(doc.path) : doc.language;
      if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey && !input.readOnly) {
        event.preventDefault(); applyKeyboardEdit(doc, lineEdit(input.value, input.selectionStart, input.selectionEnd, language, event.shiftKey ? 'outdent' : 'indent')); return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.code === 'Slash' || event.key === '/')) {
        event.preventDefault();
        if (!input.readOnly) {
          if (!['sql', 'python'].includes(language)) $('editorToolStatus').textContent = '请先将文件语言设为 SQL 或 Python，再切换行注释。';
          else applyKeyboardEdit(doc, lineEdit(input.value, input.selectionStart, input.selectionEnd, language, 'comment'));
        }
        return;
      }
      if (event.key === 'Enter' && !event.isComposing && !input.readOnly && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); const line = input.value.slice(0, input.selectionStart).split('\n').at(-1);
        const text = '\n' + line.match(/^[\t ]*/)[0] + (language === 'python' && line.trimEnd().endsWith(':') ? '    ' : '');
        const caret = input.selectionStart + text.length;
        applyKeyboardEdit(doc, { from: input.selectionStart, to: input.selectionEnd, text, start: caret, end: caret }, { reveal: true });
      }
    });
    const row = document.createElement('div'); row.className = 'editor-tab'; row.setAttribute('role', 'presentation');
    const button = document.createElement('button'); button.type = 'button'; button.id = `editorTab-${doc.id}`;
    button.className = 'editor-tab-select'; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', panel.id);
    const label = document.createElement('span'); label.className = 'editor-tab-label';
    const parent = document.createElement('small'); parent.className = 'editor-tab-parent';
    const state = document.createElement('span'); state.className = 'editor-tab-state'; state.setAttribute('aria-hidden', 'true');
    button.append(label, parent, state); button.addEventListener('click', () => {
      const selection = document.getSelection?.();
      if (selection && !selection.isCollapsed && label.contains(selection.anchorNode)) return;
      activate(doc);
    });
    row.addEventListener('contextmenu', event => { event.preventDefault(); openTabMenu(doc, more, event); });
    button.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); openTabMenu(doc, more); return; }
      const tabs = projectDocuments(), index = tabs.indexOf(doc);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); if (activate(tabs[next], { focus: false })) views.get(tabs[next].id).button.focus(); }
      if (event.key === 'Delete') { event.preventDefault(); closeTab(doc.id); }
    });
    const close = document.createElement('button'); close.type = 'button'; close.className = 'editor-tab-close'; close.textContent = '×';
    close.setAttribute('aria-label', `关闭文件 ${doc.path}`); close.title = `关闭 ${doc.path}`;
    close.addEventListener('click', () => closeTab(doc.id));
    const more = document.createElement('button'); more.type = 'button'; more.className = 'editor-tab-more'; more.textContent = '⋯';
    more.setAttribute('aria-label', `文件操作：${doc.path}`); more.title = '复制文件名 / 路径 · 在目录中定位'; more.setAttribute('aria-haspopup', 'dialog'); more.setAttribute('aria-controls', 'editorTabMenu'); more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', () => openTabMenu(doc, more));
    row.append(button, more, close); $('editorTabs').append(row); views.set(doc.id, { row, button, label, parent, state, close });
    documents.push(doc); return doc;
  }
  async function readPreview(doc, supplied) {
    const expected = ++doc.readSequence; doc.loading = true; update();
    try {
      const result = supplied || await api(`/api/project/artifact?cwd=${encodeURIComponent(doc.cwd)}&path=${encodeURIComponent(doc.path)}`);
      const { createArtifactViewer } = await import('./artifact-viewer.js');
      if (!exists(doc) || expected !== doc.readSequence) return false;
      doc.viewer?.dispose(); if (doc.previewUrl) URL.revokeObjectURL(doc.previewUrl); doc.previewHost.replaceChildren();
      const bytes = Uint8Array.from(atob(result.base64), value => value.charCodeAt(0));
      doc.previewUrl = URL.createObjectURL(new Blob([bytes], { type: result.extension === '.pdf' ? 'application/pdf' : 'application/octet-stream' }));
      const toolbar = document.createElement('div'); toolbar.className = 'document-file-actions';
      const download = document.createElement('a'); download.textContent = '下载原文件'; download.href = doc.previewUrl; download.download = result.name; download.className = 'text-button';
      const refreshButton = document.createElement('button'); refreshButton.textContent = '重新读取'; refreshButton.className = 'text-button'; refreshButton.onclick = () => { if (!doc.loading) void readPreview(doc); };
      toolbar.append(download, refreshButton); doc.previewHost.append(toolbar);
      doc.file = { ...result, base64: undefined, cwd: result.cwd || doc.cwd, path: result.path || doc.path, content: '', writable: false, readOnlyReason: '只读预览' }; doc.error = ''; doc.diskChanged = false; doc.checkedAt = Date.now();
      doc.viewer = createArtifactViewer({ container: doc.previewHost, bytes, entry: { cwd: doc.file.cwd, path: doc.path }, result, api, state: doc.previewState });
      doc.sessionPosition = null;
      return true;
    } catch (error) { if (exists(doc) && expected === doc.readSequence) doc.error = error.message; return false; }
    finally { if (exists(doc) && expected === doc.readSequence) { doc.loading = false; update(); } }
  }
  async function readDocument(doc, initial = false) {
    if (doc.preview) return readPreview(doc);
    if (!exists(doc) || doc.saving || doc.loading) return false;
    const expected = ++doc.readSequence; doc.loading = true; setError(doc);
    try {
      const result = await api(`/api/project/file?cwd=${encodeURIComponent(doc.file?.cwd || doc.cwd)}&path=${encodeURIComponent(doc.path)}`);
      if (!exists(doc) || expected !== doc.readSequence) return false;
      if (initial) {
        const duplicate = documents.find(other => other !== doc && other.file?.cwd === result.cwd && other.path === result.path);
        if (duplicate) {
          duplicate.aliases.add(doc.cwd); const selected = active === doc;
          removeDocument(doc); if (selected) activate(duplicate, { force: true }); return true;
        }
      }
      doc.file = result; doc.path = result.path; doc.aliases.add(result.cwd); doc.baseline = result.content;
      doc.mergeUndo = null; doc.mergeBlockVersion = null;
      doc.diskChanged = false; doc.syncError = ''; doc.checkedAt = Date.now();
      doc.view.input.value = result.content; doc.view.input.setSelectionRange(0, 0);
      doc.position = { top: 0, left: 0 }; doc.view.input.scrollTop = 0; doc.view.input.scrollLeft = 0;
      if (doc.sessionPosition) {
        const saved = doc.sessionPosition; doc.sessionPosition = null;
        doc.view.input.setSelectionRange(Math.min(saved.start, result.content.length), Math.min(saved.end, result.content.length), saved.direction);
        doc.position = { top: saved.top, left: saved.left }; doc.view.input.scrollTop = saved.top; doc.view.input.scrollLeft = saved.left;
      }
      return true;
    } catch (cause) { if (exists(doc) && expected === doc.readSequence) setError(doc, cause.message); return false; }
    finally { if (exists(doc) && expected === doc.readSequence) { doc.loading = false; update(); } }
  }
  async function openFile(entry) {
    if (uiLocked()) return false;
    const existing = documents.find(doc => doc.path === entry.path && doc.aliases.has(entry.cwd));
    if (existing) { activate(existing); return existing.file ? true : ensureLoaded(existing); }
    const doc = makeDocument(entry); activate(doc);
    return readDocument(doc, true);
  }
  async function syncDocument(doc) {
    if (!doc?.file || !exists(doc) || doc.loading || doc.saving || doc.checking || doc.composing || doc.comparing || comparison === doc && $('fileConflictDialog').open || uiLocked()) return;
    if (doc.preview) {
      const version = doc.file.version, sequence = doc.readSequence;
      doc.checking = true;
      try {
        const result = await api(`/api/project/artifact?cwd=${encodeURIComponent(doc.file.cwd)}&path=${encodeURIComponent(doc.path)}&stamp=${encodeURIComponent(doc.file.stamp || '')}`);
        if (!exists(doc) || doc.loading || doc.file.version !== version || doc.readSequence !== sequence) return;
        doc.checkedAt = Date.now(); doc.syncError = '';
        if (!result.unchanged && result.version !== version) {
          const selection = document.getSelection?.();
          if (selection && !selection.isCollapsed && doc.previewHost.contains(selection.anchorNode)) doc.diskChanged = true;
          else await readPreview(doc, result);
        }
      }
      catch (error) { if (exists(doc) && doc.readSequence === sequence) doc.syncError = error.message; }
      finally { doc.checking = false; if (exists(doc)) update(); }
      return;
    }
    const version = doc.file.version, sequence = doc.readSequence;
    doc.checking = true;
    try {
      const result = await api(`/api/project/file?cwd=${encodeURIComponent(doc.file.cwd)}&path=${encodeURIComponent(doc.path)}&version=${encodeURIComponent(version)}`);
      if (!exists(doc) || doc.file.version !== version || doc.readSequence !== sequence || doc.loading || doc.saving || doc.composing || doc.comparing || comparison === doc && $('fileConflictDialog').open || uiLocked()) return;
      doc.checkedAt = Date.now(); doc.syncError = '';
      if (result.unchanged || result.version === version) return;
      const local = doc.view.input.value;
      const needsMerge = dirty(doc) && result.content !== doc.baseline && result.content !== local;
      const merged = needsMerge && doc.mergeBlockVersion !== result.version ? mergeEditorChanges(doc.baseline, local, result.content) : needsMerge ? null : result.content === doc.baseline ? local : result.content;
      if (merged === null || merged.length > doc.view.input.maxLength) {
        doc.diskChanged = true;
        setError(doc, '磁盘有新代码，与当前草稿无法自动合并。未保存编辑已保留。', true);
        return;
      }
      const { input } = doc.view;
      if (needsMerge) doc.mergeUndo = { content: local, baseline: doc.baseline, file: doc.file, after: merged, diskVersion: result.version, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, top: input.scrollTop, left: input.scrollLeft };
      else if (result.content === local) doc.mergeUndo = null;
      if (merged !== local) {
        const start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection;
        const top = input.scrollTop, left = input.scrollLeft;
        const [nextStart, nextEnd] = needsMerge ? relocatedSelection(local, merged, [start, end]) : [Math.min(start, merged.length), Math.min(end, merged.length)];
        input.value = merged;
        input.setSelectionRange(nextStart, nextEnd, direction);
        input.scrollTop = top; input.scrollLeft = left;
        doc.syncedAt = Date.now();
      }
      doc.file = result; doc.baseline = result.content;
      if (doc.diskChanged) { doc.error = ''; doc.conflict = false; }
      doc.diskChanged = false;
      doc.mergeBlockVersion = null;
    } catch (cause) {
      if (exists(doc) && doc.file?.version === version && doc.readSequence === sequence) doc.syncError = cause.message;
    } finally { doc.checking = false; if (exists(doc)) update(); }
  }
  async function refresh({ all = false, cwd } = {}) {
    const targets = all ? [...documents] : active ? [active] : [];
    for (const doc of targets) if (!cwd || doc.aliases.has(cwd)) await syncDocument(doc);
  }
  async function save(doc = active) {
    if (!doc || !exists(doc) || !writable(doc) || doc.saving || doc.loading) return false;
    if (!dirty(doc)) return true;
    const content = doc.view.input.value, file = doc.file;
    doc.readSequence++; doc.saving = true; setError(doc);
    try {
      const result = await api('/api/project/save', { cwd: file.cwd, path: file.path, version: file.version, content });
      if (!exists(doc)) return false;
      doc.file = result; doc.baseline = result.content;
      doc.mergeUndo = null; doc.mergeBlockVersion = null;
      doc.diskChanged = false; doc.syncError = ''; doc.checkedAt = Date.now();
      // Each file owns its textarea: a late save cannot replace another tab or newer typing.
      return !dirty(doc);
    } catch (cause) { setError(doc, cause.message, cause.status === 409); return false; }
    finally { doc.saving = false; update(); }
  }
  async function saveAll() {
    if (busySaving() || uiLocked()) return false;
    const targets = projectDocuments().filter(dirty); savingAll = true; update();
    try {
      for (const doc of targets) if (!(await save(doc))) { activate(doc); return false; }
      return !targets.some(dirty);
    } finally { savingAll = false; update(); }
  }
  function resolveGuard(answer) {
    if (!guard) return;
    const current = guard; guard = null; $('unsavedDialog').close(); update(); current.resolve(answer);
  }
  async function confirmChange(doc) {
    if (!exists(doc) || doc.saving) return false;
    if (!dirty(doc)) return true;
    if (guard) return false;
    activate(doc, { force: true });
    $('unsavedFilename').textContent = `${doc.cwd}/${doc.path}`;
    $('saveBeforeLeave').disabled = !writable(doc); $('discardFileChanges').disabled = false; $('cancelFileChange').disabled = false;
    const answer = new Promise(resolve => { guard = { doc, resolve }; });
    $('unsavedDialog').showModal(); $('cancelFileChange').focus(); update();
    return answer;
  }
  async function closeTab(id = active?.id) {
    const doc = documents.find(item => item.id === id);
    if (!doc || !sameProject(doc) || uiLocked() || savingAll || doc.closing || doc.saving) return false;
    doc.closing = true; update();
    try { if (!(await confirmChange(doc))) return false; removeDocument(doc); return true; }
    finally { doc.closing = false; update(); }
  }
  async function close() {
    if (uiLocked() || busySaving()) return false;
    closingAll = true; update();
    try {
      // Keep every tab until all confirmations succeed; cancel cannot discard an earlier draft.
      const targets = projectDocuments();
      for (const doc of targets) if (!(await confirmChange(doc))) return false;
      for (const doc of targets) removeDocument(doc);
      showEmpty(); return true;
    } finally { closingAll = false; update(); }
  }
  async function reload(doc = active) {
    if (!doc || uiLocked() || savingAll || doc.loading || doc.saving || !(await confirmChange(doc))) return false;
    return readDocument(doc);
  }

  $('editorSave').addEventListener('click', () => save());
  $('editorSaveAll').addEventListener('click', saveAll);
  $('editorClose').addEventListener('click', close);
  $('editorReload').addEventListener('click', () => reload());
  $('editorAttach').addEventListener('click', async () => {
    const doc = active;
    if (!doc?.file || !sameProject(doc) || doc.attaching) return;
    doc.attaching = true; update();
    try {
      await onAttach({ cwd: doc.cwd, path: doc.path });
    } catch (cause) { setError(doc, cause.message); }
    finally { doc.attaching = false; update(); }
  });
  $('editorLanguage').addEventListener('change', () => { if (active) active.language = $('editorLanguage').value; update(); });
  $('cancelFileChange').addEventListener('click', () => { if (!guard?.doc.saving) resolveGuard(false); });
  $('discardFileChanges').addEventListener('click', () => { if (!guard?.doc.saving) resolveGuard(true); });
  $('saveBeforeLeave').addEventListener('click', async () => {
    if (!guard) return;
    $('saveBeforeLeave').disabled = true; $('discardFileChanges').disabled = true; $('cancelFileChange').disabled = true;
    const saved = await save(guard.doc);
    $('cancelFileChange').disabled = false; resolveGuard(saved);
  });
  $('unsavedDialog').addEventListener('cancel', event => { event.preventDefault(); if (!guard?.doc.saving) resolveGuard(false); });
  async function showFileVersions(latestOnly = false) {
    const doc = active;
    if (!doc?.file || doc.saving || doc.loading || doc.comparing || uiLocked()) return;
    const version = doc.file.version; doc.comparing = true; update();
    try {
      const disk = await api(`/api/project/file?cwd=${encodeURIComponent(doc.file.cwd)}&path=${encodeURIComponent(doc.path)}`);
      if (!exists(doc) || active !== doc || uiLocked() || doc.file.version !== version) return;
      comparison = doc; $('localFileVersion').value = doc.view.input.value; $('diskFileVersion').value = disk.content;
      $('fileConflictDialog').classList.toggle('latest-only', latestOnly);
      $('fileConflictTitle').textContent = latestOnly ? '磁盘最新代码' : '文件版本对照';
      $('fileConflictDescription').textContent = latestOnly ? '这是刚从磁盘读取的最新代码。原来的未保存草稿仍保留在编辑器中。' : '左侧是未保存草稿，右侧是刚读取的磁盘代码。可复制需要保留的片段。';
      $('fileConflictDialog').showModal();
      if (latestOnly) $('diskFileVersion').focus();
    } catch (cause) { setError(doc, cause.message, true); }
    finally { doc.comparing = false; update(); }
  }
  $('compareFileVersions').addEventListener('click', () => showFileVersions());
  $('viewLatestFile').addEventListener('click', () => showFileVersions(true));
  $('undoFileSync').addEventListener('click', () => {
    const doc = active, saved = doc?.mergeUndo;
    if (!saved || doc.view.input.value !== saved.after || doc.loading || doc.saving || uiLocked()) return;
    doc.view.input.value = saved.content; doc.view.input.setSelectionRange(saved.start, saved.end, saved.direction);
    doc.view.input.scrollTop = saved.top; doc.view.input.scrollLeft = saved.left;
    doc.file = saved.file; doc.baseline = saved.baseline; doc.mergeUndo = null;
    doc.mergeBlockVersion = saved.diskVersion; doc.diskChanged = true;
    setError(doc, '已撤销最近一次自动合并，未保存编辑已保留。可查看磁盘最新代码。', true);
  });
  $('keepLocalVersion').addEventListener('click', () => { comparison = null; $('fileConflictDialog').close(); });
  $('loadDiskVersion').addEventListener('click', async () => {
    const doc = comparison; comparison = null; $('fileConflictDialog').close();
    if (doc && exists(doc)) await reload(doc);
  });
  document.addEventListener('keydown', event => {
    if (!visible() || document.querySelector('dialog[open]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (event.shiftKey) saveAll(); else if (!uiLocked() && !savingAll) save(); }
    const tabs = projectDocuments();
    if (event.ctrlKey && ['PageUp', 'PageDown'].includes(event.key) && tabs.length) {
      event.preventDefault(); const index = tabs.indexOf(active), step = event.key === 'PageUp' ? -1 : 1;
      activate(tabs[(index + step + tabs.length) % tabs.length]);
    }
  });
  document.addEventListener('workspace-layout', () => onChange());
  window.addEventListener('beforeunload', event => { persistSession(); if (anyDirty() || busySaving()) { event.preventDefault(); event.returnValue = ''; } });
  const poll = window.setInterval?.(() => { if (visible() && document.visibilityState !== 'hidden') void refresh(); }, 3000);
  window.addEventListener('focus', () => { if (visible()) void refresh({ all: true }); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && visible()) void refresh(); else persistSession(); });
  window.addEventListener('pagehide', event => { persistSession(); if (!event.persisted) window.clearInterval?.(poll); });
  for (const saved of savedSession.files) {
    const doc = makeDocument(saved); doc.sessionPosition = saved; doc.position = { top: saved.top, left: saved.left }; doc.language = saved.language; doc.previewState = saved.preview;
  }
  for (const saved of savedSession.projects) projectViews.set(saved.cwd, { id: documents.find(doc => doc.cwd === saved.cwd && doc.path === saved.active)?.id, visible: saved.visible });
  observer?.observe(emptyView.input); update();
  return {
    open: openFile, close, closeTab, save: () => save(), saveAll, refresh, setMarkdownMode,
    inspect(entry) { const doc = documents.find(item => item.path === entry.path && item.aliases.has(entry.cwd)); return doc?.file ? { ...doc.file, content: doc.view.input.value, dirty: dirty(doc), saving: doc.saving, loading: doc.loading } : null; },
    saveFile(entry) { return save(documents.find(item => item.path === entry.path && item.aliases.has(entry.cwd))); },
    hide() { rememberSource(active); $('fileEditor').hidden = true; $('appShell').classList.remove('editor-open'); floating.hide(); onChange(); queueSession(); },
    get current() { return active?.file ? { ...active.file, id: active.id, content: active.view.input.value, start: active.view.input.selectionStart, end: active.view.input.selectionEnd, composing: !!active.composing, loading: !!active.loading, preview: active.preview || markdownPreview(active), markdownMode: active.markdown?.mode, language: active.preview || markdownPreview(active) ? 'preview' : active.language === 'auto' ? detectLanguage(active.path) : active.language } : null; },
    previewCompletion(text = '', snapshot) {
      if (text && (!matches(snapshot) || snapshot.language !== 'sql' || snapshot.content.length > 200000)) return false;
      for (const doc of documents) { if (doc.view.ghost) { doc.view.ghost = null; doc.view.lastText = null; } }
      if (text) active.view.ghost = { text, snapshot };
      highlight(active); return true;
    },
    insertCompletion(text, snapshot, start = snapshot.start) {
      if (!matches(snapshot) || start < 0 || start > snapshot.start) return false;
      const { input } = active.view;
      active.view.ghost = null; input.focus({ preventScroll: true }); input.setSelectionRange(start, snapshot.end);
      // insertText keeps native browser undo history, unlike replacing .value.
      let inserted = false;
      try { inserted = !!input.ownerDocument.execCommand?.('insertText', false, text); } catch { /* Browser fallback. */ }
      if (!inserted) input.setRangeText(text, start, snapshot.end, 'end');
      update(); revealCaret(active); return true;
    },
    replace(content, expected) { if (!active?.file || active.id !== expected.id || active.view.input.value !== expected.content || !writable(active) || uiLocked()) return false; active.view.input.setRangeText(content, 0, active.view.input.value.length, 'preserve'); update(); return true; },
    setSearch(query, direction = 0) {
      if (query) setMarkdownMode('source');
      searchQuery = query;
      const found = searchState(active);
      if (direction && found.positions.length) found.index = (found.index + direction + found.positions.length) % found.positions.length;
      if (found.positions.length) {
        const input = active.view.input, start = found.positions[found.index];
        input.setSelectionRange(start, start + query.length);
        const lineHeight = parseFloat(window.getComputedStyle(input).lineHeight) || 22;
        input.scrollTop = Math.max(0, input.value.slice(0, start).split('\n').length - 4) * lineHeight;
        input.scrollLeft = 0;
        highlight(active);
        const mark = active.view.highlight.querySelector('[data-search-current]'), rect = mark?.getBoundingClientRect(), bounds = input.getBoundingClientRect();
        if (rect?.width && bounds.width) {
          if (rect.left < bounds.left + 16) input.scrollLeft = Math.max(0, input.scrollLeft + rect.left - bounds.left - 16);
          else if (rect.right > bounds.right - 24) input.scrollLeft += Math.min(rect.left - bounds.left - 16, rect.right - bounds.right + 24);
        }
      }
      highlight(active); queueSession();
    },
    select: selectText,
    snapshots() { return documents.filter(doc => dirty(doc)).map(doc => ({ cwd: doc.file.cwd, path: doc.path, version: doc.file.version, baseline: doc.baseline, content: doc.view.input.value })); },
    async restore(snapshots) { for (const snapshot of snapshots) { await openFile(snapshot); const doc = documents.find(item => item.path === snapshot.path && item.file?.cwd === snapshot.cwd); if (!doc || dirty(doc)) continue; doc.view.input.value = snapshot.content; doc.baseline = snapshot.baseline; if (doc.file.version !== snapshot.version) { doc.file.version = snapshot.version; setError(doc, '恢复的草稿与磁盘版本不同，请对照后保存。', true); } update(); } },
    get dirty() { return anyDirty(); }, get visible() { return visible(); },
    get cwd() { return project; },
    get locked() { return uiLocked() || savingAll; },
    get tabs() { return documents.map(doc => ({ id: doc.id, path: doc.path, cwd: doc.cwd, active: active === doc, dirty: dirty(doc), loading: doc.loading, saving: doc.saving })); },
    setProject(cwd) {
      if (cwd === project) return;
      closeTabMenu();
      if (project) projectViews.set(project, { id: active?.id, visible: visible() });
      if (active) { rememberSource(active); active.view.panel.hidden = true; }
      project = cwd; active = null;
      const saved = projectViews.get(cwd), tabs = projectDocuments(), next = tabs.find(doc => doc.id === saved?.id) || tabs.at(-1);
      if (next) { activate(next, { focus: false, restoring: !!next.sessionPosition }); if (saved?.visible === false) { $('fileEditor').hidden = true; $('appShell').classList.remove('editor-open'); floating.hide(); onChange(); } }
      else showEmpty();
    },
  };
}
