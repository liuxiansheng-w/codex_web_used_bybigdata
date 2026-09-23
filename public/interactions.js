// Model keys never enter browser storage, URLs, drafts, or the chat composer.
export function createModelSwitch({ button, api, onSwitch, canSwitch = () => true }) {
  const doc = button.ownerDocument;
  const dialog = doc.createElement('dialog'); dialog.className = 'model-connection-dialog'; dialog.setAttribute('aria-labelledby', 'modelConnectionHeading');
  dialog.innerHTML = `<form><header><div><h2 id="modelConnectionHeading">模型切换</h2><p>新对话使用所选模型，原会话和任务会保留。</p></div><button type="button" class="icon-button" data-model-close aria-label="关闭模型切换">×</button></header>
    <div class="model-provider-choices"><button type="button" data-model-provider="codex"><strong>Codex</strong><small>使用本机登录</small><span aria-hidden="true">✓</span></button><button type="button" data-model-provider="cosmos"><strong>Cosmos</strong><small>使用自己的 Key</small><span aria-hidden="true">✓</span></button></div>
    <section class="cosmos-connection-fields" hidden><label for="cosmosKey">Cosmos Key</label><div class="model-key-saved" hidden><span>✓ 已保存 · 自动沿用</span><button type="button" class="secondary-button" data-model-replace>更换 Key</button></div><div data-model-key-editor><div class="model-key-field"><input id="cosmosKey" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="粘贴你的 Cosmos Key" maxlength="4096"><button type="button" class="secondary-button" data-model-reveal aria-label="显示输入的 Key" aria-pressed="false">显示</button></div><button type="button" class="text-button" data-model-cancel-replace hidden>取消更换</button></div><p class="model-key-hint">Key 仅保存在本机服务端，不写入聊天或浏览器存储。</p>
    <label class="model-protocol-field">应用类型<select name="protocol" aria-describedby="modelProtocolHint"><option value="chatflow">Cosmos Chatflow（对话流）</option><option value="workflow">Cosmos Workflow（工作流）</option><option value="responses">Responses 模型接口</option></select></label><p id="modelProtocolHint" class="model-protocol-hint"></p>
    <details><summary>高级设置</summary><div class="model-connection-advanced"><label>服务地址<input name="baseUrl" type="url" autocomplete="off" spellcheck="false" required></label><label data-model-id hidden>模型 ID<input name="model" autocomplete="off" spellcheck="false" placeholder="填写服务提供的模型 ID" maxlength="120"></label><div class="model-variable-fields"><label>输入变量<input name="inputKey" autocomplete="off" value="input" maxlength="100"></label><label data-model-output>输出变量<input name="outputKey" autocomplete="off" value="output" maxlength="100"></label></div><p data-model-chatflow-help hidden>输入变量与开始节点一致；没有自定义输入变量时留空。LLM 应读取该变量或 sys.query，「直接回复」引用 LLM 的 text。建议输入变量使用段落文本并调大长度上限。</p></div></details>
    <p class="model-compatibility-note">首次连接会验证工具调用和连续对话能力。仅发送测试内容，不读取项目或执行命令。</p></section>
    <p class="model-connection-status" role="status" aria-live="polite"></p><footer><button type="button" class="secondary-button" data-model-close>取消</button><button type="submit" class="primary-button" data-model-apply>使用 Codex</button></footer></form>`;
  doc.body.append(dialog);
  const form = dialog.querySelector('form'), key = dialog.querySelector('#cosmosKey'), status = dialog.querySelector('[role=status]');
  const apply = dialog.querySelector('[data-model-apply]'), fields = dialog.querySelector('.cosmos-connection-fields'), hint = dialog.querySelector('.model-key-hint');
  const get = name => form.elements.namedItem(name);
  let snapshot = null, choice = 'codex', pending = false, controller = null, sequence = 0, current = null, replacingKey = false;
  const address = value => {
    try { const url = new URL(value); url.pathname = url.pathname.replace(/\/(workflows\/run|chat-messages|responses)\/?$/, '').replace(/\/+$/, ''); return url.href.replace(/\/+$/, ''); }
    catch { return String(value).trim(); }
  };
  const changedAddress = () => snapshot?.cosmos?.hasKey && address(get('baseUrl').value.trim()) !== address(snapshot.cosmos.baseUrl);
  const focusAction = () => (dialog.querySelector('[data-model-key-editor]').hidden ? apply : key).focus();
  const reuseKey = () => snapshot?.cosmos?.hasKey && !key.value.trim() && ['protocol', 'baseUrl', 'model', 'inputKey', 'outputKey'].every(name => get(name).value.trim() === (snapshot.cosmos[name] || ''));
  function render() {
    const effective = current || snapshot?.active || 'codex';
    button.querySelector('strong').textContent = effective === 'cosmos' ? 'Cosmos · 自有模型' : 'Codex';
    button.setAttribute('aria-label', `模型切换，当前${effective === 'cosmos' ? ' Cosmos 自有模型' : ' Codex'}`);
    for (const option of dialog.querySelectorAll('[data-model-provider]')) {
      option.setAttribute('aria-pressed', String(option.dataset.modelProvider === choice)); option.disabled = pending;
    }
    fields.hidden = choice !== 'cosmos';
    const showKey = !snapshot?.cosmos?.hasKey || replacingKey || changedAddress() || !!key.value;
    dialog.querySelector('.model-key-saved').hidden = showKey;
    dialog.querySelector('[data-model-key-editor]').hidden = !showKey;
    dialog.querySelector('[data-model-replace]').disabled = pending;
    dialog.querySelector('[data-model-cancel-replace]').disabled = pending;
    dialog.querySelector('[data-model-cancel-replace]').hidden = !snapshot?.cosmos?.hasKey || changedAddress();
    hint.textContent = changedAddress() ? '服务地址已改变，请填写该地址对应的 Key。' : snapshot?.cosmos?.hasKey ? showKey ? '填写新 Key 后会重新验证；取消更换即可继续使用已保存的 Key。' : reuseKey() ? '无需重新输入，直接点击「使用 Cosmos」即可。' : '已保存的 Key 会自动沿用，点击「验证并切换」保存新设置。' : 'Key 仅保存在本机服务端，不写入聊天或浏览器存储。';
    const native = get('protocol').value === 'responses';
    const chatflow = get('protocol').value === 'chatflow';
    dialog.querySelector('[data-model-id]').hidden = !native;
    get('model').required = native && choice === 'cosmos';
    dialog.querySelector('.model-variable-fields').hidden = native;
    dialog.querySelector('.model-variable-fields').classList.toggle('is-chatflow', chatflow);
    dialog.querySelector('[data-model-output]').hidden = chatflow;
    dialog.querySelector('[data-model-chatflow-help]').hidden = !chatflow;
    dialog.querySelector('.model-protocol-hint').textContent = chatflow ? '应用标注 CHATFLOW、以「直接回复」结束时选择此项；自动读取回复，无需输出变量。' : native ? '适用于提供 Responses API 的模型服务，需要填写模型 ID。' : '应用标注 WORKFLOW、以「结束」输出变量时选择此项。';
    for (const input of fields.querySelectorAll('input, select, [data-model-reveal]')) input.disabled = pending || choice !== 'cosmos' || ((input === key || input.hasAttribute('data-model-reveal')) && !showKey) || (input === get('model') && !native) || (input === get('outputKey') && (native || chatflow)) || (input === get('inputKey') && native);
    apply.disabled = pending || !snapshot || !!snapshot.error;
    apply.textContent = pending ? '正在处理…' : choice === 'codex' ? '使用 Codex' : reuseKey() ? '使用 Cosmos' : '验证并切换';
    form.setAttribute('aria-busy', String(pending));
  }
  function populate(value) {
    snapshot = value;
    if (value.error) { status.textContent = value.error; render(); return; }
    choice = current || value.active;
    for (const name of ['protocol', 'baseUrl', 'model', 'inputKey', 'outputKey']) get(name).value = value.cosmos[name] || '';
    key.value = ''; key.type = 'password'; replacingKey = false;
    dialog.querySelector('[data-model-reveal]').textContent = '显示'; dialog.querySelector('[data-model-reveal]').setAttribute('aria-pressed', 'false');
    key.placeholder = value.cosmos.hasKey ? '已保存 Key；留空沿用，输入新 Key 可替换' : '粘贴你的 Cosmos Key';
    render();
  }
  async function open() {
    const ticket = ++sequence; delete status.dataset.error; status.textContent = '正在读取模型配置…'; dialog.showModal();
    try {
      const value = await api('/api/model-connections');
      if (ticket !== sequence || !dialog.open) return;
      populate(value); status.textContent = ''; if (choice === 'cosmos') focusAction();
    } catch (error) { if (ticket === sequence) { snapshot = null; status.textContent = error.message; render(); } }
  }
  function close() { sequence++; controller?.abort(); controller = null; pending = false; replacingKey = false; key.value = ''; key.type = 'password'; dialog.close(); render(); button.focus(); }
  button.addEventListener('click', () => { void open(); });
  for (const closeButton of dialog.querySelectorAll('[data-model-close]')) closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); } });
  for (const option of dialog.querySelectorAll('[data-model-provider]')) option.addEventListener('click', () => { choice = option.dataset.modelProvider; delete status.dataset.error; status.textContent = ''; render(); if (choice === 'cosmos') focusAction(); });
  dialog.querySelector('[data-model-replace]').addEventListener('click', () => { replacingKey = true; render(); key.focus(); });
  dialog.querySelector('[data-model-cancel-replace]').addEventListener('click', () => {
    replacingKey = false; key.value = ''; key.type = 'password';
    dialog.querySelector('[data-model-reveal]').textContent = '显示'; dialog.querySelector('[data-model-reveal]').setAttribute('aria-pressed', 'false'); dialog.querySelector('[data-model-reveal]').setAttribute('aria-label', '显示输入的 Key');
    delete status.dataset.error; status.textContent = ''; render(); dialog.querySelector('[data-model-replace]').focus();
  });
  get('protocol').addEventListener('change', render);
  fields.addEventListener('input', render);
  dialog.querySelector('[data-model-reveal]').addEventListener('click', event => {
    const reveal = key.type === 'password'; key.type = reveal ? 'text' : 'password'; event.currentTarget.textContent = reveal ? '隐藏' : '显示'; event.currentTarget.setAttribute('aria-pressed', String(reveal)); event.currentTarget.setAttribute('aria-label', reveal ? '隐藏输入的 Key' : '显示输入的 Key');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (pending || !snapshot) return;
    if (!canSwitch()) { status.textContent = '正在提交消息或文件，请完成后再切换。'; return; }
    const body = choice === 'codex' || reuseKey() ? { action: 'select', provider: choice, revision: snapshot.revision } : { action: 'configure', revision: snapshot.revision, key: key.value.trim(), ...Object.fromEntries(['protocol', 'baseUrl', 'model', 'inputKey', 'outputKey'].map(name => [name, get(name).value.trim()])) };
    if (choice === 'cosmos' && !body.key && (!snapshot.cosmos.hasKey || changedAddress())) { status.textContent = changedAddress() ? '服务地址已改变，请填写该地址对应的 Key。' : '请先输入 Cosmos Key。'; render(); key.focus(); return; }
    const ticket = ++sequence; pending = true; controller = new AbortController(); delete status.dataset.error; status.textContent = body.action === 'configure' ? '正在验证工具调用与续答能力，请稍候…' : '正在切换…'; render();
    try {
      const value = await api('/api/model-connections', body, { signal: controller.signal });
      if (ticket !== sequence) return;
      snapshot = value; key.value = ''; current = value.active; pending = false; controller = null;
      await onSwitch(value);
      if (ticket === sequence) { close(); }
    } catch (error) {
      if (ticket === sequence) { status.textContent = error.message; status.dataset.error = 'true'; }
    } finally { if (ticket === sequence) { pending = false; controller = null; render(); } }
  });
  return { setStatus(value) { snapshot = value; render(); }, setCurrent(provider) { current = provider; render(); }, get status() { return snapshot; } };
}

