import { mkdir, lstat, open, realpath, rename, writeFile, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserCdp } from './browser-cdp.mjs';
import { check, directory } from './workspace.mjs';

export function browserUrl(value) {
  check(typeof value === 'string' && value.length <= 8000, '请输入网页地址。');
  if (value === 'about:blank') return value;
  let url; try { url = new URL(value.includes('://') ? value : `https://${value}`); } catch { check(false, '网页地址无效。'); }
  check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password, '只支持不含账号密码的 HTTP / HTTPS 网页地址。');
  return url.href;
}
export function downloadName(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\\/\x00-\x1f\x7f]/.test(value) && !value.startsWith('.') && value.trim() === value, '下载文件名无效，请使用普通文件名。');
  return value;
}

const snapshotScript = `(() => {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const elements = [...document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(visible).slice(0,300);
  const refs = new Map(); const controls = elements.map((e,i) => { const ref = 'e'+(i+1), label = (e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.innerText || e.placeholder || e.name || e.tagName).trim().slice(0,160); refs.set(ref,{e,label}); return {ref,role:e.getAttribute('role')||e.tagName.toLowerCase(),type:e.type||'',label,disabled:!!e.disabled}; });
  globalThis.__lemonBrowserRefs = refs;
  return {title:document.title,url:location.href,text:(document.body?.innerText||'').slice(0,18000),controls};
})()`;

