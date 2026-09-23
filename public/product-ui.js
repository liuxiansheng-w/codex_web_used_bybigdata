const el = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };

export function createGitSubmit({ api, getContext }) {
  const menu = el('details', null, 'project-actions-menu');
  const trigger = el('summary', '⋯', 'icon-button'); trigger.setAttribute('aria-label', '项目更多操作'); trigger.title = '项目更多操作';
  const entry = el('button', 'Git 提交与推送', 'project-git-entry'); entry.type = 'button'; menu.append(trigger, entry);
  document.querySelector('.breadcrumb').append(menu);
  const dialog = el('dialog', null, 'git-submit-dialog'); dialog.id = 'gitSubmitDialog'; dialog.setAttribute('aria-labelledby', 'gitSubmitHeading');
  dialog.innerHTML = `<header class="dialog-heading"><div><h2 id="gitSubmitHeading">Git 提交与推送</h2><p data-ui="project" class="field-hint"></p></div><button data-ui="close" class="icon-button" aria-label="关闭 Git 提交">×</button></header>
    <div class="git-submit-meta"><span data-ui="branch"></span><span data-ui="remote"></span><span data-ui="ahead"></span><button data-ui="refresh" class="secondary-button">刷新</button></div>
    <p class="field-hint">提交磁盘上的文件内容，不包含未保存草稿。推送包含当前分支所有未推送提交；上游计数基于本机最近同步，不会自动拉取。不会运行 Git hooks 或签名。</p>
    <div class="git-submit-body"><section class="git-submit-list"><div class="git-submit-selection"><strong>变更文件</strong><button data-ui="all" class="text-button">全选</button><button data-ui="none" class="text-button">清空</button></div><div data-ui="files"></div></section><section class="git-submit-preview" aria-label="选中文件差异"><h3 data-ui="filename">选择文件查看差异</h3><pre data-ui="diff" tabindex="0"></pre></section></div>
    <footer><label>提交说明<textarea data-ui="message" rows="2" maxlength="1000" placeholder="简要说明这次修改…"></textarea></label><p data-ui="hint" class="field-hint"></p><p data-ui="status" role="status" aria-live="polite"></p><div class="git-submit-buttons"><span data-ui="count">已选 0 个文件</span><button data-ui="retry" class="secondary-button" hidden>核对 / 重试上次请求</button><button data-ui="push" class="secondary-button">仅推送已有提交…</button><button data-ui="commit" class="secondary-button">仅提交…</button><button data-ui="commit-push" class="primary-button">提交并推送…</button></div></footer>`;
  document.body.append(dialog);
  const $ = name => dialog.querySelector(`[data-ui="${name}"]`), drafts = new Map();
  let current, busy = false, loading = false, generation = 0, diffGeneration = 0;
  const scoped = (route, params = {}) => `${route}?${new URLSearchParams({ cwd: current.cwd, ...params })}`;
  function status(text, error = false) { $('status').textContent = text; $('status').className = error ? 'field-error' : ''; }
  function controls() {
    const locked = busy || loading, snapshot = current?.snapshot;
    for (const button of dialog.querySelectorAll('button')) button.disabled = locked;
    $('close').disabled = busy;
    $('message').disabled = locked;
    $('all').disabled = $('none').disabled = locked || !snapshot;
    for (const box of dialog.querySelectorAll('input[type="checkbox"]')) box.disabled = locked;
    $('commit').disabled = locked || !snapshot || !!snapshot.blocked || !current.selected.size || !current.message.trim() || !!current.uncertain;
    $('commit-push').disabled = $('commit').disabled || !!snapshot?.pushBlocked;
    $('push').disabled = locked || !snapshot?.head || !!snapshot?.pushBlocked || snapshot?.ahead === 0 || !!current.uncertain;
    $('retry').hidden = !current?.uncertain;
    $('count').textContent = `已选 ${current?.selected.size || 0} 个文件`;
    dialog.setAttribute('aria-busy', String(locked));
  }
  function render() {
    const state = current.snapshot; $('files').replaceChildren();
    $('branch').textContent = `分支：${state.branch || '游离 HEAD'}`;
    $('remote').textContent = state.tracking ? `目标：${state.tracking}` : '未设置上游'; $('remote').title = state.remoteUrl;
    $('ahead').textContent = `待推送 ${state.ahead ?? '未知'} · 落后 ${state.behind ?? '未知'}`;
    $('hint').textContent = [state.blocked || state.pushBlocked, state.excluded ? `${state.excluded} 项因隐藏、排除目录或特殊文件限制未列出。` : '', '未勾选的暂存内容不会纳入本次提交；重命名按删除＋新增列出，请同时勾选。'].filter(Boolean).join(' ');
    if (!state.files.length) $('files').append(el('p', '没有可提交的变更文件。', 'field-hint'));
    for (const file of state.files) {
      const row = el('div', null, 'git-submit-file'), box = el('input'); box.type = 'checkbox'; box.checked = current.selected.has(file.path); box.setAttribute('aria-label', `提交 ${file.path}`);
      box.onchange = () => { if (box.checked) current.selected.add(file.path); else current.selected.delete(file.path); controls(); };
      const name = el('button', file.path, 'git-submit-name'); name.title = file.path; name.onclick = () => void preview(file.path);
      const badge = el('code', file.status === '??' ? '新增' : file.status); badge.title = 'Git 状态：第一列暂存区，第二列工作区';
      row.append(box, name, badge); $('files').append(row);
    }
    controls();
  }
  async function refresh({ preserveStatus = false } = {}) {
    if (busy) return; const id = ++generation, draft = current; loading = true; controls();
    if (!preserveStatus) status('正在读取 Git 状态…');
    try {
      const snapshot = await api(scoped('/api/git/submit'));
      if (id !== generation || draft !== current) return;
      current.snapshot = snapshot; current.selected = new Set([...current.selected].filter(name => snapshot.files.some(file => file.path === name)));
      ++diffGeneration; $('filename').textContent = '选择文件查看差异'; $('diff').replaceChildren(); render();
      if (!preserveStatus) status('状态已更新。');
    } catch (error) { if (id === generation) { current.snapshot = null; status(error.status === 404 ? '当前服务尚未加载 Git 提交接口。请等全部运行任务结束后，通过现有服务管理器重启，再点击刷新。' : error.message, true); } }
    finally { if (id === generation) { loading = false; controls(); } }
  }
  async function preview(name) {
    const id = ++diffGeneration, draft = current; $('filename').textContent = name; $('diff').textContent = '正在读取差异…';
    try {
      const result = await api(scoped('/api/git/submit/diff', { path: name, version: current.snapshot.version }));
      if (id !== diffGeneration || current !== draft) return;
      $('diff').replaceChildren();
      for (const line of result.diff.split('\n')) $('diff').append(el('span', line + '\n', line.startsWith('+') ? 'git-line-add' : line.startsWith('-') ? 'git-line-delete' : line.startsWith('@@') ? 'git-line-hunk' : ''));
    } catch (error) { if (id === diffGeneration) $('diff').textContent = error.message; }
  }
  async function execute(body) {
    if (busy || loading) return; busy = true; current.uncertain = body; controls(); status(body.action === 'push' ? '正在推送，请勿关闭页面…' : '正在提交，请勿关闭页面；如选择推送将继续执行…');
    try {
      const result = await api('/api/git/submit', body);
      current.uncertain = null;
      if (result.committed) { current.message = ''; $('message').value = ''; current.selected.clear(); }
      status(`${result.committed ? `本地已提交 ${result.commit.slice(0, 8)}。` : ''}${result.pushed ? '推送成功。' : result.pushError || '尚未推送。'}`, !!result.pushError);
    } catch (error) {
      if (error.status >= 400) { current.uncertain = null; status(error.message, true); }
      else status(`请求未确认完成：${error.message}。请核对后使用“核对 / 重试上次请求”，不要重复创建提交。`, true);
    }
    finally { busy = false; controls(); await refresh({ preserveStatus: true }); }
  }
  async function submit(action) {
    if (busy || loading || !current.snapshot) return;
    const s = current.snapshot, selected = [...current.selected];
    const text = `${action === 'push' ? '仅推送已有提交' : `提交 ${selected.length} 个勾选文件（含其全部磁盘修改）`}\n项目：${current.cwd}\n分支：${s.branch}\n${action !== 'commit' ? `推送到：${s.tracking}\n${s.remoteUrl}\n包含此前 ${s.ahead ?? '数量未知的'} 个未推送提交。\n` : ''}${action !== 'push' ? `文件：\n${selected.join('\n')}\n说明：${current.message}\n` : ''}确认执行？`;
    if (!window.confirm(text)) return;
    await execute({ cwd: current.cwd, version: s.version, head: s.head, action, paths: selected, message: current.message, confirmed: true, operationId: window.crypto.randomUUID() });
  }
  async function show(cwd = getContext().cwd) {
    if (busy) return; menu.open = false; if (!cwd) return;
    if (!drafts.has(cwd)) drafts.set(cwd, { cwd, selected: new Set(), message: '', snapshot: null, uncertain: null });
    current = drafts.get(cwd); $('project').textContent = cwd; $('message').value = current.message;
    $('files').replaceChildren(); $('diff').replaceChildren(); $('filename').textContent = '选择文件查看差异';
    for (const name of ['branch', 'remote', 'ahead', 'hint']) $(name).textContent = '';
    dialog.showModal(); await refresh();
  }
  entry.onclick = () => void show(); $('close').onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { ++generation; ++diffGeneration; loading = false; });
  document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; trigger.focus(); } });
  $('message').oninput = () => { current.message = $('message').value; controls(); };
  $('refresh').onclick = () => void refresh();
  $('all').onclick = () => { current.selected = new Set(current.snapshot.files.map(file => file.path)); render(); };
  $('none').onclick = () => { current.selected.clear(); render(); };
  for (const action of ['commit', 'commit-push', 'push']) $(action).onclick = () => void submit(action);
  $('retry').onclick = () => { if (current.uncertain && window.confirm('使用同一操作标识核对上次请求；服务未重启时不会重复执行。若服务重启且状态变化，将拒绝旧请求。确认继续？')) void execute(current.uncertain); };
  window.addEventListener('beforeunload', event => { if (busy || [...drafts.values()].some(draft => draft.uncertain)) { event.preventDefault(); event.returnValue = ''; } });
  return { show, get busy() { return busy; } };
}