// Account limits are independent of a conversation's token/context usage.
export function quotaWindows(data) {
  const bucket = data?.rateLimitsByLimitId?.codex || data?.rateLimits;
  if (!bucket || (bucket.limitId && bucket.limitId !== 'codex')) return [];
  return ['primary', 'secondary'].flatMap((key, index) => {
    const value = bucket[key];
    if (typeof value?.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return [];
    const minutes = value.windowDurationMins;
    const label = minutes === 10080 ? '周' : minutes > 0 && minutes % 1440 === 0 ? `${minutes / 1440}天`
      : minutes > 0 && minutes % 60 === 0 ? `${minutes / 60}h` : minutes > 0 ? `${minutes}分钟` : index ? '次要' : '主要';
    return [{ label, remaining: Number(Math.max(0, Math.min(100, 100 - value.usedPercent)).toFixed(1)),
      resetsAt: typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt * 1000 : null }];
  });
}

export function createQuotaIndicator({ button, api, now = Date.now }) {
  const doc = button.ownerDocument, win = doc.defaultView;
  const label = button.querySelector('span');
  let enabled = false, context = '', revision = 0, pending = null, timer, controller;
  let windows = [], checkedAt = 0, attemptedAt = -Infinity, message = '正在连接账户';
  function render() {
    const stale = checkedAt && now() - checkedAt > 120000;
    const available = enabled && windows.length && !message && !stale;
    label.textContent = available ? `额度 ${windows.map(value => `${windows.length > 1 ? value.label + ' ' : ''}${value.remaining}%`).join(' · ')}` : pending ? '额度 …' : '额度 —';
    const remaining = available ? Math.min(...windows.map(value => value.remaining)) : null;
    button.dataset.level = remaining === null ? 'unknown' : remaining <= 10 ? 'low' : remaining <= 25 ? 'warning' : 'normal';
    const format = timestamp => new Date(timestamp).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const detail = available ? windows.map(value => `${value.label}额度剩余 ${value.remaining}%${value.resetsAt ? `；重置时间 ${format(value.resetsAt)}` : '；重置时间暂未提供'}`).join('\n')
      : message || (stale ? '额度已过期，等待更新' : '正在读取额度');
    button.title = `${detail}${available ? `\n更新于 ${format(checkedAt)}` : ''}${enabled ? '\n点击刷新额度' : ''}`;
    button.setAttribute('aria-label', button.title.replaceAll('\n', '，'));
    button.setAttribute('aria-busy', String(!!pending));
    button.disabled = !enabled;
  }
  function schedule() {
    win.clearTimeout(timer);
    if (enabled && !doc.hidden) timer = win.setTimeout(() => void refresh(), 60000);
  }
  async function refresh({ force = false } = {}) {
    render();
    if (!enabled || doc.hidden) return;
    if (pending) return pending;
    if (!force && now() - attemptedAt < 15000) { schedule(); return; }
    const ticket = revision;
    attemptedAt = now(); controller = new win.AbortController();
    const requestController = controller, signal = controller.signal;
    const timeout = win.setTimeout(() => requestController.abort(), 15000);
    pending = Promise.resolve().then(() => api('/api/usage', undefined, { signal })).then(data => {
      if (ticket !== revision) return;
      windows = quotaWindows(data); checkedAt = now();
      message = windows.length ? '' : '当前账户暂未提供额度信息';
    }).catch(() => {
      if (ticket !== revision) return;
      windows = []; message = '额度暂不可用，请稍后重试';
    }).finally(() => {
      win.clearTimeout(timeout);
      if (ticket !== revision) return;
      pending = null; controller = null; render(); schedule();
    });
    render(); return pending;
  }
  function setAvailability({ connected, loggedIn, type } = {}) {
    const supported = !type || ['chatgpt', 'chatgptAuthTokens'].includes(type);
    const next = !!connected && loggedIn === true && supported;
    const nextContext = `${!!connected}:${loggedIn}:${type || ''}`;
    if (context === nextContext) return;
    context = nextContext; revision++; controller?.abort(); controller = null;
    win.clearTimeout(timer); pending = null; windows = []; checkedAt = 0; attemptedAt = -Infinity; enabled = next;
    message = !connected ? '连接恢复后更新额度' : loggedIn !== true ? '登录后显示账户额度' : !supported ? '当前登录方式不提供订阅额度' : '';
    render(); if (enabled) void refresh();
  }
  const resume = () => { if (doc.hidden) win.clearTimeout(timer); else void refresh(); };
  const click = () => void refresh({ force: true });
  button.addEventListener('click', click);
  win.addEventListener('focus', resume); doc.addEventListener('visibilitychange', resume);
  render();
  return { setAvailability, refresh, destroy() {
    revision++; enabled = false; controller?.abort(); win.clearTimeout(timer);
    button.removeEventListener('click', click); win.removeEventListener('focus', resume); doc.removeEventListener('visibilitychange', resume);
  } };
}

// Resizing only changes layout; keep the tree, editor buffers and drafts intact.
export function createSidebarResize({ shell, sidebar, handle, storage }) {
  const win = sidebar.ownerDocument.defaultView, doc = sidebar.ownerDocument;
  const key = 'lemon:sidebarWidth';
  let preferred = null, gesture = null;
  try {
    const saved = Number(storage?.getItem(key));
    if (Number.isFinite(saved) && saved >= 220 && saved <= 640) preferred = saved;
  } catch { /* Resizing remains available when browser storage is disabled. */ }
  const bounds = () => ({ min: 220, max: Math.max(220, Math.min(640, win.innerWidth - 520)) });
  function render() {
    const { min, max } = bounds();
    const fallback = parseFloat(win.getComputedStyle(sidebar).getPropertyValue('--sidebar-default-width')) || 248;
    const width = Math.round(Math.max(min, Math.min(max, preferred ?? fallback)));
    sidebar.style.setProperty('--sidebar-width', `${width}px`);
    handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(width)); handle.setAttribute('aria-valuetext', `${width} 像素`);
    return width;
  }
  function persist() {
    try { if (preferred == null) storage?.removeItem(key); else storage?.setItem(key, String(preferred)); } catch { /* Keep the width for this page. */ }
  }
  function finish(cancel = false) {
    if (!gesture) return;
    const ended = gesture; gesture = null;
    if (cancel) preferred = ended.previous;
    shell.classList.remove('is-resizing-sidebar');
    if (handle.hasPointerCapture?.(ended.id)) handle.releasePointerCapture(ended.id);
    render(); if (!cancel) persist();
  }
  function reset() { finish(true); preferred = null; render(); persist(); }
  const enabled = () => win.innerWidth > 760 && !shell.classList.contains('sidebar-collapsed');
  handle.addEventListener('pointerdown', event => {
    if (!enabled() || event.button !== 0 || gesture) return;
    event.preventDefault();
    gesture = { id: event.pointerId, x: event.clientX, width: render(), previous: preferred };
    handle.setPointerCapture(event.pointerId); handle.focus({ preventScroll: true }); shell.classList.add('is-resizing-sidebar');
  });
  handle.addEventListener('pointermove', event => {
    if (gesture?.id !== event.pointerId) return;
    const { min, max } = bounds();
    preferred = Math.max(min, Math.min(max, gesture.width + event.clientX - gesture.x)); render();
  });
  handle.addEventListener('pointerup', event => { if (gesture?.id === event.pointerId) finish(); });
  handle.addEventListener('pointercancel', () => finish(true));
  handle.addEventListener('lostpointercapture', () => finish(true));
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', event => {
    if (!enabled()) return;
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!direction && !['Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault(); finish();
    if (event.key === 'Enter') return reset();
    const { min, max } = bounds();
    preferred = event.key === 'Home' ? min : event.key === 'End' ? max : Math.max(min, Math.min(max, render() + direction * (event.shiftKey ? 40 : 10)));
    render(); persist();
  });
  doc.addEventListener('keydown', event => { if (gesture && event.key === 'Escape') { event.preventDefault(); finish(true); } });
  win.addEventListener('blur', () => finish());
  win.addEventListener('resize', () => { finish(true); render(); });
  render();
}