export class BrowserWorkspace {
  constructor({ stateDir, workspace, cdp, defaultDirectory = path.join(homedir(), 'Downloads'), trashRoot = path.join(homedir(), '.Trash') } = {}) {
    this.root = path.join(stateDir, 'browser'); this.workspace = workspace; this.defaultDirectory = defaultDirectory; this.trashRoot = trashRoot;
    this.cdp = cdp || new BrowserCdp({ profile: path.join(this.root, 'profile') });
    this.tabs = new Map(); this.shares = new Map(); this.queues = new Map(); this.downloads = new Map(); this.frames = new Map();
    this.downloadWrites = Promise.resolve(); this.loading = this.loadDownloads();
    this.blockedOrigins = new Set(['http://ningmeng.com', 'https://ningmeng.com']); this.settingsWriting = false;
    this.cdp.on('event', message => { void this.event(message).catch(() => {}); });
    this.cdp.on('offline', () => { this.downloadConfigured = false; this.tabs.clear(); this.shares.clear(); this.frames.clear(); for (const d of this.downloads.values()) if (d.state === 'downloading') { d.state = 'unknown'; d.error = '连接中断，下载结果待核对。'; } });
  }
  serialized(cwd, fn) {
    const previous = this.queues.get(cwd) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn); this.queues.set(cwd, next);
    return next.finally(() => { if (this.queues.get(cwd) === next) this.queues.delete(cwd); });
  }
  async start() {
    await this.loading;
    await mkdir(this.root, { recursive: true, mode: 0o700 }); const rootInfo = await lstat(this.root); check(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), '浏览器目录异常。', 503);
    await this.cdp.start();
    if (!this.downloadConfigured) {
      const staging = path.join(this.root, 'downloads'); await mkdir(staging, { recursive: true, mode: 0o700 }); const stagingInfo = await lstat(staging); check(stagingInfo.isDirectory() && !stagingInfo.isSymbolicLink(), '下载暂存目录异常。', 503);
      await this.cdp.call('Target.setDiscoverTargets', { discover: true });
      await this.cdp.call('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: staging, eventsEnabled: true }); this.downloadConfigured = true;
    }
  }
  blocked(value) {
    try { const url = new URL(value); return this.blockedOrigins.has(url.origin) || url.hostname === 'ningmeng.com' || ['file:', 'chrome:', 'devtools:', 'javascript:'].includes(url.protocol); } catch { return true; }
  }
  publicTab(tab) { return { id: tab.id, title: tab.title || '新标签页', url: tab.url, revision: tab.revision, width: 1100, height: 760 }; }
  async list(cwd, threadId) {
    await this.loading;
    const project = await directory(cwd), share = threadId && this.shares.get(threadId);
    return { cwd: project, downloadError: this.downloadError || (this.downloads.size >= 30 ? '下载记录已达到 30 条，请先移除部分记录。' : ''), tabs: [...this.tabs.values()].filter(tab => tab.cwd === project).map(tab => this.publicTab(tab)), shared: share?.cwd === project, downloads: [...this.downloads.values()].filter(item => item.cwd === project).map(({ guid, name, state, received, total, savedPath, error }) => ({ id: guid, name, state, received, total, savedPath, error })) };
  }
  async share({ cwd, threadId, enabled }) {
    const project = await directory(cwd); this.workspace.validId(threadId); check(typeof enabled === 'boolean', '共享选项无效。');
    const thread = await this.workspace.get(threadId); check(thread.cwd === project, '聊天不属于当前项目。', 409);
    if (enabled) this.shares.set(threadId, { cwd: project }); else this.shares.delete(threadId);
    return this.list(project, threadId);
  }
  async newTab(cwd, value = 'about:blank') {
    const url = browserUrl(value); check(!this.blocked(url), '不能在共享浏览器中打开工作台自身或本机文件。', 403);
    check(this.tabs.size < 16, '共享浏览器最多打开 16 个标签页，请先关闭部分标签。', 409);
    await this.start();
    const result = await this.cdp.call('Target.createTarget', { url: 'about:blank' });
    const attached = await this.cdp.call('Target.attachToTarget', { targetId: result.targetId, flatten: true });
    const tab = { id: randomUUID(), targetId: result.targetId, session: attached.sessionId, cwd, url: 'about:blank', title: '新标签页', revision: 1, origins: new Set(), world: null, snapshot: null }; this.tabs.set(tab.id, tab);
    try {
      await this.call(tab, 'Page.enable'); await this.call(tab, 'Runtime.enable');
      await this.call(tab, 'Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
      await this.call(tab, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      await this.call(tab, 'Page.setInterceptFileChooserDialog', { enabled: true });
      if (url !== 'about:blank') await this.navigate(tab, url, false);
      return this.publicTab(tab);
    } catch (error) { this.tabs.delete(tab.id); await this.cdp.call('Target.closeTarget', { targetId: tab.targetId }).catch(() => {}); throw error; }
  }
  call(tab, method, params = {}) { return this.cdp.call(method, params, tab.session); }
  tab(cwd, id) { const tab = this.tabs.get(id); check(tab?.cwd === cwd, '浏览器标签页已关闭或不属于当前项目。', 404); return tab; }
  invalidate(tab) { tab.revision++; tab.snapshot = null; }
  async evaluate(tab, expression) {
    if (!tab.world) {
      const { frameTree } = await this.call(tab, 'Page.getFrameTree');
      const { executionContextId } = await this.call(tab, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'lemon-browser' }); tab.world = executionContextId;
    }
    const result = await this.call(tab, 'Runtime.evaluate', { expression, contextId: tab.world, returnByValue: true, awaitPromise: false });
    check(!result.exceptionDetails, '页面已变化，请重新读取网页后操作。', 409); return result.result?.value;
  }
  async navigate(tab, value, model) {
    const url = browserUrl(value); check(!this.blocked(url), '不能打开工作台自身或本机文件。', 403);
    const origin = url === 'about:blank' ? null : new URL(url).origin;
    check(!model || !origin || tab.origins.has(origin), '请用户先在共享浏览器中打开这个网站，再让 AI 操作。', 403);
    if (origin && !model) tab.origins.add(origin);
    this.invalidate(tab); tab.world = null;
    const result = await this.call(tab, 'Page.navigate', { url });
    check(!result.errorText, '网页导航未完成，请检查地址或网络后重试。', 502);
    tab.url = url; return this.publicTab(tab);
  }
  async history(tab, direction) {
    const history = await this.call(tab, 'Page.getNavigationHistory'), entry = history.entries[history.currentIndex + direction];
    check(entry && !this.blocked(entry.url), '没有可返回的网页。', 409); this.invalidate(tab); tab.world = null;
    await this.call(tab, 'Page.navigateToHistoryEntry', { entryId: entry.id }); return this.publicTab(tab);
  }
  async image(cwd, id) {
    const project = await directory(cwd);
    return this.serialized(project, async () => { const tab = this.tab(project, id); const { data } = await this.call(tab, 'Page.captureScreenshot', { format: 'jpeg', quality: 72, captureBeyondViewport: false }); return { bytes: Buffer.from(data, 'base64'), type: 'image/jpeg', revision: tab.revision }; });
  }
  async snapshot(tab) {
    const value = await this.evaluate(tab, snapshotScript); tab.snapshot = { id: randomUUID(), revision: tab.revision, time: Date.now() };
    tab.title = value.title; tab.url = value.url; return { ...this.publicTab(tab), snapshotId: tab.snapshot.id, ...value };
  }
  async ref(tab, body, model) {
    check(typeof body.ref === 'string' && /^e\d{1,3}$/.test(body.ref), '请使用刚读取的网页控件编号。');
    check(tab.snapshot && body.snapshotId === tab.snapshot.id && tab.snapshot.revision === tab.revision && Date.now() - tab.snapshot.time < 120000, '页面或人工操作已变化，请重新读取网页再操作。', 409);
    const value = await this.evaluate(tab, `(() => { const item=globalThis.__lemonBrowserRefs?.get(${JSON.stringify(body.ref)}); if(!item?.e.isConnected) return null; const e=item.e,r=e.getBoundingClientRect(); if(e.disabled||r.width<=0||r.height<=0) return null; const label=(e.getAttribute('aria-label')||e.labels?.[0]?.innerText||e.innerText||e.placeholder||e.name||e.tagName).trim().slice(0,160); if(label!==item.label) return null; e.scrollIntoView({block:'center',inline:'nearest'}); const b=e.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2,password:e.type==='password',file:e.type==='file'}; })()`);
    check(value && !value.file && !(model && value.password), '该控件已变化或需要人工输入密码/选择文件，请在共享浏览器中处理。', 409); return value;
  }
  async press(tab, key) {
    check(typeof key === 'string', '按键无效。');
    const aliases = { Enter: ['Enter', 'Enter', 13], Tab: ['Tab', 'Tab', 9], Escape: ['Escape', 'Escape', 27], Backspace: ['Backspace', 'Backspace', 8], Delete: ['Delete', 'Delete', 46], ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40], ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39], Home: ['Home', 'Home', 36], End: ['End', 'End', 35], PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34], Space: [' ', 'Space', 32] };
    if (['Meta+A', 'Control+A'].includes(key)) { await this.call(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: key.startsWith('Meta') ? 4 : 2, commands: ['selectAll'] }); await this.call(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' }); return; }
    const shift = key.startsWith('Shift+'), value = aliases[shift ? key.slice(6) : key]; check(value, '此按键暂不支持。');
    const [name, code, windowsVirtualKeyCode] = value;
    await this.call(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode, modifiers: shift ? 8 : 0, ...(name === 'Enter' ? { text: '\r' } : {}) });
    await this.call(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode, modifiers: shift ? 8 : 0 });
  }
  async action(body, { model = false, project } = {}) {
    const cwd = project || await directory(body.cwd);
    return this.serialized(cwd, async () => {
      if (body.action === 'new') return this.newTab(cwd, body.url);
      const tab = this.tab(cwd, body.tabId);
      if (model && !['snapshot', 'copy-selection'].includes(body.action)) check(tab.snapshot && body.snapshotId === tab.snapshot.id && tab.snapshot.revision === tab.revision && Date.now() - tab.snapshot.time < 120000, '页面或人工操作已变化，请重新读取网页再操作。', 409);
      if (body.action === 'snapshot') return this.snapshot(tab);
      if (body.action === 'navigate') return this.navigate(tab, body.url, model);
      if (body.action === 'back' || body.action === 'forward') return this.history(tab, body.action === 'back' ? -1 : 1);
      if (body.action === 'reload') { this.invalidate(tab); tab.world = null; await this.call(tab, 'Page.reload'); return this.publicTab(tab); }
      if (body.action === 'close') { await this.cdp.call('Target.closeTarget', { targetId: tab.targetId }); this.tabs.delete(tab.id); return { closed: tab.id }; }
      if (body.action === 'copy-selection') return { text: String(await this.evaluate(tab, 'String(getSelection())')).slice(0,100000) };
      let target;
      if (model && ['click', 'type'].includes(body.action)) target = await this.ref(tab, body, true);
      if (!model) check(body.revision === tab.revision, '页面已变化，正在刷新画面，请再操作一次。', 409);
      if (body.action === 'click') {
        const x = target?.x ?? body.x, y = target?.y ?? body.y;
        check(Number.isFinite(x) && x >= 0 && x <= 1100 && Number.isFinite(y) && y >= 0 && y <= 760, '点击位置无效。');
        this.invalidate(tab); const args = { x, y, button: 'left', clickCount: body.double ? 2 : 1 };
        await this.call(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...args }); await this.call(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...args });
      } else if (body.action === 'type') {
        check(typeof body.text === 'string' && body.text.length <= 10000, '每次最多输入 10000 个字符。');
        if (model) { await this.call(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 }); await this.call(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 }); if (body.clear) { await this.press(tab, 'Control+A'); await this.press(tab, 'Backspace'); } }
        this.invalidate(tab); await this.call(tab, 'Input.insertText', { text: body.text });
      } else if (body.action === 'press') { this.invalidate(tab); await this.press(tab, body.key); }
      else if (body.action === 'scroll') {
        check([body.deltaX ?? 0, body.deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 2000), '滚动范围无效。'); this.invalidate(tab);
        await this.call(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 550, y: 380, deltaX: body.deltaX || 0, deltaY: body.deltaY });
      } else check(false, '未知浏览器操作。');
      return this.publicTab(tab);
    });
  }
  async modelCall(body, threadId) {
    const share = this.shares.get(threadId), thread = this.workspace.threads.get(threadId);
    check(share && thread?.cwd === share.cwd, '请用户在共享浏览器中为本聊天打开“允许 AI 操作”。', 403);
    check(thread.busy, '聊天当前没有运行中的任务。', 409);
    const read = ['list', 'snapshot', 'screenshot'].includes(body.action);
    check(read || this.workspace.resumed?.has(threadId) && thread.mode !== 'read-only' && !thread.plan, '当前聊天为只读、计划模式或尚未确认运行权限，只能查看网页。', 403);
    check(!['new', 'close'].includes(body.action), '新增和关闭标签页请由用户操作。', 403);
    if (body.action === 'list') return { content: [{ type: 'text', text: JSON.stringify(await this.list(share.cwd, threadId)) }] };
    if (body.action === 'screenshot') { const image = await this.image(share.cwd, body.tabId); return { content: [{ type: 'image', data: image.bytes.toString('base64'), mimeType: image.type }] }; }
    const result = await this.action(body, { model: true, project: share.cwd });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
  async event({ method, params: p, sessionId }) {
    const tab = [...this.tabs.values()].find(tab => tab.session === sessionId);
    if (method === 'Fetch.requestPaused') {
      const deny = this.blocked(p.request.url) || !/^(https?:|data:|blob:|about:)/.test(p.request.url);
      await this.cdp.call(deny ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId: p.requestId, ...(deny ? { errorReason: 'BlockedByClient' } : {}) }, sessionId); return;
    }
    if (tab && method === 'Page.frameNavigated') {
      this.frames.set(p.frame.id, tab.id);
      if (!p.frame.parentId) { tab.url = p.frame.url; tab.world = null; this.invalidate(tab); }
    }
    if (tab && method === 'Page.loadEventFired') { const meta = await this.evaluate(tab, '({title:document.title,url:location.href})'); tab.title = meta.title; tab.url = meta.url; }
    if (tab && method === 'Runtime.executionContextsCleared') tab.world = null;
    if (method === 'Target.targetInfoChanged') { const found = [...this.tabs.values()].find(tab => tab.targetId === p.targetInfo.targetId); if (found) found.title = p.targetInfo.title; }
    if (method === 'Target.targetDestroyed') { for (const [id, value] of this.tabs) if (value.targetId === p.targetId) this.tabs.delete(id); }
    if (method === 'Browser.downloadWillBegin') {
      const owner = this.tabs.get(this.frames.get(p.frameId));
      if (!owner || this.downloadError || this.downloads.size >= 30) { await this.cdp.call('Browser.cancelDownload', { guid: p.guid }); return; }
      let name; try { name = downloadName(p.suggestedFilename); } catch { name = 'download-' + Date.now(); }
      check(/^[a-zA-Z0-9-]{1,100}$/.test(p.guid), '下载编号异常。');
      this.downloads.set(p.guid, { guid: p.guid, cwd: owner.cwd, name, state: 'downloading', received: 0, total: 0 }); await this.persistDownloads();
    }
    if (method === 'Browser.downloadProgress') {
      const item = this.downloads.get(p.guid); if (!item) return;
      item.received = p.receivedBytes; item.total = p.totalBytes;
      if (p.receivedBytes > 512 * 1024 * 1024) { await this.cdp.call('Browser.cancelDownload', { guid: p.guid }); item.state = 'failed'; item.error = '下载超过 512 MB 限制。'; return; }
      if (p.state === 'canceled') { item.state = 'failed'; item.error = '下载已取消或中断。'; await this.persistDownloads(); }
      if (p.state === 'completed' && item.state === 'downloading') {
        item.state = 'pending'; await this.persistDownloads(); const settings = await this.settings();
        if (!settings.ask) await this.saveDownload({ cwd: item.cwd, id: item.guid, directory: settings.directory, name: item.name }).catch(error => { item.error = error.message; });
      }
    }
  }
  async loadDownloads() {
    let handle;
    try {
      const parent = await lstat(this.root); check(parent.isDirectory() && !parent.isSymbolicLink(), '下载记录目录异常。', 503);
      handle = await open(path.join(this.root, 'downloads.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat(); check(info.isFile() && info.size < 200000, '下载记录文件异常。', 503);
      const values = JSON.parse(await handle.readFile('utf8')); check(Array.isArray(values) && values.length <= 30, '下载记录格式异常。', 503);
      for (const item of values) {
        check(typeof item.guid === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(item.guid) && typeof item.cwd === 'string' && path.isAbsolute(item.cwd) && ['downloading', 'unknown', 'failed', 'pending', 'saving', 'saved'].includes(item.state), '下载记录格式异常。', 503); downloadName(item.name);
        if (['downloading', 'saving'].includes(item.state)) { item.state = 'unknown'; item.error = '服务重启，下载或保存结果待核对。'; }
        this.downloads.set(item.guid, item);
      }
    } catch (error) { if (error.code !== 'ENOENT') this.downloadError = '下载记录无法读取，请检查原记录文件，暂不接收新下载。'; }
    finally { await handle?.close(); }
  }
  persistDownloads() {
    const value = JSON.stringify([...this.downloads.values()]);
    const next = this.downloadWrites.catch(() => {}).then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 }); const info = await lstat(this.root); check(info.isDirectory() && !info.isSymbolicLink(), '下载记录目录异常。', 503);
      const temp = path.join(this.root, randomUUID() + '.tmp'); await writeFile(temp, value, { flag: 'wx', mode: 0o600 }); await rename(temp, path.join(this.root, 'downloads.json'));
    }); this.downloadWrites = next; return next;
  }
  async settings() {
    let handle;
    try {
      const parent = await lstat(this.root); check(parent.isDirectory() && !parent.isSymbolicLink(), '下载设置目录异常。', 503);
      handle = await open(path.join(this.root, 'settings.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat(); check(info.isFile() && info.size < 8192, '下载设置文件异常。', 503);
      const data = JSON.parse(await handle.readFile('utf8')); check(typeof data.directory === 'string' && typeof data.ask === 'boolean' && Number.isSafeInteger(data.revision), '下载设置格式异常。', 503);
      return { ...data, defaultDirectory: this.defaultDirectory };
    } catch (error) { if (error.code === 'ENOENT') return { revision: 0, directory: this.defaultDirectory, defaultDirectory: this.defaultDirectory, ask: false }; throw Object.assign(new Error('无法读取下载设置，请保留原文件并重试。'), { status: 503 }); }
    finally { await handle?.close(); }
  }
  async downloadDirectory(value) {
    const result = await directory(value);
    check(!result.split(path.sep).some(part => ['.ssh', '.aws', '.git', '.codex', '.config'].includes(part)), '请选择普通下载目录。');
    return result;
  }
  async updateSettings(body) {
    check(!this.settingsWriting, '下载设置正在保存。', 409); this.settingsWriting = true;
    try {
      const previous = await this.settings(); check(body.revision === previous.revision, '下载设置已变化，请刷新后保存。', 409); check(typeof body.ask === 'boolean', '下载选项无效。');
      const target = await this.downloadDirectory(body.reset ? this.defaultDirectory : body.directory);
      const value = { revision: previous.revision + 1, directory: target, ask: body.ask };
      await mkdir(this.root, { recursive: true, mode: 0o700 }); const info = await lstat(this.root); check(info.isDirectory() && !info.isSymbolicLink(), '下载设置目录异常。', 503);
      const temp = path.join(this.root, randomUUID() + '.tmp'); await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temp, path.join(this.root, 'settings.json')); return this.settings();
    } finally { this.settingsWriting = false; }
  }
  async dismissDownload(body) {
    const cwd = await directory(body.cwd), item = this.downloads.get(body.id); check(item?.cwd === cwd, '下载记录不存在。', 404); check(!['saving', 'downloading'].includes(item.state), '请等待下载或保存结束。', 409);
    const source = path.join(this.root, 'downloads', item.guid);
    try {
      const info = await lstat(source); check(info.isFile() && !info.isSymbolicLink(), '暂存文件异常，无法移至废纸篓。', 409);
      await mkdir(this.trashRoot, { recursive: true, mode: 0o700 }); const trash = await lstat(this.trashRoot); check(trash.isDirectory() && !trash.isSymbolicLink(), '废纸篓目录不可用。', 409);
      await rename(source, path.join(this.trashRoot, `lemon-download-${randomUUID()}-${item.name}`));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.downloads.delete(item.guid); await this.persistDownloads(); return { removed: item.guid };
  }
  async saveDownload(body) {
    const cwd = await directory(body.cwd), item = this.downloads.get(body.id); check(item?.cwd === cwd, '下载记录不存在。', 404); check(item.state === 'pending', '该下载尚未完成或已保存。', 409);
    item.state = 'saving';
    try {
      const target = await this.downloadDirectory(body.directory), name = downloadName(body.name), source = path.join(this.root, 'downloads', item.guid);
      const info = await lstat(source); check(info.isFile() && !info.isSymbolicLink(), '下载文件不可用。', 409);
      check(await realpath(path.dirname(source)) === path.join(await realpath(this.root), 'downloads'), '下载暂存目录异常。', 409);
      await copyFile(source, path.join(target, name), constants.COPYFILE_EXCL); item.savedPath = path.join(target, name); item.name = name; item.state = 'saved'; item.error = ''; await this.persistDownloads(); return { id: item.guid, state: item.state, savedPath: item.savedPath };
    } catch (error) { item.state = 'pending'; item.error = error.code === 'EEXIST' ? '目标已有同名文件，请更改文件名，原文件未覆盖。' : error.status ? error.message : '无法保存，请检查目录权限后重试。'; throw Object.assign(new Error(item.error), { status: error.status || 409 }); }
  }
  async close() { await this.cdp.close(); await this.downloadWrites.catch(() => {}); }
}
