import { createImageAttachment } from './interactions.js';
import { currentRequest } from './message-timing.js';

const el = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };

const previewUrl = value => typeof value === 'string' && /^\/api\/attachments\/images\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

// Only actual tool-returned image references from this user request. Generated
// images, user attachments and paths mentioned in prose never become previews.
export function latestTestImage(thread, request = currentRequest(thread)) {
  if (!thread || request.user?.pending) return null;
  let unavailable = false;
  for (const item of [...request.items].reverse()) {
    if (!['mcpToolCall', 'dynamicToolCall'].includes(item.type)) continue;
    const images = (item.attachments || []).filter(image => image?.kind === 'image');
    if (!images.length) continue;
    const attachment = images.findLast(image => !image.unavailable && previewUrl(image.previewUrl));
    if (attachment) return { item, attachment, count: images.length, unavailable };
    unavailable = true;
  }
  return unavailable ? { unavailable: true, attachment: null } : null;
}

export function createTestPreview({ document = globalThis.document, getContext = () => ({}), now = Date.now } = {}) {
  const win = document.defaultView, make = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text, id, className = 'icon-button') => { const node = make('button', text, className); node.type = 'button'; node.id = id; return node; };
  const trigger = button('测试预览', 'testPreviewToggle', 'text-button'); trigger.setAttribute('aria-controls', 'testPreviewWindow'); trigger.setAttribute('aria-expanded', 'false');
  trigger.title = '查看当前提问中工具实际返回的最新图片';
  const toolbar = document.querySelector('.workspace-bar .topbar-actions');
  const shortcuts = toolbar || document.querySelector('.workspace-shortcuts') || document.querySelector('.conversation-actions');
  shortcuts.insertBefore(trigger, toolbar ? toolbar.firstChild : document.getElementById('toolboxButton') || [...shortcuts.children].find(node => node.textContent === '更多工具') || null);
  const pane = make('section', null, 'test-preview-window'); pane.id = 'testPreviewWindow'; pane.hidden = true;
  pane.setAttribute('role', 'region'); pane.setAttribute('aria-labelledby', 'testPreviewTitle');
  const header = make('header', null, 'test-preview-header'); header.id = 'testPreviewHandle'; header.tabIndex = 0;
  header.title = '拖动调整位置 · 方向键移动 · 右下角可调整大小';
  const title = make('strong', '测试预览'); title.id = 'testPreviewTitle';
  const actions = make('div', null, 'test-preview-actions');
  const zoom = button('↗', 'testPreviewZoom'); zoom.setAttribute('aria-label', '放大测试截图'); zoom.title = '查看大图与原尺寸'; zoom.disabled = true;
  const minimize = button('−', 'testPreviewMinimize'); minimize.setAttribute('aria-label', '收起测试预览'); minimize.setAttribute('aria-expanded', 'true'); minimize.title = '收起测试预览';
  const close = button('×', 'testPreviewClose'); close.setAttribute('aria-label', '关闭测试预览'); close.title = '关闭，本次提问不再自动弹出';
  actions.append(zoom, minimize, close); header.append(title, actions);
  const status = make('p', '等待工具返回截图', 'test-preview-status'); status.id = 'testPreviewStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const body = make('div', null, 'test-preview-body'); body.id = 'testPreviewBody';
  const empty = make('p', '本次提问还没有返回图片。浏览器仅返回文字状态时，这里会继续等待。', 'test-preview-empty');
  const imageHost = make('div', null, 'test-preview-image'); imageHost.id = 'testPreviewImage'; imageHost.hidden = true;
  body.append(empty, imageHost);
  const footer = make('footer', null, 'test-preview-footer'), source = make('span'), clock = make('span'); source.id = 'testPreviewSource'; clock.id = 'testPreviewTime';
  const download = make('a', '下载截图', 'text-button'); download.id = 'testPreviewDownload'; download.hidden = true;
  const note = make('span', '仅显示工具返回的图片，不是实时视频。', 'test-preview-note'); footer.append(source, clock, download, note);
  pane.append(header, status, body, footer); document.body.append(pane);
  let scope = '', suppressed = false, frame = null, imageRecord = null, image, pictureButton, pictureError, collapsed = false, failedImage = false, drag;
  const set = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  function expanded() { trigger.setAttribute('aria-expanded', String(!pane.hidden)); }
  function clear() {
    const dialog = document.querySelector('.image-preview-dialog');
    if (imageRecord && dialog?.open && dialog.querySelector('img')?.getAttribute('src') === imageRecord.previewUrl) dialog.close();
    imageHost.replaceChildren(); imageHost.hidden = true; empty.hidden = false;
    imageRecord = image = pictureButton = pictureError = frame = null; failedImage = false;
    zoom.disabled = true; download.hidden = true; download.removeAttribute('href'); set(source, ''); set(clock, '');
  }
  function show() { pane.hidden = false; suppressed = false; expanded(); clamp(); }
  function hide() { pane.hidden = true; suppressed = true; drag = null; expanded(); }
  function paintFrame(candidate, thread, live) {
    const key = `${candidate.item.id}:${candidate.attachment.previewUrl}`;
    if (frame?.key === key) return;
    const received = now(), history = !(live && thread.busy);
    const surface = candidate.item.surface;
    const label = surface?.kind === 'browser' ? `${surface.label || '浏览器'} · 浏览器截图` : surface?.kind === 'app' ? `${surface.label || '应用'} · 电脑操作截图` : '工具返回图片';
    frame = { key, received, history, itemId: candidate.item.id }; failedImage = false;
    const name = `${label} · ${history ? '历史记录' : '本页接收 ' + new Date(received).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`;
    if (!imageRecord) {
      imageRecord = { ...candidate.attachment, name };
      const figure = createImageAttachment(imageRecord, { compact: true, document });
      image = figure.querySelector('img'); pictureButton = figure.querySelector('button'); pictureError = figure.querySelector('.attachment-image-error');
      image.addEventListener('error', () => { failedImage = true; zoom.disabled = true; download.hidden = true; set(status, '图片已失效或无法读取，请重新打开会话核对。'); pane.dataset.state = 'unavailable'; });
      imageHost.append(figure);
    } else {
      Object.assign(imageRecord, candidate.attachment, { name }); image.alt = name;
      const caption = imageHost.querySelector('figcaption'); caption.textContent = name; caption.hidden = true;
      pictureButton.setAttribute('aria-label', `查看图片：${name}`); image.hidden = pictureButton.hidden = false; pictureError.hidden = true;
      if (image.getAttribute('src') !== imageRecord.previewUrl) image.src = imageRecord.previewUrl;
    }
    imageHost.hidden = false; empty.hidden = true; zoom.disabled = false;
    download.hidden = false; download.href = imageRecord.previewUrl; download.download = 'test-preview';
    set(source, label + (candidate.count > 1 ? ` · 本步骤 ${candidate.count} 张，显示最后一张` : ''));
    set(clock, history ? '历史图片 · 拍摄时间未记录' : `本页接收 ${new Date(received).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
    clock.title = '运行时未提供拍摄时间；接收时间仅表示本页首次收到这张图片的时间。';
  }
  function sync() {
    const context = getContext(), thread = context.cwd && context.thread?.cwd !== context.cwd ? null : context.thread;
    const request = currentRequest(thread), nextScope = JSON.stringify([thread?.id, thread?.cwd, request.key]);
    if (scope !== nextScope) { scope = nextScope; suppressed = false; clear(); }
    const candidate = latestTestImage(thread, request), live = context.live !== false && !thread?.runtimeStale;
    if (candidate?.attachment) paintFrame(candidate, thread, live);
    trigger.dataset.hasImage = String(!!frame); trigger.title = frame ? '查看当前提问中最新返回的工具图片' : '当前提问还没有工具图片，点击打开等待窗口';
    const timing = thread?.turnTimings?.find(turn => turn.id === request.turnId);
    const completion = timing?.status || thread?.completion;
    const waiting = thread?.requests?.length > 0;
    let text = !thread ? '选择会话后等待截图' : request.user?.pending ? '新提问发送中 · 等待截图' : !live ? '连接待同步' : waiting ? '等待确认' : thread.busy ? '正在执行' : completion === 'failed' || thread.error ? '任务未完成' : completion === 'interrupted' ? '任务已停止' : frame ? completion === 'completed' ? '本次任务已结束' : '任务状态待核对' : '等待工具返回截图';
    pane.dataset.state = !live ? 'stale' : waiting ? 'waiting' : thread?.busy ? 'running' : 'idle';
    if (frame) text += candidate?.unavailable ? ' · 新图片不可用，保留上一张' : !live ? ' · 保留最近截图' : ' · 最近返回的图片';
    else if (candidate?.unavailable) text = '工具返回的图片暂不可预览';
    if (failedImage) { text = '图片已失效或无法读取，请重新打开会话核对。'; pane.dataset.state = 'unavailable'; }
    set(status, text);
    if (candidate?.attachment && thread?.busy && live && !suppressed) show();
    expanded();
  }
  trigger.addEventListener('click', () => { if (pane.hidden) { show(); sync(); } else hide(); });
  close.addEventListener('click', () => { hide(); trigger.focus({ preventScroll: true }); });
  minimize.addEventListener('click', () => {
    collapsed = !collapsed; pane.classList.toggle('is-collapsed', collapsed); minimize.textContent = collapsed ? '+' : '−';
    minimize.setAttribute('aria-expanded', String(!collapsed)); minimize.setAttribute('aria-label', collapsed ? '展开测试预览' : '收起测试预览'); minimize.title = collapsed ? '展开测试预览' : '收起测试预览';
    body.hidden = footer.hidden = collapsed; clamp();
  });
  zoom.addEventListener('click', () => { if (!failedImage) pictureButton?.click(); });
  pane.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); hide(); trigger.focus({ preventScroll: true }); } });
  function clamp() {
    if (pane.hidden || !pane.style.left) return;
    const rect = pane.getBoundingClientRect();
    pane.style.left = Math.max(8, Math.min(parseFloat(pane.style.left), win.innerWidth - Math.min(rect.width, win.innerWidth - 16) - 8)) + 'px';
    pane.style.top = Math.max(8, Math.min(parseFloat(pane.style.top), win.innerHeight - Math.min(rect.height, win.innerHeight - 16) - 8)) + 'px';
  }
  function move(left, top) { pane.style.left = left + 'px'; pane.style.top = top + 'px'; pane.style.right = 'auto'; clamp(); }
  header.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button,a')) return;
    const rect = pane.getBoundingClientRect(); drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    header.setPointerCapture?.(event.pointerId); event.preventDefault();
  });
  header.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) move(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) header.addEventListener(type, () => { drag = null; });
  header.addEventListener('keydown', event => {
    if (event.target !== header) return;
    const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
    if (delta) { event.preventDefault(); const rect = pane.getBoundingClientRect(); move(rect.left + delta[0], rect.top + delta[1]); }
  });
  const observer = win.ResizeObserver ? new win.ResizeObserver(clamp) : null; observer?.observe(pane); win.addEventListener('resize', clamp);
  sync();
  return { sync, show() { show(); sync(); }, hide, destroy() { observer?.disconnect(); win.removeEventListener('resize', clamp); clear(); pane.remove(); trigger.remove(); } };
}

export function createGitSubmit({ api, getContext, getTabs = () => [], onPulled = () => {} }) {
  const menu = el('details', null, 'project-actions-menu');
  const trigger = el('summary', '⋯', 'icon-button'); trigger.setAttribute('aria-label', '项目更多操作'); trigger.title = '项目更多操作';
  const entry = el('button', 'Git 提交与推送', 'project-git-entry'), pullEntry = el('button', '拉取远程更新…', 'project-git-entry'); entry.type = pullEntry.type = 'button';
  const popup = el('div', null, 'project-git-popup'); popup.append(entry, pullEntry); menu.append(trigger, popup);
  document.querySelector('.breadcrumb').append(menu);
  const dialog = el('dialog', null, 'git-submit-dialog'); dialog.id = 'gitSubmitDialog'; dialog.setAttribute('aria-labelledby', 'gitSubmitHeading');
  dialog.innerHTML = `<header class="dialog-heading"><div><h2 id="gitSubmitHeading">Git 同步与提交</h2><p data-ui="project" class="field-hint"></p></div><button data-ui="close" class="icon-button" aria-label="关闭 Git 同步与提交">×</button></header>
    <div class="git-submit-meta"><span data-ui="branch"></span><span data-ui="remote"></span><span data-ui="ahead"></span><button data-ui="refresh" class="secondary-button">刷新状态</button><button data-ui="pull" class="secondary-button">拉取远程更新…</button></div>
    <p class="field-hint">拉取会下载当前上游并更新本地文件，仅允许快进；请先保存草稿并处理未提交修改。提交使用磁盘内容，推送包含全部未推送提交。计数基于最近同步，刷新状态不会访问远程。</p><p data-ui="pull-hint" class="field-hint"></p>
    <div class="git-submit-body"><section class="git-submit-list"><div class="git-submit-selection"><strong>变更文件</strong><button data-ui="all" class="text-button">全选</button><button data-ui="none" class="text-button">清空</button></div><div data-ui="files"></div></section><section class="git-submit-preview" aria-label="选中文件差异"><h3 data-ui="filename">选择文件查看差异</h3><pre data-ui="diff" tabindex="0"></pre></section></div>
    <footer><label>提交说明<textarea data-ui="message" rows="2" maxlength="1000" placeholder="简要说明这次修改…"></textarea></label><p data-ui="hint" class="field-hint"></p><p data-ui="status" role="status" aria-live="polite"></p><div class="git-submit-buttons"><span data-ui="count">已选 0 个文件</span><button data-ui="retry" class="secondary-button" hidden>核对 / 重试上次请求</button><button data-ui="push" class="secondary-button">仅推送已有提交…</button><button data-ui="commit" class="secondary-button">仅提交…</button><button data-ui="commit-push" class="primary-button">提交并推送…</button></div></footer>`;
  document.body.append(dialog);
  const $ = name => dialog.querySelector(`[data-ui="${name}"]`), drafts = new Map();
  let current, busy = false, loading = false, generation = 0, diffGeneration = 0;
  const scoped = (route, params = {}) => `${route}?${new URLSearchParams({ cwd: current.cwd, ...params })}`;
  function status(text, error = false) { $('status').textContent = text; $('status').className = error ? 'field-error' : ''; }
  function pullBlocked() {
    if (!current?.snapshot?.pullAvailable) return '当前服务尚未加载拉取功能，请稍后刷新。';
    const prefix = current.cwd.replace(/\/+$/, '') + '/';
    const dirty = getTabs().some(tab => tab.dirty && (tab.cwd === current.cwd || `${tab.path?.startsWith('/') ? '' : tab.cwd + '/'}${tab.path}`.startsWith(prefix)));
    return dirty ? '当前项目有未保存草稿，请先保存或自行处理后再拉取。' : current.snapshot.pullBlocked || '';
  }
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
    const pullReason = pullBlocked(); $('pull').disabled = locked || !!pullReason || !!current?.uncertain;
    $('pull').title = pullReason || '从当前上游下载并快进更新本地分支'; $('pull-hint').textContent = snapshot ? pullReason : '';
    $('retry').hidden = !current?.uncertain;
    $('count').textContent = `已选 ${current?.selected.size || 0} 个文件`;
    dialog.setAttribute('aria-busy', String(locked));
  }
  function render() {
    const state = current.snapshot; $('files').replaceChildren();
    $('branch').textContent = `分支：${state.branch || '游离 HEAD'}`;
    $('remote').textContent = state.tracking ? `上游：${state.tracking}` : '未设置上游'; $('remote').title = `拉取：${state.fetchUrl || '未配置'}\n推送：${state.remoteUrl || '未配置'}`;
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
    if (busy || loading) return; busy = true; current.uncertain = body; controls(); status(body.action === 'pull' ? '正在拉取远程更新，请勿关闭页面…' : body.action === 'push' ? '正在推送，请勿关闭页面…' : '正在提交，请勿关闭页面；如选择推送将继续执行…');
    try {
      const result = await api('/api/git/submit', body);
      current.uncertain = null;
      if (result.committed) { current.message = ''; $('message').value = ''; current.selected.clear(); }
      if (body.action === 'pull') {
        status(result.pulled ? result.updated ? `拉取成功，已更新到 ${result.head.slice(0, 8)}。` : '已同步远程，当前分支已包含全部上游提交。' : result.pullError || '拉取未确认成功，请刷新核对。', !result.pulled);
        if (result.pulled) await Promise.resolve(onPulled(body.cwd)).catch(() => status('拉取已成功，文件视图刷新失败，请手动刷新文件树。', true));
      } else status(`${result.committed ? `本地已提交 ${result.commit.slice(0, 8)}。` : ''}${result.pushed ? '推送成功。' : result.pushError || '尚未推送。'}`, !!result.pushError);
    } catch (error) {
      if (error.status >= 400) { current.uncertain = null; status(error.message, true); }
      else status(`请求未确认完成：${error.message}。请核对后使用“核对 / 重试上次请求”，不要重复执行。`, true);
    }
    finally { busy = false; controls(); await refresh({ preserveStatus: true }); }
  }
  async function submit(action) {
    if (busy || loading || !current.snapshot) return;
    const s = current.snapshot, selected = [...current.selected];
    if (action === 'pull') {
      const reason = pullBlocked(); if (reason || current.uncertain) { status(reason || '请先核对上次未确认的 Git 请求。', true); return; }
      if (!window.confirm(`拉取远程更新\n项目：${current.cwd}\n当前分支：${s.branch}\n来源：${s.tracking}\n${s.fetchUrl}\n将下载并更新本地文件；若分支已分叉，将停止并保留本地提交。\n确认拉取？`)) return;
      await execute({ cwd: current.cwd, version: s.version, head: s.head, action, confirmed: true, operationId: window.crypto.randomUUID() }); return;
    }
    const text = `${action === 'push' ? '仅推送已有提交' : `提交 ${selected.length} 个勾选文件（含其全部磁盘修改）`}\n项目：${current.cwd}\n分支：${s.branch}\n${action !== 'commit' ? `推送到：${s.tracking}\n${s.remoteUrl}\n包含此前 ${s.ahead ?? '数量未知的'} 个未推送提交。\n` : ''}${action !== 'push' ? `文件：\n${selected.join('\n')}\n说明：${current.message}\n` : ''}确认执行？`;
    if (!window.confirm(text)) return;
    await execute({ cwd: current.cwd, version: s.version, head: s.head, action, paths: selected, message: current.message, confirmed: true, operationId: window.crypto.randomUUID() });
  }
  async function show(cwd = getContext().cwd, { action } = {}) {
    if (busy) return; menu.open = false; if (!cwd) return;
    if (!drafts.has(cwd)) drafts.set(cwd, { cwd, selected: new Set(), message: '', snapshot: null, uncertain: null });
    current = drafts.get(cwd); $('project').textContent = cwd; $('message').value = current.message;
    $('files').replaceChildren(); $('diff').replaceChildren(); $('filename').textContent = '选择文件查看差异';
    for (const name of ['branch', 'remote', 'ahead', 'hint']) $(name).textContent = '';
    dialog.showModal(); const draft = current; await refresh();
    if (action === 'pull' && current === draft && dialog.open && !loading && current.snapshot) await submit('pull');
  }
  entry.onclick = () => void show(); $('close').onclick = () => { if (!busy) dialog.close(); };
  pullEntry.onclick = () => void show(getContext().cwd, { action: 'pull' });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { ++generation; ++diffGeneration; loading = false; });
  document.addEventListener('click', event => { if (!menu.contains(event.target)) menu.open = false; });
  menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; trigger.focus(); } });
  $('message').oninput = () => { current.message = $('message').value; controls(); };
  $('refresh').onclick = () => void refresh();
  $('all').onclick = () => { current.selected = new Set(current.snapshot.files.map(file => file.path)); render(); };
  $('none').onclick = () => { current.selected.clear(); render(); };
  for (const action of ['commit', 'commit-push', 'push', 'pull']) $(action).onclick = () => void submit(action);
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
  const menu = node('button', '更多工具', 'text-button'); menu.type = 'button'; menu.onclick = () => $('workbenchButton').click(); shortcuts.append(menu);
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