// Theme changes only presentation; never rebuild the editor or conversation.
export function createThemeControl({ root, button, colorMeta, storage }) {
  let theme = 'dark';
  try { if (storage?.getItem('codex-desk:theme') === 'light') theme = 'light'; } catch {}
  function apply() {
    const light = theme === 'light';
    root.setAttribute('data-theme', theme);
    colorMeta?.setAttribute('content', light ? '#eeede8' : '#090c12');
    button.setAttribute('aria-pressed', String(light));
    button.title = light ? '当前为柔和浅色，点击切换深色' : '当前为深色，点击切换柔和浅色';
    button.setAttribute('aria-label', light ? '切换深色主题' : '切换浅色主题');
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${light ? '<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>' : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>'}</svg><span>${light ? '深色' : '浅色'}</span>`;
    for (const choice of root.ownerDocument.querySelectorAll('[data-color-mode]')) choice.setAttribute('aria-pressed', String(choice.dataset.colorMode === theme));
    root.dispatchEvent(new root.ownerDocument.defaultView.Event('lemon:appearance-change'));
  }
  button.addEventListener('click', () => {
    theme = theme === 'light' ? 'dark' : 'light'; apply();
    try { storage?.setItem('codex-desk:theme', theme); } catch {}
  });
  for (const choice of root.ownerDocument.querySelectorAll('[data-color-mode]')) choice.addEventListener('click', () => { if (choice.dataset.colorMode !== theme) button.click(); });
  apply();
  return { get theme() { return theme; } };
}

// A skin is independent of light/dark mode. Switching never remounts content.
export function createAppearanceControl({ root, select, storage }) {
  const doc = root.ownerDocument, trigger = doc.getElementById('appearanceToggle'), panel = doc.getElementById('appearancePanel');
  const options = [...select.options], valid = value => options.some(option => option.value === value);
  const cards = [...(panel?.querySelectorAll('[data-appearance-choice]') || [])];
  let appearance = 'neon';
  try { const saved = storage?.getItem('lemon:appearance'); if (valid(saved)) appearance = saved; } catch {}
  function apply() {
    root.setAttribute('data-appearance', appearance);
    root.setAttribute('data-skin', appearance === 'classic' ? 'classic' : 'modern');
    select.value = appearance;
    const name = options.find(option => option.value === appearance).textContent;
    select.title = `当前风格：${name}`;
    if (trigger) { trigger.title = `外观 · ${name}`; trigger.querySelector('span').textContent = name; }
    for (const card of cards) card.setAttribute('aria-pressed', String(card.dataset.appearanceChoice === appearance));
    const status = doc.getElementById('appearanceStatus'); if (status) status.textContent = `当前：${name} · 自动记住选择`;
    root.dispatchEvent(new doc.defaultView.Event('lemon:appearance-change'));
  }
  function choose(value) {
    appearance = valid(value) ? value : 'neon'; apply();
    try { storage?.setItem('lemon:appearance', appearance); } catch {}
  }
  select.addEventListener('change', () => choose(select.value));
  for (const card of cards) card.addEventListener('click', () => choose(card.dataset.appearanceChoice));
  if (trigger && panel) {
    function close(restoreFocus = false) {
      panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }
    trigger.addEventListener('click', () => {
      if (!panel.hidden) return close(true);
      panel.hidden = false; trigger.setAttribute('aria-expanded', 'true');
      cards.find(card => card.dataset.appearanceChoice === appearance)?.focus({ preventScroll: true });
    });
    doc.getElementById('appearanceClose')?.addEventListener('click', () => close(true));
    doc.addEventListener('pointerdown', event => { if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close(); });
    doc.addEventListener('focusin', event => { if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close(); });
    doc.addEventListener('keydown', event => {
      if (!panel.hidden && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    }, true);
  }
  apply();
  return { get appearance() { return appearance; } };
}

// Keep transient drafts in this page only unless the user opts into persistence.
export function createDraftStore({ storage, onError = () => {} } = {}) {
  const drafts = new Map();
  const key = (cwd, threadId) => JSON.stringify([cwd, threadId || null]);
  const persistedKey = 'codex-desk:promptDrafts';
  const enabled = () => storage?.getItem('codex-desk:persistDrafts') === 'true';
  try { if (enabled()) for (const [key, value] of JSON.parse(storage.getItem(persistedKey) || '[]')) drafts.set(key, value); } catch { onError('本机输入草稿读取失败。'); }
  const persist = () => { try { if (enabled()) { const data = JSON.stringify([...drafts].slice(-30).map(([key, value]) => [key, { text: value.text, model: value.model, context: {} }])); if (data.length > 1000000) throw new Error('草稿过大'); storage.setItem(persistedKey, data); } } catch { onError('浏览器草稿存储失败，请手动备份未发送内容。'); } };
  return {
    hasUnsent(exceptCwd, exceptThread) { return [...drafts.entries()].some(([id, value]) => (exceptCwd === undefined || id !== key(exceptCwd, exceptThread)) && (value.text?.trim() || value.context?.files?.length)); },
    get persisted() { return enabled(); },
    save(cwd, threadId, value) { drafts.set(key(cwd, threadId), structuredClone(value)); persist(); },
    read(cwd, threadId) { const value = drafts.get(key(cwd, threadId)); return value ? structuredClone(value) : null; },
    clear(cwd, threadId) { drafts.delete(key(cwd, threadId)); persist(); },
    clearSaved() { storage?.removeItem(persistedKey); },
  };
}

export function popupLayout(anchor, viewport, width, height) {
  const margin = 12, gap = 8;
  const popupWidth = Math.min(width, viewport.width - margin * 2);
  const above = Math.max(0, anchor.top - gap - margin);
  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin);
  const openAbove = above >= Math.min(height, 260) || above >= below;
  const maxHeight = Math.min(620, openAbove ? above : below);
  const actualHeight = Math.min(height, maxHeight);
  return {
    width: popupWidth,
    maxHeight,
    left: Math.max(margin, Math.min(anchor.left, viewport.width - popupWidth - margin)),
    top: Math.max(margin, openAbove ? anchor.top - gap - actualHeight : anchor.bottom + gap),
  };
}

export function positionPopover(anchor, popup, width = 380) {
  if (popup.hidden) return;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  popup.style.setProperty('--popup-width', `${Math.min(width, viewport.width - 24)}px`);
  popup.style.setProperty('--popup-height', '620px');
  const layout = popupLayout(anchor.getBoundingClientRect(), viewport, width, popup.getBoundingClientRect().height);
  for (const [key, value] of Object.entries({ left: layout.left, top: layout.top, width: layout.width, height: layout.maxHeight })) {
    popup.style.setProperty(`--popup-${key}`, `${value}px`);
  }
}

// Only describe observed state. A history summary without runtime data is not
// evidence that a task has finished or is idle in another client.
export function threadDisplayState(thread, live = true) {
  if (!thread) return { key: 'new', label: '未开始', rank: 0 };
  if (!live || thread.runtimeStale) return { key: 'unknown', label: '待核实', rank: thread.busy || thread.requests?.length ? 5 : 0 };
  if (thread.requests?.length) return { key: 'waiting', label: thread.requests.some(request => request.method === 'item/tool/requestUserInput') ? '待回复' : '待确认', rank: 5 };
  if (thread.busy) return { key: 'running', label: '运行中', rank: 4 };
  if (thread.error || thread.completion === 'failed') return { key: 'error', label: '需检查', rank: 3 };
  if (thread.queue?.length) return { key: 'queued', label: `${thread.queuePaused ? '队列暂停' : '排队'} · ${thread.queue.length}`, rank: 2 };
  if (thread.completion === 'completed') return { key: 'done', label: '已完成', rank: 0 };
  if (thread.completion === 'interrupted') return { key: 'idle', label: '已停止', rank: 0 };
  if (typeof thread.busy === 'boolean') return { key: 'idle', label: '空闲', rank: 0 };
  return { key: 'unknown', label: '未同步', rank: 0 };
}

const imageViewers = new WeakMap();
const attachmentBasename = value => String(value || '').replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || '文件';
const attachmentPath = file => file.path || (file.projectRoot && file.projectPath ? `${file.projectRoot.replace(/\/$/, '')}/${file.projectPath}` : '');
function insideMessageFence(text) {
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    if (!fence) fence = match[1];
    else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
  }
  return !!fence;
}

