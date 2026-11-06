export function createBrowserWorkspace({ root, api, getContext, notify = () => {} }) {
  const doc = root.ownerDocument, win = doc.defaultView;
  root.className = 'browser-workspace';
  root.innerHTML = `<div class="browser-tabs" role="tablist" aria-label="浏览器标签页"></div>
    <form class="browser-navigation"><button type="button" data-action="back" title="后退" aria-label="浏览器后退">←</button><button type="button" data-action="forward" title="前进" aria-label="浏览器前进">→</button><button type="button" data-action="reload" title="刷新网页" aria-label="刷新网页">↻</button><input name="url" type="text" autocomplete="off" spellcheck="false" placeholder="输入网址，按 Enter 打开" aria-label="浏览器地址"><button type="submit" title="打开网址">前往</button><button type="button" data-new title="新标签页" aria-label="新建浏览器标签页">＋</button></form>
    <div class="browser-options"><label><input type="checkbox" data-share>允许本聊天的 AI 操作</label><button type="button" class="text-button" data-copy>复制网页选中文字</button><button type="button" class="text-button" data-settings>下载设置</button></div>
    <section class="browser-settings" hidden><h3>浏览器下载</h3><form data-download-settings><label>默认下载目录<input name="directory" required aria-label="默认下载目录"></label><div class="inline-fields"><button type="button" data-browse>选择目录…</button><button type="button" data-reset>恢复默认目录</button></div><label class="risk-confirm"><input name="ask" type="checkbox"><span>每次下载都询问保存位置</span></label><button type="submit" class="secondary-button">保存下载设置</button><button type="button" data-refresh-settings>刷新</button></form><div class="browser-directory-picker" hidden></div><p class="field-hint">文件保存到运行本工作台的 Mac；同名文件不会覆盖。</p></section>
    <p class="browser-status field-hint" role="status"></p>
    <div class="browser-viewport" tabindex="0" role="group" aria-label="共享网页画面，点击后可输入，Esc 返回地址栏"><img alt="共享浏览器实时画面" draggable="false" hidden><div class="browser-empty"><strong>本机共享浏览器</strong><p>在地址栏打开网页。你和 AI 使用同一组标签页。</p><p>使用独立 Chrome 登录状态，首次访问需要在这里登录。</p><button type="button" data-open class="primary-button">打开新标签页</button></div><textarea class="browser-keyboard" aria-label="网页键盘输入" autocapitalize="off" autocomplete="off" spellcheck="false"></textarea></div>
    <p class="browser-caption field-hint">实时画面约每秒更新 · Esc 返回地址栏 · 只读和计划模式的 AI 只能查看</p><div class="browser-downloads" aria-label="浏览器下载记录"></div>`;
  const tabs = root.querySelector('.browser-tabs'), nav = root.querySelector('.browser-navigation'), address = nav.elements.url, image = root.querySelector('img'), viewport = root.querySelector('.browser-viewport'), keyboard = root.querySelector('textarea'), empty = root.querySelector('.browser-empty'), status = root.querySelector('[role=status]'), sharing = root.querySelector('[data-share]'), settingsPanel = root.querySelector('.browser-settings'), settingsForm = root.querySelector('[data-download-settings]'), picker = root.querySelector('.browser-directory-picker'), downloads = root.querySelector('.browser-downloads');
  const states = new Map(); let visible = false, timer, generation = 0, contextKey = '', sequence = Promise.resolve(), busy = 0, frameUrl, settings, settingBusy = false, downloading = new Set(), frameRead = 0;
  const scope = () => ({ cwd: getContext().cwd, threadId: getContext().thread?.id });
  const scoped = route => `${route}?cwd=${encodeURIComponent(scope().cwd)}${scope().threadId ? `&threadId=${encodeURIComponent(scope().threadId)}` : ''}`;
  const hint = text => { status.textContent = text || ''; };
  function state() { const cwd = scope().cwd; if (!states.has(cwd)) states.set(cwd, { tabs: [], active: null, shared: false, downloads: [] }); return states.get(cwd); }
  const tab = () => state().tabs.find(item => item.id === state().active);
  const button = (text, run) => { const el = doc.createElement('button'); el.type = 'button'; el.textContent = text; el.addEventListener('click', run); return el; };
  function render() {
    const value = state(), active = tab(); tabs.replaceChildren();
    for (const item of value.tabs) {
      const row = doc.createElement('div'); row.className = 'browser-tab';
      const select = button(item.title || item.url || '新标签页', () => { value.active = item.id; frameRead++; render(); void refreshFrame(); }); select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(item.id === value.active)); select.title = item.url; select.tabIndex = item.id === value.active ? 0 : -1;
      const close = button('×', () => act({ action: 'close', tabId: item.id })); close.setAttribute('aria-label', `关闭浏览器标签 ${item.title || '新标签页'}`); row.append(select, close); tabs.append(row);
    }
    for (const control of nav.querySelectorAll('[data-action]')) control.disabled = !active || busy > 0;
    if (doc.activeElement !== address) address.value = active?.url === 'about:blank' ? '' : active?.url || '';
    sharing.disabled = !scope().threadId; sharing.checked = value.shared; sharing.title = scope().threadId ? '仅当前服务连接期间生效；关闭后 AI 无法操作这些网页' : '请先打开或创建聊天';
    empty.hidden = !!active; if (!active) image.hidden = true;
    renderDownloads();
  }
  function refreshContext() {
    const key = JSON.stringify(scope()); if (key === contextKey) return;
    contextKey = key; generation++; frameRead++; settingsPanel.hidden = true; picker.hidden = true; settings = null;
    image.hidden = true; if (frameUrl) { URL.revokeObjectURL(frameUrl); frameUrl = null; }
    render(); hint(''); if (visible) void poll();
  }
  function apply(result) {
    const value = state(); value.tabs = result.tabs; value.shared = result.shared; value.downloads = result.downloads; if (result.downloadError) hint(result.downloadError);
    if (!value.tabs.some(item => item.id === value.active)) value.active = value.tabs.at(-1)?.id || null;
    render();
  }
  async function poll() {
    clearTimeout(timer); const at = generation;
    if (!visible || doc.hidden || !scope().cwd) { if (visible) timer = setTimeout(poll, 1500); return; }
    try { const result = await api(scoped('/api/browser')); if (at !== generation || !visible) return; if (!busy) apply(result); await refreshFrame(); }
    catch (error) { if (at === generation && visible) hint(error.message); }
    finally { if (at === generation && visible) timer = setTimeout(poll, 800); }
  }
  async function refreshFrame() {
    const active = tab(); if (!visible || !active || busy || doc.hidden) return;
    const at = generation, read = ++frameRead, id = active.id;
    try {
      const response = await win.fetch(`/api/browser/frame?cwd=${encodeURIComponent(scope().cwd)}&tabId=${encodeURIComponent(id)}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || '网页画面暂不可用。'); }
      const blob = await response.blob();
      if (at !== generation || read !== frameRead || !visible || tab()?.id !== id || busy) return;
      const revision = Number(response.headers.get('X-Browser-Revision')); if (Number.isSafeInteger(revision)) active.revision = Math.max(active.revision, revision);
      const next = URL.createObjectURL(blob); image.src = next; image.hidden = false; if (frameUrl) URL.revokeObjectURL(frameUrl); frameUrl = next;
    } catch (error) { if (at === generation && read === frameRead) hint(error.message); }
  }
  function act(body) {
    const expected = generation, project = scope().cwd, id = body.tabId || tab()?.id;
    busy++; render();
    const operation = sequence.catch(() => {}).then(async () => {
      if (expected !== generation || !visible) return;
      const active = state().tabs.find(item => item.id === id);
      const result = await api('/api/browser/action', { ...body, cwd: project, ...(id ? { tabId: id } : {}), ...(active ? { revision: active.revision } : {}) });
      if (expected !== generation) return;
      if (body.action === 'new') { state().tabs.push(result); state().active = result.id; }
      else if (body.action === 'close') { state().tabs = state().tabs.filter(item => item.id !== id); state().active = state().tabs.at(-1)?.id || null; }
      else if (active && result.revision) { Object.assign(active, result); }
      hint(''); return result;
    }).catch(error => { if (expected === generation) hint(error.message); });
    sequence = operation;
    return operation.finally(() => { busy--; if (expected === generation) { render(); if (!busy) { void refreshFrame(); } } });
  }
  nav.addEventListener('submit', event => { event.preventDefault(); if (!address.value.trim()) return; void act({ action: tab() ? 'navigate' : 'new', url: address.value.trim() }); address.blur(); });
  for (const control of nav.querySelectorAll('[data-action]')) control.addEventListener('click', () => act({ action: control.dataset.action }));
  for (const control of root.querySelectorAll('[data-new],[data-open]')) control.addEventListener('click', () => act({ action: 'new', url: 'about:blank' }));
  tabs.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const list = state().tabs, at = list.findIndex(item => item.id === state().active); if (!list.length) return; state().active = list[event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length].id; render(); tabs.querySelector('[aria-selected=true]')?.focus(); void refreshFrame(); });
  sharing.addEventListener('change', async () => {
    const at = generation, enabled = sharing.checked; sharing.disabled = true;
    try { const result = await api('/api/browser/share', { ...scope(), enabled }); if (at === generation) { apply(result); hint(enabled ? '已共享给本聊天，AI 可查看和操作当前项目的浏览器标签。' : '已关闭本聊天的浏览器共享。'); } }
    catch (error) { if (at === generation) { sharing.checked = !enabled; hint(error.message); } }
    finally { if (at === generation) sharing.disabled = !scope().threadId; }
  });
  image.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !tab()) return; event.preventDefault();
    const rect = image.getBoundingClientRect();
    keyboard.focus({ preventScroll: true });
    void act({ action: 'click', x: (event.clientX - rect.left) * 1100 / rect.width, y: (event.clientY - rect.top) * 760 / rect.height, double: event.detail > 1 });
  });
  viewport.addEventListener('click', event => { if (event.target === viewport) keyboard.focus(); });
  let wheel, wheelX = 0, wheelY = 0;
  viewport.addEventListener('wheel', event => { if (!tab()) return; event.preventDefault(); wheelX += event.deltaX; wheelY += event.deltaY; clearTimeout(wheel); wheel = setTimeout(() => { void act({ action: 'scroll', deltaX: Math.max(-2000, Math.min(2000, wheelX)), deltaY: Math.max(-2000, Math.min(2000, wheelY)) }); wheelX = wheelY = 0; }, 65); }, { passive: false });
  keyboard.addEventListener('input', event => { if (event.isComposing) return; const text = keyboard.value; keyboard.value = ''; if (text) void act({ action: 'type', text }); });
  keyboard.addEventListener('compositionend', () => { const text = keyboard.value; keyboard.value = ''; if (text) void act({ action: 'type', text }); });
  keyboard.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); address.focus(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); address.focus(); address.select(); return; }
    const supported = ['Enter', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); void act({ action: 'press', key: event.metaKey ? 'Meta+A' : 'Control+A' }); }
    else if (supported.includes(event.key)) { event.preventDefault(); void act({ action: 'press', key: `${event.shiftKey ? 'Shift+' : ''}${event.key}` }); }
  });
  root.querySelector('[data-copy]').addEventListener('click', async () => { const result = await act({ action: 'copy-selection' }); if (typeof result?.text === 'string') { try { await win.navigator.clipboard.writeText(result.text); notify('已复制网页选中文字。'); } catch { hint('剪贴板不可用。'); } } });
  function settingsControls() { for (const control of settingsForm.elements) control.disabled = settingBusy || !settings; }
  async function loadSettings() {
    const at = generation; settings = null; settingsControls();
    try { const value = await api('/api/browser/settings'); if (at !== generation) return; settings = value; settingsForm.elements.directory.value = value.directory; settingsForm.elements.ask.checked = value.ask; settingsControls(); }
    catch (error) { if (at === generation) hint(error.message); }
  }
  root.querySelector('[data-settings]').addEventListener('click', () => { settingsPanel.hidden = !settingsPanel.hidden; if (!settingsPanel.hidden && !settings) void loadSettings(); });
  root.querySelector('[data-refresh-settings]').addEventListener('click', loadSettings);
  async function saveSettings(reset = false) {
    if (settingBusy || !settings) return; const at = generation; settingBusy = true; settingsControls();
    try { const value = await api('/api/browser/settings', { revision: settings.revision, directory: settingsForm.elements.directory.value, ask: settingsForm.elements.ask.checked, reset }); if (at === generation) { settings = value; settingsForm.elements.directory.value = value.directory; hint('下载设置已保存。'); } }
    catch (error) { if (at === generation) hint(error.message); }
    finally { settingBusy = false; if (at === generation) settingsControls(); }
  }
  settingsForm.addEventListener('submit', event => { event.preventDefault(); void saveSettings(); }); root.querySelector('[data-reset]').addEventListener('click', () => saveSettings(true));
  async function browse(path, choose) {
    const at = generation; picker.hidden = false; picker.textContent = '正在读取目录…';
    try {
      const result = await api(`/api/project/files?cwd=${encodeURIComponent(path)}`); if (at !== generation) return;
      picker.replaceChildren(); const location = doc.createElement('p'); location.textContent = result.cwd;
      picker.append(location, button('选择此目录', () => { choose(result.cwd); picker.hidden = true; }), button('上一级', () => browse(result.cwd.split('/').slice(0, -1).join('/') || '/', choose)));
      for (const item of result.entries.filter(entry => entry.kind === 'folder')) picker.append(button(`▸ ${item.name}`, () => browse(`${result.cwd === '/' ? '' : result.cwd}/${item.path || item.name}`, choose)));
      picker.append(button('取消选择', () => { picker.hidden = true; }));
    } catch (error) { if (at === generation) picker.textContent = error.message; }
  }
  root.querySelector('[data-browse]').addEventListener('click', () => browse(settingsForm.elements.directory.value, value => { settingsForm.elements.directory.value = value; }));
  function renderDownloads() {
    // Keep pending save forms and their typed filenames during polling.
    const value = state(); for (const row of downloads.children) if (!value.downloads.some(item => item.id === row.dataset.id)) row.remove();
    for (const item of value.downloads) {
      let row = [...downloads.children].find(row => row.dataset.id === item.id);
      if (!row) { row = doc.createElement('section'); row.className = 'browser-download'; row.dataset.id = item.id; downloads.append(row); }
      if (row.dataset.state === item.state && row.dataset.error === (item.error || '') && item.state !== 'downloading') continue;
      const draft = row.querySelector('form') ? { directory: row.querySelector('input[name=directory]')?.value, filename: row.querySelector('input[name=filename]')?.value } : null;
      row.dataset.state = item.state; row.dataset.error = item.error || ''; row.replaceChildren();
      const label = doc.createElement('strong'); label.textContent = item.name; const detail = doc.createElement('p'); detail.className = 'field-hint'; detail.textContent = item.savedPath ? `已保存：${item.savedPath}` : item.error || ({ downloading: `下载中 · ${Math.round(item.received / 1024)} KB`, pending: '下载完成，请选择保存位置', saving: '正在保存…', unknown: '下载结果待核对', failed: '下载未完成' })[item.state]; row.append(label, detail);
      if (!['saving', 'downloading'].includes(item.state)) row.append(button('移除记录', async () => {
        if (!win.confirm('移除这条下载记录，并将暂存副本移至废纸篓？已保存到目标目录的文件会保留。')) return;
        const at = generation; try { await api('/api/browser/download', { cwd: scope().cwd, id: item.id, action: 'dismiss' }); if (at === generation) await poll(); } catch (error) { if (at === generation) detail.textContent = error.message; }
      }));
      if (item.state === 'pending') {
        const form = doc.createElement('form'), target = doc.createElement('input'), name = doc.createElement('input'); target.name = 'directory'; target.value = draft?.directory ?? settings?.directory ?? ''; target.placeholder = '保存目录的绝对路径'; target.setAttribute('aria-label', `${item.name} 保存目录`); target.required = true; name.name = 'filename'; name.value = draft?.filename ?? item.name; name.setAttribute('aria-label', '下载文件名'); name.required = true;
        const save = button('保存文件', async () => {
          if (downloading.has(item.id) || !form.reportValidity()) return; const at = generation; downloading.add(item.id); save.disabled = true;
          try { await api('/api/browser/download', { cwd: scope().cwd, id: item.id, directory: target.value, name: name.value }); if (at === generation) await poll(); }
          catch (error) { if (at === generation) detail.textContent = error.message; }
          finally { downloading.delete(item.id); if (at === generation) save.disabled = false; }
        }); form.addEventListener('submit', event => { event.preventDefault(); save.click(); }); form.append(target, name, button('选择目录…', () => { settingsPanel.hidden = false; void browse(target.value || settings?.directory || '/', value => { target.value = value; }); }), save); row.append(form);
        if (!settings) void api('/api/browser/settings').then(value => { if (target.isConnected && !target.value) target.value = value.directory; }).catch(() => {});
      }
    }
  }
  doc.addEventListener('visibilitychange', () => { if (visible && !doc.hidden) void poll(); });
  return { setVisible(value) { visible = value; generation++; frameRead++; clearTimeout(timer); if (visible) { refreshContext(); void poll(); } else keyboard.blur(); }, sync() { refreshContext(); }, showSettings() { settingsPanel.hidden = false; void loadSettings(); }, get pending() { return busy > 0 || settingBusy || downloading.size > 0; } };
}
