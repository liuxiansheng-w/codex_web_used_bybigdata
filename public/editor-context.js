const $ = id => document.getElementById(id);
const MAX_EXCERPT = 12000;
const lineAt = (text, offset) => { let line = 1; for (let at = text.indexOf('\n'); at >= 0 && at < offset; at = text.indexOf('\n', at + 1)) line++; return line; };

// Only use the already open buffer. Never read files or persist their contents.
export function editorContextSnapshot(editor, cwd) {
  const file = editor.current;
  if (!editor.visible || globalThis.document?.getElementById('workspacePanes')?.classList.contains('toolbox-docked') || !file || file.external || file.cwd !== cwd || file.loading || file.composing || (file.preview && !file.markdownMode) || typeof file.content !== 'string') return null;
  const text = file.content, ranges = file.columnSelection ? file.selections : null;
  if (ranges && !ranges.some(range => range.end > range.start)) return null;
  const selected = ranges ? true : file.end > file.start;
  let start = ranges ? ranges[0].start : selected ? file.start : Math.max(0, file.start - MAX_EXCERPT / 2);
  if (!selected && text.length <= MAX_EXCERPT) start = 0;
  const end = ranges ? ranges.at(-1).end : Math.min(text.length, selected ? file.end : start + MAX_EXCERPT, start + MAX_EXCERPT);
  let excerpt = ranges ? '' : text.slice(start, end), partial = selected ? end < file.end : start > 0 || end < text.length;
  if (ranges) {
    const parts = []; let budget = MAX_EXCERPT;
    for (const range of ranges) {
      if (parts.length) { parts.push('\n'); budget--; }
      if (budget <= 0) break;
      const part = text.slice(range.start, Math.min(range.end, range.start + budget)); parts.push(part); budget -= part.length;
    }
    excerpt = parts.join('').slice(0, MAX_EXCERPT);
    partial = ranges.reduce((size, range) => size + range.end - range.start, ranges.length - 1) > MAX_EXCERPT;
  }
  const from = lineAt(text, start), to = lineAt(text, end);
  const dirty = editor.tabs.some(tab => tab.id === file.id && tab.dirty);
  const label = `${file.path.split('/').at(-1).slice(0, 180)}:${from}-${to} · ${ranges ? '列选区' : selected ? '选区' : partial ? '光标附近' : '当前文件'}${dirty ? ' · 未保存' : ''}${partial ? ' · 节选' : ''}`;
  const tabs = editor.tabs.filter(tab => tab.cwd === cwd && !tab.external && !tab.loading).slice(0, 8).map(tab => tab.path.slice(0, 200));
  return { cwd, path: file.path, label, text: `当前文件：${file.path}\n来源：发送时的编辑器快照${dirty ? '（尚未保存，可能与磁盘不同）' : ''}\n范围：第 ${from}–${to} 行${ranges ? '（矩形列选区，按行拼接）' : ''}${partial ? '（仅节选，未包含全文）' : ''}\n已打开文件（最多 8 个，仅路径）：${JSON.stringify(tabs)}\n\n${excerpt}` };
}

export function createEditorContext({ editor, getContext, storage = localStorage }) {
  const toggle = $('editorContextToggle'), preview = $('editorContextPreview'), summary = $('editorContextSummary'), content = $('editorContextText');
  let timer;
  const preferences = new Map();
  const key = () => `lemon:editorContext:${getContext().modelService || 'codex'}`;
  function enabled() { if (preferences.has(key())) return preferences.get(key()); try { const saved = storage.getItem(key()); return saved === null ? getContext().modelService !== 'cosmos' : saved === 'true'; } catch { return getContext().modelService !== 'cosmos'; } }
  function sync() {
    clearTimeout(timer);
    const on = enabled(), snapshot = on ? editorContextSnapshot(editor, getContext().cwd) : null;
    toggle.setAttribute('aria-pressed', String(on)); toggle.textContent = on ? '编辑器上下文：开' : '编辑器上下文：关';
    toggle.title = '发送时附加当前项目正在查看的代码片段；可展开预览，不会自动保存文件';
    preview.hidden = !snapshot;
    summary.textContent = snapshot?.label || '';
    if (content.textContent !== (snapshot?.text || '')) content.textContent = snapshot?.text || '';
    return snapshot;
  }
  function schedule(event) { if (event?.target && event.target !== document && event.target.id !== 'fileEditorText') return; clearTimeout(timer); timer = setTimeout(sync, 120); }
  toggle.addEventListener('click', () => { const value = !enabled(); preferences.set(key(), value); try { storage.setItem(key(), String(value)); } catch {} sync(); });
  document.addEventListener('selectionchange', schedule);
  document.addEventListener('workspace-layout', schedule);
  document.addEventListener('input', schedule);
  document.addEventListener('keyup', schedule);
  sync();
  return { sync, schedule, payload: () => enabled() ? editorContextSnapshot(editor, getContext().cwd) : null };
}

// Explicit TODO navigation is bounded in result count and scans only this buffer.
export function commentTodos(text) {
  const result = [], pattern = /^[ \t]*(?:--|\/\/|#|\/\*+|\*)[ \t]*TODO\b[^\r\n]*/gim;
  let match;
  while ((match = pattern.exec(text)) && result.length < 50) result.push({ start: match.index, end: match.index + match[0].length, line: lineAt(text, match.index), text: match[0].trim() });
  return { items: result, limited: !!match };
}

export function bindEditorTodos({ editor, onContext, status }) {
  const panel = $('editorTodos');
  $('editorTodo').addEventListener('click', () => {
    if (!panel.hidden) { panel.hidden = true; return; }
    const file = editor.current;
    if (!file || file.loading || file.preview) return status('请在源码中打开一个文本文件。');
    const { items, limited } = commentTodos(file.content); panel.replaceChildren();
    for (const todo of items) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'diagnostic';
      button.textContent = `${todo.line} · ${todo.text.slice(0, 180)} · 交给柠檬实现`;
      button.addEventListener('click', () => {
        const current = editor.current;
        if (current?.id !== file.id || current?.cwd !== file.cwd || current?.content !== file.content) { panel.hidden = true; return status('文件已切换或变化，请重新打开 TODO 列表。'); }
        const start = Math.max(0, todo.start - 2000), end = Math.min(file.content.length, todo.end + 2000, start + 8000);
        editor.select(todo.start, todo.end);
        onContext(`请实现以下 TODO；先结合现有代码核对要求。\n文件：${file.cwd}/${file.path}:${todo.line}\nTODO：${todo.text.slice(0, 2000)}\n以下为编辑器快照片段（可能尚未保存，非文件全文）：\n${file.content.slice(start, end)}`);
        panel.hidden = true; status('TODO 已加入聊天草稿，发送后开始处理。');
      }); panel.append(button);
    }
    panel.hidden = !items.length;
    status(items.length ? `找到 ${items.length} 个 TODO${limited ? '（仅显示前 50 个）' : ''}，点击加入聊天草稿。` : '当前文件没有以注释开头的 TODO。');
  });
}
