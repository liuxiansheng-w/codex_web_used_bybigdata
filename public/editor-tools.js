const $ = id => document.getElementById(id);
const SQL_WORDS = 'SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER CROSS FULL ON AND OR NOT GROUP BY ORDER ASC DESC HAVING INSERT INTO VALUES UPDATE SET CREATE TABLE CASE WHEN THEN ELSE END WITH DISTINCT COUNT SUM AVG MIN MAX AS UNION ALL LIMIT OFFSET IS NULL COALESCE CAST OVER PARTITION ROW_NUMBER BETWEEN IN LIKE EXISTS';
function insideSqlLiteral(text) {
  let state = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (state === '--') { if (char === '\n') state = ''; }
    else if (state === '/*') { if (char === '*' && next === '/') { state = ''; i++; } }
    else if (state) {
      if (char === '\\') i++;
      else if (char === state) { if (next === state) i++; else state = ''; }
    } else if (char === '-' && next === '-') { state = '--'; i++; }
    else if (char === '/' && next === '*') { state = '/*'; i++; }
    else if (["'", '"', '`'].includes(char)) state = char;
  }
  return !!state;
}
export function createInlineCompletion({ editor, api, getConfig = () => ({}), storage = localStorage, delay = 350 }) {
  const list = $('editorCompletionList'), toggle = $('editorAIToggle'), status = $('editorAIStatus');
  let enabled = true, signature = '', timer, request, revision = 0, ghost = null, words = [], wordFile = null, wordStart = 0, selected = 0, applying = false;
  const listeners = [], cache = new Map();
  let dismissed = '';
  let phase = '', progressTimer, requestStarted = 0;
  const retry = document.createElement('button'); retry.type = 'button'; retry.id = 'editorAIRetry'; retry.className = 'text-button';
  retry.textContent = '重试'; retry.setAttribute('aria-label', '重新生成 AI 续写'); retry.hidden = true; toggle.after(retry);
  try { enabled = storage.getItem('lemon:sqlInlineAI') !== 'false'; } catch {}
  const listen = (target, type, fn, capture = false) => { target.addEventListener(type, fn, capture); listeners.push(() => target.removeEventListener(type, fn, capture)); };
  const config = () => ({ ...getConfig(), dialect: $('sqlDialect').value });
  const eligible = file => file?.language === 'sql' && file.writable && !file.loading && !file.composing && file.start === file.end && file.content.length <= 200000 && editor.visible && !editor.locked && document.visibilityState !== 'hidden' && !document.querySelector('dialog[open]');
  const focused = () => document.activeElement === $('fileEditorText');
  function paint() {
    const elapsed = Math.floor((Date.now() - requestStarted) / 1000), pending = !!request;
    toggle.hidden = editor.current?.language !== 'sql'; toggle.setAttribute('aria-pressed', String(enabled)); toggle.setAttribute('aria-busy', String(pending));
    toggle.textContent = !enabled ? 'AI 已暂停' : pending ? `✦ 续写中 · ${elapsed} 秒` : phase === 'empty' ? '✦ 暂无建议' : phase === 'error' ? '✦ 续写失败' : '✦ AI 续写';
    toggle.title = `${status.textContent ? status.textContent + '\n' : ''}点击${enabled ? '暂停' : '开启'} AI 续写 · Tab 采纳 · Esc 忽略 · ⌥ / Alt + \\ 手动触发`;
    retry.hidden = toggle.hidden || !enabled || pending || !['empty', 'error'].includes(phase);
  }
  function feedback(nextPhase, message) { phase = nextPhase; status.textContent = message; paint(); }
  // Memory-only cache: exact document and suffix, project, file, model and
  // dialect identity. Never replay an answer against a changed SQL snapshot.
  const cacheKey = (file, cfg = config()) => file ? JSON.stringify([file.id, file.cwd, file.path, file.content, file.start, file.end, cfg.model, cfg.dialect]) : '';
  function remember(file, cfg, text) {
    const key = cacheKey(file, cfg); cache.delete(key); cache.set(key, { text, expires: Date.now() + (text ? 60000 : 10000) });
    while (cache.size > 20) cache.delete(cache.keys().next().value);
  }
  function display(text, file, cfg) {
    clearWords();
    if (!text) { feedback('empty', '暂无续写建议 · 点击重试或按 ⌥ / Alt + \\'); return; }
    if (editor.previewCompletion(text, file)) { ghost = { text, file, model: cfg.model, dialect: cfg.dialect }; feedback('ready', 'Tab 采纳 · Esc 忽略'); }
  }
  function reuse(file, cfg) {
    const key = cacheKey(file, cfg), saved = cache.get(key);
    if (!saved) return false;
    if (saved.expires < Date.now()) { cache.delete(key); return false; }
    cache.delete(key); cache.set(key, saved); display(saved.text, file, cfg); return true;
  }
  function clearWords() { words = []; wordFile = null; list.hidden = true; $('fileEditorText')?.removeAttribute('aria-activedescendant'); }
  function cancel() {
    revision++; clearTimeout(timer); request?.abort(); request = null; ghost = null;
    clearInterval(progressTimer); editor.previewCompletion(); clearWords(); feedback('', '');
  }
  function sync() {
    const file = editor.current, cfg = config();
    const next = JSON.stringify([file?.id, file?.cwd, file?.content, file?.start, file?.end, file?.language, file?.writable, file?.loading, file?.composing, editor.visible, editor.locked, cfg.model, cfg.available, cfg.dialect, enabled]);
    if (next !== signature) {
      const previous = ghost, consumed = file && previous ? file.start - previous.file.start : 0;
      const remainder = previous && eligible(file) && focused() && previous.file.id === file.id && previous.file.cwd === file.cwd && previous.file.path === file.path && previous.model === cfg.model && previous.dialect === cfg.dialect && consumed > 0 && consumed < previous.text.length && file.content === previous.file.content.slice(0, previous.file.start) + previous.text.slice(0, consumed) + previous.file.content.slice(previous.file.end) ? previous.text.slice(consumed) : '';
      signature = next; cancel();
      // Typing the beginning of visible ghost text consumes that part only;
      // it must not discard the rest and restart a slow model request.
      if (remainder && enabled) { remember(file, cfg, remainder); display(remainder, file, cfg); }
    }
    paint();
  }
  function chooseWord(index) {
    const word = words[index], file = wordFile, start = wordStart;
    if (!word || !file) return;
    applying = true; cancel(); editor.insertCompletion(word, file, start); applying = false; sync(); schedule();
  }
  function markWord() {
    [...list.children].forEach((button, index) => { button.setAttribute('aria-selected', String(index === selected)); });
    $('fileEditorText')?.setAttribute('aria-activedescendant', `sql-word-${selected}`);
    list.children[selected]?.scrollIntoView?.({ block: 'nearest' });
  }
  function showWords(manual = false) {
    const file = editor.current; clearWords();
    if (!file || !file.writable || file.composing || file.start !== file.end || !editor.visible || editor.locked || file.content.length > 200000 || (!manual && file.language !== 'sql')) return;
    const before = file.content.slice(0, file.start), prefix = before.match(/[A-Za-z_]\w*$/)?.[0] || '';
    if (!manual && !prefix) return;
    // Do not put keyword menus inside SQL comments or strings.
    if (file.language === 'sql' && insideSqlLiteral(before)) return;
    const vocabulary = file.language === 'sql' ? SQL_WORDS : 'def class import from return for while if elif else try except finally with lambda None True False print range enumerate len dict list str int';
    words = [...new Set([...vocabulary.split(' '), ...(file.content.match(/[A-Za-z_]\w+/g) || [])])].filter(word => word.toLowerCase().startsWith(prefix.toLowerCase()) && word.toLowerCase() !== prefix.toLowerCase()).slice(0, 20);
    if (!words.length) return;
    wordFile = file; wordStart = file.start - prefix.length; selected = 0;
    list.replaceChildren(); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '代码补全');
    for (const [index, word] of words.entries()) {
      const button = document.createElement('button'); button.type = 'button'; button.id = `sql-word-${index}`;
      button.textContent = word; button.setAttribute('role', 'option'); button.tabIndex = -1;
      button.addEventListener('mousedown', event => event.preventDefault()); button.addEventListener('click', () => chooseWord(index)); list.append(button);
    }
    const input = $('fileEditorText'), source = input.parentElement, lines = before.split('\n'); source.append(list);
    const measure = document.createElement('span'); measure.className = 'editor-completion-measure'; measure.textContent = lines.at(-1); source.append(measure);
    const x = measure.getBoundingClientRect().width; measure.remove();
    const y = 16 + lines.length * 22 - input.scrollTop;
    list.style.left = `${Math.max(0, Math.min(source.clientWidth - 240, 14 + x - input.scrollLeft))}px`;
    list.style.top = `${Math.max(0, Math.min(source.clientHeight - 180, y))}px`;
    list.hidden = false; markWord();
  }
  async function suggest(manual = false) {
    clearTimeout(timer);
    sync(); const file = editor.current, cfg = config();
    if (!eligible(file) || !focused() || !file.content.slice(0, file.start).trim()) return;
    if (!enabled) { if (manual) status.textContent = '请先开启 AI 续写'; return; }
    if (manual) dismissed = '';
    else if (dismissed === cacheKey(file, cfg) || reuse(file, cfg)) return;
    if (!cfg.available) { feedback('error', 'AI 尚未连接'); return; }
    request?.abort(); const controller = new AbortController(); request = controller;
    const version = ++revision; requestStarted = Date.now(); feedback('pending', 'AI 正在续写…');
    clearInterval(progressTimer); progressTimer = setInterval(paint, 1000);
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const result = await api('/api/project/complete', {
        cwd: file.cwd, path: file.path, model: cfg.model || '', dialect: cfg.dialect,
        before: file.content.slice(Math.max(0, file.start - 12000), file.start), after: file.content.slice(file.end, file.end + 4000),
        header: file.start > 12000 ? file.content.slice(0, Math.min(4000, file.start - 12000)) : '',
      }, { signal: controller.signal });
      if (version !== revision || controller.signal.aborted || !focused()) return;
      sync();
      if (version !== revision || !eligible(editor.current)) return;
      const text = result.completion;
      if (typeof text !== 'string' || text.length > 2400 || text.split('\n').length > 24 || /```|[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) { feedback('error', '本次建议格式不可用 · 点击重试'); return; }
      remember(file, cfg, text.trim() ? text : ''); display(text.trim() ? text : '', file, cfg);
    } catch (error) {
      if (version === revision) feedback('error', controller.signal.aborted || error.status === 504 ? '续写超时 · 点击重试' : error.message || 'AI 暂不可用');
    } finally { clearTimeout(timeout); if (request === controller) { request = null; clearInterval(progressTimer); paint(); } }
  }
  function schedule() {
    clearTimeout(timer);
    const file = editor.current, cfg = config();
    if (applying || !enabled || !eligible(file) || !focused() || ghost || request || !file.content.slice(0, file.start).trim() || dismissed === cacheKey(file, cfg)) return;
    if (reuse(file, cfg)) return;
    timer = setTimeout(() => suggest(), delay);
  }
  function continueAtCursor(event) {
    if (event.target !== $('fileEditorText') || applying || event.isComposing || words.length) return;
    sync();
    // This is document/cursor driven, not a list of SQL trigger keywords.
    schedule();
  }
  function inputChanged(event) {
    if (event.target !== $('fileEditorText') || applying) return;
    sync(); if (!eligible(editor.current) || event.isComposing) return;
    if (!ghost) showWords(); schedule();
  }
  listen(document, 'input', inputChanged);
  listen(document, 'compositionend', inputChanged);
  listen(document, 'keydown', event => {
    if (event.target !== $('fileEditorText') || event.isComposing || editor.current?.composing || document.querySelector('dialog[open]')) return;
    if (event.altKey && event.code === 'Backslash') { event.preventDefault(); clearTimeout(timer); suggest(true); return; }
    if (event.key === 'Escape') { if (ghost || words.length || request) event.preventDefault(); dismissed = cacheKey(editor.current); cache.delete(dismissed); cancel(); return; }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && ghost) {
      event.preventDefault(); const value = ghost; applying = true; cancel(); editor.insertCompletion(value.text, value.file); applying = false; sync(); schedule(); return;
    }
    if (words.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + words.length) % words.length; markWord(); return; }
    if (words.length && ['Tab', 'Enter'].includes(event.key) && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); chooseWord(selected); }
  }, true);
  listen(document, 'focusout', event => { if (event.target === $('fileEditorText') && event.relatedTarget !== retry) cancel(); });
  listen(retry, 'pointerdown', event => event.preventDefault());
  listen(retry, 'click', () => { $('fileEditorText').focus(); suggest(true); });
  listen(document, 'focusin', continueAtCursor);
  listen(document, 'click', continueAtCursor);
  listen(document, 'keyup', event => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) continueAtCursor(event); });
  listen(document, 'pointerdown', event => { if (event.target === $('fileEditorText')) cancel(); }, true);
  listen(document, 'scroll', event => { if (event.target === $('fileEditorText')) clearWords(); }, true);
  listen(document, 'selectionchange', () => { if (focused()) sync(); });
  listen(window, 'blur', cancel);
  listen(window, 'focus', () => { if (focused()) continueAtCursor({ target: $('fileEditorText') }); });
  listen(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') cancel(); else if (focused()) continueAtCursor({ target: $('fileEditorText') }); });
  listen(toggle, 'click', () => { enabled = !enabled; try { storage.setItem('lemon:sqlInlineAI', String(enabled)); } catch {} sync(); });
  listen($('model'), 'change', sync); listen($('sqlDialect'), 'change', sync);
  sync();
  return { sync, showWords, suggest, destroy() { cancel(); retry.remove(); cache.clear(); listeners.forEach(remove => remove()); } };
}

export function createEditorTools({ editor, api, notice, onContext, onPreview, completion }) {
  const status = text => { $('editorToolStatus').textContent = text; };
  const current = () => { const file = editor.current; if (!file) throw new Error('请先打开一个文本文件。'); return file; };
  const run = handler => async () => { try { await handler(); } catch (error) { status(error.message); } };
  function context(intent) {
    const file = current(), selected = file.content.slice(file.start, file.end);
    if (!selected) throw new Error('请先选中一段代码。');
    if (selected.length > 40000) throw new Error('选区过大，请选择少于 4 万字符。');
    const start = file.content.slice(0, file.start).split('\n').length, end = file.content.slice(0, file.end).split('\n').length;
    onContext(`${intent}\n文件：${file.cwd}/${file.path}:${start}-${end}（编辑器选区快照，可能尚未保存）\n\n${selected}`);
  }
  $('editorSelection').addEventListener('click', run(() => context('请结合以下代码继续处理：')));
  $('editorExplain').addEventListener('click', run(() => context('请解释以下代码，不要修改文件：')));
  $('editorModify').addEventListener('click', run(() => context('请先询问我的修改要求，再修改以下代码：')));
  $('editorPreview').addEventListener('click', run(() => { if (editor.setMarkdownMode?.('preview', { focus: true })) return; return onPreview(current()); }));
  $('editorMinimize').addEventListener('click', () => editor.hide());
  $('editorMoreToggle').addEventListener('click', () => { const expanded = $('editorAdvanced').hidden; $('editorAdvanced').hidden = !expanded; $('editorMoreToggle').setAttribute('aria-expanded', String(expanded)); });
  const find = $('editorFind'), findBar = $('editorFindBar');
  let composingFind = false;
  const search = (direction = 0) => editor.setSearch(find.value, direction);
  function openFind() {
    editor.setMarkdownMode?.('source');
    findBar.hidden = false; $('editorFindToggle').setAttribute('aria-expanded', 'true');
    search(); find.focus(); find.select();
  }
  function closeFind() {
    findBar.hidden = true; $('editorFindToggle').setAttribute('aria-expanded', 'false');
    editor.setSearch(''); $('fileEditorText').focus({ preventScroll: true });
  }
  $('editorFindToggle').addEventListener('click', () => { if (findBar.hidden) openFind(); else closeFind(); });
  $('editorFindClose').addEventListener('click', closeFind);
  find.addEventListener('compositionstart', () => { composingFind = true; });
  find.addEventListener('compositionend', () => { composingFind = false; search(); });
  find.addEventListener('input', event => { if (!composingFind && !event.isComposing) search(); });
  findBar.addEventListener('keydown', event => {
    if (composingFind || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.target === find || event.target === $('editorReplace'))) {
      event.preventDefault(); event.stopPropagation(); search(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(); }
  });
  $('editorFindNext').addEventListener('click', () => search(1));
  $('editorFindPrevious').addEventListener('click', () => search(-1));
  $('editorReplaceAll').addEventListener('click', run(() => {
    const file = current(), query = $('editorFind').value; if (!query) return;
    const count = file.content.split(query).length - 1; if (!count) return status('未找到匹配。');
    if (!confirm(`在当前编辑草稿中替换 ${count} 处？不会自动保存。`)) return;
    if (!editor.replace(file.content.replaceAll(query, () => $('editorReplace').value), file)) throw new Error('文件已切换或变化，请重试。');
    status(`已替换 ${count} 处，尚未保存。`);
  }));
  async function language(action) {
    const file = current(); status('正在本机静态处理，不执行代码…');
    const result = await api('/api/project/language', { content: file.content, language: file.language, dialect: $('sqlDialect').value, action });
    if (action === 'format') {
      if (!editor.replace(result.content, file)) throw new Error('处理期间文件已切换或编辑，未覆盖草稿，请重试。');
      status(`${result.engine}：格式化完成，尚未保存。`);
    } else {
      if (editor.current?.id !== file.id || editor.current?.content !== file.content) throw new Error('检查结果已过期，请重试。');
      status(result.engine); $('editorDiagnostics').replaceChildren();
      for (const diagnostic of result.diagnostics || []) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'diagnostic';
        const row = diagnostic.start_location?.row || 1, column = diagnostic.start_location?.column || 1;
        button.textContent = `${row}:${column} ${diagnostic.code || ''} ${diagnostic.message}`;
        button.addEventListener('click', () => { if (editor.current?.id !== file.id || editor.current?.content !== file.content) return status('结果已过期，请重新检查。'); const start = file.content.split('\n').slice(0, row - 1).reduce((n, line) => n + line.length + 1, 0) + column - 1; editor.select(start, start + 1); });
        $('editorDiagnostics').append(button);
      }
      $('editorDiagnostics').hidden = !result.diagnostics?.length;
    }
  }
  $('editorFormatCode').addEventListener('click', run(() => language('format')));
  $('editorCheckCode').addEventListener('click', run(() => language('check')));
  // Manual entry remains available alongside automatic suggestions.
  $('editorComplete').addEventListener('click', run(() => {
    if (completion) { $('fileEditorText').focus(); completion.showWords(true); return; }
    const file = current(), prefix = file.content.slice(0, file.start).match(/[A-Za-z_]\w*$/)?.[0] || '';
    const words = file.language === 'sql' ? 'SELECT FROM WHERE JOIN LEFT RIGHT GROUP BY ORDER HAVING INSERT UPDATE CREATE TABLE CASE WHEN THEN ELSE END WITH DISTINCT COUNT SUM AVG AS UNION ALL LIMIT' : 'def class import from return for while if elif else try except finally with lambda None True False print range enumerate len dict list str int';
    const candidates = [...new Set([...words.split(' '), ...(file.content.match(/[A-Za-z_]\w+/g) || [])])].filter(word => word.toLowerCase().startsWith(prefix.toLowerCase()) && word !== prefix).slice(0, 40);
    $('editorCompletionList').replaceChildren();
    for (const word of candidates) { const button = document.createElement('button'); button.type = 'button'; button.textContent = word; button.addEventListener('click', () => { if (editor.replace(file.content.slice(0, file.start - prefix.length) + word + file.content.slice(file.end), file)) editor.select(file.start - prefix.length + word.length); $('editorCompletionList').hidden = true; }); $('editorCompletionList').append(button); }
    $('editorCompletionList').hidden = !candidates.length; status(candidates.length ? '本地关键字/文档词补全；不读取数据库或 Python 类型信息。' : '没有匹配词。');
  }));
  document.addEventListener('keydown', event => {
    if (!editor.visible || document.querySelector('dialog[open]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); }
    if (event.ctrlKey && event.code === 'Space' && !editor.current?.preview) { event.preventDefault(); $('editorComplete').click(); }
  });
  return { status };
}