const $ = id => document.getElementById(id);
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };

export function createProductUI() {
  const surface = $('workSurface'), bar = document.querySelector('.topbar'); surface.prepend(bar);
  bar.classList.add('workspace-bar');
  const modes = node('div', '', 'workspace-modes'); modes.setAttribute('aria-label', '工作区布局');
  let mode = 'both', hadFile = false;
  try { mode = localStorage.getItem('lemon:workspaceMode') || 'both'; } catch {}
  if (!['chat', 'both', 'files'].includes(mode)) mode = 'both';
  for (const [value, label] of [['chat', '对话'], ['both', '并排'], ['files', '文件']]) {
    const button = node('button', label); button.type = 'button'; button.dataset.layoutMode = value;
    button.onclick = () => setMode(value); modes.append(button);
  }
  bar.querySelector('.breadcrumb').after(modes);
  const shortcuts = document.querySelector('.conversation-actions'); shortcuts.classList.add('workspace-shortcuts'); modes.after(shortcuts);
  // Keep detailed preferences here; the compact gallery trigger stays in the bar.
  const preferences = document.querySelector('[data-panel="preferences"]');
  preferences.prepend(node('p', '自动记住打开的文件标签和阅读位置。未保存内容是否恢复，由下方的本机草稿选项控制。', 'field-hint'));
  const appearance = node('div', '', 'appearance-settings'); appearance.append(node('strong', '外观'));
  appearance.append(document.querySelector('.appearance-picker'), $('themeToggle')); preferences.prepend(appearance);
  const menu = node('button', '工具', 'text-button'); menu.type = 'button'; menu.onclick = () => $('workbenchButton').click(); shortcuts.append(menu);
  $('workbenchButton').hidden = true;
  function setMode(value, persist = true) {
    mode = value; if (persist) try { localStorage.setItem('lemon:workspaceMode', value); } catch {}
    sync(); document.dispatchEvent(new document.defaultView.Event('workspace-layout'));
  }
  function sync({ restoring = false } = {}) {
    const open = !$('fileEditor').hidden;
    surface.dataset.mode = open ? mode : 'chat';
    for (const button of modes.children) { button.disabled = button.dataset.layoutMode !== 'chat' && !open; button.setAttribute('aria-pressed', String(button.dataset.layoutMode === surface.dataset.mode)); }
    if (open && !hadFile && mode === 'chat' && !restoring) setMode('both');
    hadFile = open;
  }
  const format = $('editorFormatCode'); $('editorMarkdownModes').before(format); format.className = 'text-button';
  // A direct file picker complements drag-and-drop; references remain in +.
  const attach = node('button', '附件', 'text-button'); attach.type = 'button'; attach.id = 'directAttach'; attach.onclick = () => $('chooseFiles').click(); $('addButton').parentElement.before(attach);
  const actions = document.querySelector('.quick-actions');
  const execution = node('details', '', 'composer-execution'); execution.append(node('summary', '计划与持续目标'), $('togglePlan'), $('addGoal')); actions.after(execution);
  $('recordSkill').hidden = true;
  $('fileSearch').placeholder = '搜索项目文件…'; $('fileSearch').setAttribute('aria-label', '搜索项目文件');
  document.querySelector('.file-tree-help').textContent = '点文件打开 · ＋ 加入对话';
  $('search').placeholder = '搜索会话…'; $('search').setAttribute('aria-label', '搜索会话');
  for (const p of document.querySelectorAll('.workbench-main .field-hint')) {
    if (p.closest('#turnChanges') || !p.textContent || p.textContent.length < 70) continue;
    const details = node('details', '', 'help-details'); details.append(node('summary', '使用说明')); p.before(details); details.append(p);
  }
  const links = document.querySelectorAll('[data-panel="git"] .field-hint');
  for (const p of links) if (p.textContent.includes('review/start')) p.textContent = '检查代码并给出建议，会使用当前模型额度。';
  const main = $('mainPanel'), history = $('historyPanel'), scroll = $('scrollArea');
  let readingPosition = 0;
  function setChatView(view) {
    const isHistory = view === 'history';
    if (isHistory && main.dataset.chatView !== 'history') readingPosition = scroll.scrollTop;
    main.dataset.chatView = view;
    history.hidden = !isHistory;
    $('chatHistoryTitle').hidden = !isHistory;
    $('chatHistoryButton').setAttribute('aria-label', isHistory ? '返回当前对话' : '返回会话列表');
    $('chatHistoryButton').title = isHistory ? '返回当前对话' : '返回会话列表';
    $('chatHistoryButton').setAttribute('aria-expanded', String(isHistory));
    if (!isHistory) scroll.scrollTop = readingPosition;
    document.dispatchEvent(new document.defaultView.Event('workspace-layout'));
  }
  function showConversation({ preserveLayout = false } = {}) {
    if (!preserveLayout) setMode(!$('fileEditor').hidden ? 'both' : 'chat', false);
    if (main.dataset.chatView === 'history') setChatView('conversation');
  }
  function showHistory({ focusSearch = false } = {}) {
    setMode(!$('fileEditor').hidden ? 'both' : 'chat', false);
    setChatView('history');
    if (focusSearch) $('search').focus();
    else ($('threadList').querySelector('[aria-current=true]') || $('threadList').querySelector('.thread-button') || $('search')).focus();
  }
  $('chatHistoryButton').addEventListener('click', () => {
    if (main.dataset.chatView === 'history') { showConversation(); $('prompt').focus(); }
    else showHistory();
  });
  $('chatSearchButton').addEventListener('click', () => showHistory({ focusSearch: true }));
  document.querySelector('.skip-link')?.addEventListener('click', event => { event.preventDefault(); showConversation(); $('prompt').focus(); });
  main.dataset.chatView = 'conversation';
  sync(); return { sync, showConversation, showHistory };
}