// Native history keeps non-image attachments as generated text. Convert only
// the exact trailing envelope for presentation; never mutate the model input,
// fetch a path on render, or interpret ordinary paths/code examples as files.
export function userMessagePresentation(item) {
  let text = String(item.text || '');
  const attachments = (item.attachments || []).map(file => ({ ...file })), recovered = [];
  const jsonString = '"(?:[^"\\\\\\r\\n]|\\\\.)*"';
  const envelope = new RegExp(`(^|\\r?\\n)用户附加的(文件夹|文件)：(${jsonString})\\r?\\n本机路径：(${jsonString})[ \\t]*(?:\\r?\\n[ \\t]*)*$`);
  for (let count = 0; count < 30; count++) {
    const match = text.match(envelope); if (!match || insideMessageFence(text.slice(0, match.index))) break;
    let name, path;
    try { name = JSON.parse(match[3]); path = JSON.parse(match[4]); } catch { break; }
    if (!name || name.length > 1024 || !path.startsWith('/') || path.startsWith('//') || path.length > 4096 || /[\x00-\x1f\x7f]/.test(name + path)) break;
    recovered.unshift({ kind: match[2] === '文件夹' ? 'folder' : 'file', name, path });
    text = text.slice(0, match.index);
  }
  for (const file of recovered) {
    const existing = attachments.find(other => other.kind === file.kind && attachmentPath(other) === file.path);
    if (existing) { existing.path = file.path; continue; }
    attachments.push(file);
  }
  return { text, attachments };
}

export function attachmentProjectEntry(file, cwd) {
  const root = String(cwd || '').replace(/\/$/, ''), target = attachmentPath(file);
  if (!root || !target.startsWith(root + '/')) return null;
  const relative = target.slice(root.length + 1);
  if (!relative || /[\\\x00-\x1f\x7f]/.test(relative) || relative.split('/').some(part => !part || part.startsWith('.'))) return null;
  return { cwd, path: relative, kind: file.kind };
}

export function createFileAttachment(attachment, { onOpen } = {}) {
  const name = attachmentBasename(attachment.name), path = attachmentPath(attachment), folder = attachment.kind === 'folder';
  const card = document.createElement('div'); card.className = 'attachment-file-card';
  const main = document.createElement(onOpen ? 'button' : 'div'); main.className = 'attachment-file-main'; main.title = name;
  if (onOpen) { main.type = 'button'; main.setAttribute('aria-label', `${folder ? '查看文件夹' : '打开文件'}：${name}`); main.addEventListener('click', onOpen); }
  const badge = document.createElement('b'); badge.className = 'attachment-file-type'; badge.setAttribute('aria-hidden', 'true');
  badge.textContent = folder ? '目录' : name.match(/\.([a-z0-9]{1,6})$/i)?.[1].toUpperCase() || '文件';
  const info = document.createElement('div'); info.className = 'attachment-file-info';
  const title = document.createElement('strong'); title.textContent = name;
  const description = document.createElement('small'); description.textContent = folder ? '文件夹附件' : onOpen ? '本机文件 · 点击打开' : '文件附件';
  info.append(title, description); main.append(badge, info); card.append(main);
  if (path) {
    const details = document.createElement('details'); details.className = 'attachment-file-location';
    const summary = document.createElement('summary'); summary.textContent = '查看路径';
    const location = document.createElement('code'); location.textContent = path;
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'text-button'; copy.textContent = '复制路径';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(path); copy.textContent = '已复制路径'; } catch { copy.textContent = '请选中上方路径复制'; } });
    details.append(summary, location, copy); card.append(details);
  }
  return card;
}

const localImageUrl = value => typeof value === 'string' && /^\/api\/attachments\/images\/[0-9a-f-]{36}$/.test(value);

function imageViewer(doc) {
  if (imageViewers.has(doc)) return imageViewers.get(doc);
  const dialog = doc.createElement('dialog'); dialog.className = 'image-preview-dialog';
  dialog.setAttribute('aria-label', '图片预览');
  const panel = doc.createElement('div'); panel.className = 'image-preview-panel';
  const header = doc.createElement('header'); header.className = 'image-preview-heading';
  const name = doc.createElement('strong');
  const zoom = doc.createElement('button'); zoom.type = 'button'; zoom.className = 'text-button'; zoom.textContent = '原尺寸';
  const download = doc.createElement('a'); download.className = 'text-button'; download.textContent = '下载图片';
  const close = doc.createElement('button'); close.type = 'button'; close.className = 'icon-button'; close.textContent = '×'; close.setAttribute('aria-label', '关闭图片预览');
  const viewport = doc.createElement('div'); viewport.className = 'image-preview-viewport'; viewport.tabIndex = 0; viewport.setAttribute('aria-label', '图片，可滚动查看原图');
  const img = doc.createElement('img'); img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
  const error = doc.createElement('p'); error.className = 'image-preview-error'; error.hidden = true;
  let returnFocus = null;
  const fit = () => { viewport.classList.remove('original-size'); zoom.textContent = '原尺寸'; zoom.setAttribute('aria-pressed', 'false'); };
  zoom.addEventListener('click', () => {
    const original = viewport.classList.toggle('original-size');
    zoom.textContent = original ? '适应窗口' : '原尺寸'; zoom.setAttribute('aria-pressed', String(original));
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { img.removeAttribute('src'); download.removeAttribute('href'); if (returnFocus?.isConnected) returnFocus.focus(); });
  img.addEventListener('error', () => { img.hidden = true; error.hidden = false; error.textContent = '图片源文件已失效或无法读取。'; zoom.disabled = true; download.hidden = true; });
  header.append(name, zoom, download, close); viewport.append(img, error); panel.append(header, viewport); dialog.append(panel); doc.body.append(dialog);
  const viewer = { open(attachment, opener) {
    if (!localImageUrl(attachment.previewUrl)) return;
    returnFocus = opener; fit(); name.textContent = attachment.name || '图片';
    img.alt = attachment.name || '图片'; img.hidden = false; error.hidden = true; zoom.disabled = false;
    download.hidden = false; download.href = attachment.previewUrl; download.download = attachment.name || 'image';
    img.src = attachment.previewUrl;
    if (!dialog.open) dialog.showModal();
  } };
  imageViewers.set(doc, viewer); return viewer;
}

export function createImageAttachment(attachment, { compact = false } = {}) {
  const doc = document, figure = doc.createElement('figure');
  figure.className = `attachment-image${compact ? ' attachment-image-compact' : ''}`;
  const caption = doc.createElement('figcaption'); caption.textContent = attachment.name || '图片'; caption.hidden = compact;
  const error = doc.createElement('small'); error.className = 'attachment-image-error'; error.hidden = true;
  if (!localImageUrl(attachment.previewUrl)) {
    error.hidden = false; error.textContent = '图片暂不可预览'; figure.append(caption, error); return figure;
  }
  const button = doc.createElement('button'); button.type = 'button'; button.className = 'attachment-image-button'; button.setAttribute('aria-label', `查看图片：${attachment.name || '图片'}`); button.title = '点击查看大图';
  const img = doc.createElement('img'); img.src = attachment.previewUrl; img.alt = attachment.name || '图片';
  img.loading = 'lazy'; img.decoding = 'async'; img.referrerPolicy = 'no-referrer';
  img.addEventListener('error', () => {
    img.hidden = true; button.hidden = true; error.hidden = false; error.textContent = '图片已失效或无法读取';
    caption.hidden = false;
  });
  button.append(img); button.addEventListener('click', () => imageViewer(doc).open(attachment, button));
  figure.append(button, caption, error); return figure;
}

// Module overrides only affect presentation. Untouched modules follow the global
// mode; explicit choices survive skin changes, docking and browser reloads.
export function createModuleThemeControls({ root, storage, bottomPanel }) {
  const doc = root.ownerDocument, $ = id => doc.getElementById(id);
  const names = { editor: '编辑器', chat: '对话', terminal: '终端', results: '查询结果', tools: '工具面板' };
  let saved = {};
  try { const value = JSON.parse(storage?.getItem('lemon:moduleThemes') || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) saved = value; } catch {}
  const choices = Object.fromEntries(Object.keys(names).filter(key => ['light', 'dark'].includes(saved[key])).map(key => [key, saved[key]]));
  const surfaces = new Map(), controls = [];
  const mode = key => choices[key] || (root.dataset.theme === 'light' ? 'light' : 'dark');
  function follow(key, ...nodes) { surfaces.set(key, nodes.filter(Boolean)); }
  follow('editor', $('fileEditor'), $('sqlParamsDialog'), $('sqlHistoryDialog'), $('editorTabMenu'), $('fileConflictDialog'), $('unsavedDialog'));
  follow('chat', $('mainPanel'));
  follow('terminal', $('bottomTerminal'));
  follow('results', $('sqlResults'), $('bottomResultsHost'), $('sqlResultHandle'), $('sqlColumnMenu'), $('sqlReviewDialog'), $('sqlRenameForm')?.closest('dialog'));
  follow('tools', $('workbenchDialog'), $('restoreFileDialog'), $('gitSubmitDialog'));
  function paint(node, key) {
    node.dataset.moduleTheme = key; node.dataset.theme = mode(key);
    node.dataset.skin = root.dataset.skin || 'classic'; node.dataset.appearance = root.dataset.appearance || 'classic';
  }
  function render() {
    for (const [key, nodes] of surfaces) for (const node of nodes) paint(node, key);
    if (bottomPanel && $('bottomPanel')) paint($('bottomPanel'), bottomPanel.activeTab);
    for (const { button, key } of controls) {
      const id = typeof key === 'function' ? key() : key, light = mode(id) === 'light';
      button.dataset.moduleThemeToggle = id;
      button.setAttribute('aria-label', `${names[id]}：切换为${light ? '深色' : '浅色'}背景`);
      button.setAttribute('aria-pressed', String(light));
      button.title = `${names[id]} · 当前${light ? '浅色' : '深色'}，点击独立切换`;
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${light ? '<path d="M20.5 14A8.5 8.5 0 0 1 10 3.5 8.5 8.5 0 1 0 20.5 14Z"/>' : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>'}</svg>`;
    }
  }
  function add(key, host, before) {
    if (!host) return;
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'icon-button module-theme-toggle';
    host.insertBefore(button, before || null); controls.push({ button, key });
    button.addEventListener('click', () => {
      const id = typeof key === 'function' ? key() : key;
      choices[id] = mode(id) === 'light' ? 'dark' : 'light';
      try { storage?.setItem('lemon:moduleThemes', JSON.stringify(choices)); } catch {}
      render();
    });
  }
  add('editor', doc.querySelector('.editor-window-actions'), $('editorLayoutToggle'));
  add('chat', doc.querySelector('.conversation-heading'));
  add('tools', doc.querySelector('.workbench-head'), $('closeWorkbench'));
  add('tools', doc.querySelector('#gitSubmitDialog .dialog-heading'));
  // The shared header controls the selected bottom tab. A second button travels
  // with the results header and is visible only while that window floats.
  if (bottomPanel) add(() => bottomPanel.activeTab, doc.querySelector('.bottom-panel-header'), $('bottomPanelExpand'));
  add('results', $('sqlResultHandle'), $('sqlWindowReset'));
  const unsubscribe = bottomPanel?.subscribe(render);
  root.addEventListener('lemon:appearance-change', render); render();
  return { mode, dispose() { unsubscribe?.(); root.removeEventListener('lemon:appearance-change', render); for (const { button } of controls) button.remove(); } };
}

// Use the stream's own baseline, not a thread fetched concurrently over HTTP.
export function applyThreadPatch(previous, patch) {
  if (!previous || previous.id !== patch.thread.id || (previous.revision ?? null) !== patch.baseRevision) throw new Error('实时会话版本已变化，正在重新同步。');
  const items = new Map(previous.items.map(item => [item.id, item]));
  for (const item of patch.items) items.set(item.id, item);
  return { ...patch.thread, items: patch.order.map(id => {
    if (!items.has(id)) throw new Error('实时消息缺失，正在重新同步。');
    return items.get(id);
  }) };
}
