import { positionPopover, createImageAttachment } from './interactions.js';
const $ = id => document.getElementById(id);
const effortNames = { none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高', ultra: 'Ultra' };
const goalNames = { active: '进行中', paused: '已暂停', blocked: '遇到阻碍', complete: '已完成', budgetLimited: '预算已用完', usageLimited: '用量受限' };
const promptLimit = 100_000, pasteThreshold = 5_000, pasteByteLimit = 10 * 1024 * 1024;

export function createComposerTools({ api, notice, getContext, onChange, onDraftChange = () => {} }) {
  let models = [], files = [], chosen = new Map(), plan = false, draftGoal = null;
  let catalog = null, catalogCwd = '', loadingCatalog = null, uploading = false, running = false, submitting = false;
  let activeTab = 'plugins';
  let pasteSequence = 0, draftVersion = 0, previewedPaste = null;
  const pasteRequests = new Map();
  const hasPendingPaste = () => files.some(file => file.pasteState === 'uploading');
  const hasFailedPaste = () => files.some(file => file.pasteState === 'error');
  const pastedFiles = () => files.filter(file => typeof file.pastedText === 'string');
  const changedPaste = () => { renderChips(); onDraftChange(); };
  const inputChanged = () => { const prompt = $('prompt'); prompt.dispatchEvent(new prompt.ownerDocument.defaultView.Event('input', { bubbles: true })); };

  function syncTextState() {
    const length = $('prompt').value.length, oversized = length > promptLimit;
    $('promptLength').hidden = !length;
    $('promptLength').textContent = length >= 90_000 ? `${length.toLocaleString()} / 100,000` : `${length.toLocaleString()} 字符`;
    $('promptLength').dataset.over = String(oversized);
    $('prompt').setAttribute('aria-invalid', String(oversized));
    $('promptTextWarning').hidden = length < pasteThreshold;
    $('promptTextWarningMessage').textContent = oversized ? '已保留全部文字，超过输入上限；请转为附件后发送。' : '长文本可转为附件，输入框留给任务说明。';
    $('convertPromptText').disabled = uploading || submitting || hasPendingPaste();
  }

  function removePaste(file) {
    if (submitting) return;
    pasteRequests.get(file)?.abort();
    files = files.filter(item => item !== file);
    if (previewedPaste === file) $('pastedTextDialog').close();
    changedPaste();
  }

  function showPaste(file) {
    previewedPaste = file;
    $('pastedTextTitle').textContent = file.name;
    $('pastedTextDetails').textContent = `${file.pastedText.length.toLocaleString()} 字符 · ${Math.ceil(file.size / 1024).toLocaleString()} KB${file.pastedText.length > 50_000 ? ' · 仅预览前 50,000 字符，下载保留全文' : ' · 完整预览'}。文本附件仅保留在本页，刷新前可下载备份。`;
    $('pastedTextPreview').value = file.pastedText.slice(0, 50_000);
    const canRestore = $('prompt').value.length + file.pastedText.length + ($('prompt').value ? 2 : 0) <= promptLimit;
    $('restorePastedText').disabled = !canRestore || submitting || file.pasteState === 'uploading';
    $('restorePastedText').title = canRestore ? '追加到现有输入内容，并移除此附件' : '还原后会超过输入上限，请下载全文';
    const theme = $('composer').closest('[data-module-theme]');
    $('pastedTextDialog').dataset.theme = theme?.dataset.theme || document.documentElement.dataset.theme || 'dark';
    $('pastedTextDialog').dataset.moduleTheme = 'conversation';
    if (!$('pastedTextDialog').open) $('pastedTextDialog').showModal();
  }

  function pastedChip(file) {
    const node = document.createElement('span'); node.className = 'context-chip pasted-text-chip';
    const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'pasted-text-open';
    const title = document.createElement('strong'); title.textContent = `${file.name} · ${file.pastedText.length.toLocaleString()} 字符`;
    const state = document.createElement('small'); state.textContent = file.pasteState === 'uploading' ? '正在添加… · 原文已保留' : file.pasteState === 'error' ? file.pasteError : '已附加完整文本 · 点击预览';
    preview.append(title, state); preview.title = state.textContent; preview.onclick = () => showPaste(file); node.append(preview);
    if (file.pasteState === 'error' && file.size <= pasteByteLimit) {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.className = 'pasted-text-retry'; retry.disabled = submitting;
      retry.onclick = () => void uploadPaste(file); node.append(retry);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.disabled = submitting;
    remove.setAttribute('aria-label', `移除 ${file.name}`); remove.onclick = () => removePaste(file); node.append(remove);
    return node;
  }

  async function uploadPaste(file) {
    if (submitting || !files.includes(file) || pasteRequests.has(file)) return;
    if (file.size > pasteByteLimit) { file.pasteState = 'error'; file.pasteError = '超过 10 MB，原文已保留，请下载后拆分或引用本机文件'; changedPaste(); return; }
    const controller = new AbortController(), version = draftVersion, context = getContext();
    const cwd = context.cwd, threadId = context.thread?.id;
    const current = () => version === draftVersion && files.includes(file) && getContext().cwd === cwd && getContext().thread?.id === threadId && !controller.signal.aborted;
    pasteRequests.set(file, controller); file.pasteState = 'uploading'; file.pasteError = ''; changedPaste();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const blob = new File([file.pastedText], file.name, { type: 'text/plain;charset=utf-8' });
      const base64 = await fileBase64(blob);
      if (!current()) return;
      const result = await api('/api/attachments/upload', { name: file.name, base64 }, { signal: controller.signal });
      if (!current()) return;
      if (typeof result.id !== 'string' || !result.id) throw new Error('服务未返回附件编号，请重试');
      Object.assign(file, result, { pasteState: 'ready' });
    } catch (error) {
      if (version !== draftVersion || !files.includes(file)) return;
      file.pasteState = 'error'; file.pasteError = `添加失败，原文已保留：${controller.signal.aborted ? '上传超时，请重试' : error.message}`;
    } finally {
      clearTimeout(timer); pasteRequests.delete(file);
      if (version === draftVersion && files.includes(file)) {
        if (file.pasteState === 'uploading') { file.pasteState = 'error'; file.pasteError = '会话已变化，原文已保留，请重试'; }
        if (previewedPaste === file) showPaste(file);
        changedPaste();
      }
    }
  }

  function addPastedText(text, { replaceInput = false } = {}) {
    if (!text || submitting) return false;
    if (files.length >= 30) { notice('每条消息最多添加 30 个附件；已保留输入文字，请先移除附件。'); return false; }
    const file = { name: `粘贴文本-${++pasteSequence}.txt`, kind: 'file', size: new Blob([text]).size, pastedText: text, pasteState: 'uploading' };
    files.push(file);
    if (replaceInput) { $('prompt').value = ''; inputChanged(); }
    void uploadPaste(file);
    return true;
  }

  function resetPastes() {
    draftVersion++;
    for (const request of pasteRequests.values()) request.abort();
    previewedPaste = null; $('pastedTextDialog').close();
  }

  $('prompt').addEventListener('input', syncTextState);
  $('convertPromptText').addEventListener('click', () => { if (addPastedText($('prompt').value, { replaceInput: true })) $('prompt').focus(); });
  $('pastedTextDialog').addEventListener('close', () => { previewedPaste = null; $('pastedTextPreview').value = ''; });
  $('downloadPastedText').addEventListener('click', () => {
    if (!previewedPaste) return;
    const url = URL.createObjectURL(new Blob([previewedPaste.pastedText], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = previewedPaste.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('restorePastedText').addEventListener('click', () => {
    const file = previewedPaste, prompt = $('prompt');
    if (!file || submitting || file.pasteState === 'uploading' || !files.includes(file)) return;
    const text = `${prompt.value}${prompt.value ? '\n\n' : ''}${file.pastedText}`;
    if (text.length > promptLimit) return;
    prompt.value = text; removePaste(file); inputChanged(); prompt.focus();
  });
  const positionMenu = () => positionPopover($('addButton'), $('addMenu'));

  function closeMenu(focus = false) {
    $('addMenu').hidden = true; $('addButton').setAttribute('aria-expanded', 'false');
    if (focus) $('addButton').focus();
  }

  function chip(label, remove, file) {
    if (typeof file?.pastedText === 'string') return pastedChip(file);
    const node = document.createElement('span'); node.className = 'context-chip'; node.title = label;
    if (file?.kind === 'image' && file.previewUrl) { node.classList.add('context-image'); node.append(createImageAttachment(file, { compact: true })); }
    const text = document.createElement('span'); text.textContent = label;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '×'; button.setAttribute('aria-label', `移除 ${label}`);
    button.addEventListener('click', remove); node.append(text, button); return node;
  }

  function renderChips() {
    $('contextChips').replaceChildren();
    for (const file of files) $('contextChips').append(chip(`${file.kind === 'folder' ? '目录引用' : file.sourceVersion === 'snapshot' ? '未保存快照' : file.projectPath ? '磁盘版本' : file.kind === 'image' ? '图片' : '文件副本'} · ${file.name}`, () => { files = files.filter(f => f.id !== file.id); renderChips(); }, file));
    for (const item of chosen.values()) $('contextChips').append(chip(item.title, () => { chosen.delete(item.key); renderChips(); renderCatalog(); }));
    if (plan) $('contextChips').append(chip('计划模式', () => { if (!running) { plan = false; renderChips(); } }));
    $('togglePlan').setAttribute('aria-pressed', String(plan)); $('planCheck').hidden = !plan;
    $('planMenuText').textContent = plan ? '已开启 · 仅分析与规划' : '开启计划模式';
    onChange();
  }

  function renderEffort(value = $('effort').value) {
    const selected = models.find(m => m.id === $('model').value) || models.find(m => m.isDefault);
    $('effort').replaceChildren(new Option('默认强度', ''));
    for (const option of selected?.efforts || []) $('effort').add(new Option(effortNames[option.reasoningEffort] || option.reasoningEffort, option.reasoningEffort));
    if ([...$('effort').options].some(o => o.value === value)) $('effort').value = value;
  }

  function renderCatalog() {
    const query = $('capabilitySearch').value.toLowerCase();
    const priority = ['github', 'documents', 'pdf', 'spreadsheets', 'presentations'];
    const plugins = [...(catalog?.plugins || [])].sort((a, b) => {
      const ai = priority.indexOf(a.name), bi = priority.indexOf(b.name);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    for (const [target, entries] of [['pluginMenu', plugins], ['skillMenu', catalog?.skills || []]]) {
      $(target).replaceChildren();
      const filtered = entries.filter(p => `${p.title} ${p.name} ${p.description}`.toLowerCase().includes(query));
      for (const item of filtered) {
        const button = document.createElement('button'); button.type = 'button'; button.className = `menu-row plugin-row${chosen.has(item.key) ? ' chosen' : ''}`;
        button.setAttribute('aria-pressed', String(chosen.has(item.key)));
        const icon = document.createElement('span'); icon.className = 'plugin-monogram'; icon.dataset.kind = item.name; icon.textContent = item.title.slice(0, 1).toUpperCase();
        const text = document.createElement('span'); const title = document.createElement('strong'); title.textContent = item.title;
        const description = document.createElement('small'); description.textContent = item.description;
        text.append(title, description); button.append(icon, text);
        const check = document.createElement('span'); check.className = 'selection-check'; check.textContent = '✓'; check.hidden = !chosen.has(item.key); button.append(check);
        button.addEventListener('click', () => {
          chosen.has(item.key) ? chosen.delete(item.key) : chosen.set(item.key, item);
          renderChips();
          button.classList.toggle('chosen', chosen.has(item.key));
          button.setAttribute('aria-pressed', String(chosen.has(item.key)));
          const check = button.querySelector('.selection-check');
          if (check) check.hidden = !chosen.has(item.key);
        });
        $(target).append(button);
      }
      if (!filtered.length) { const p = document.createElement('p'); p.className = 'menu-empty'; p.textContent = catalog ? '没有可用的匹配项' : '正在读取本机功能…'; $(target).append(p); }
    }
    // Search both categories; the normal view stays on the user's chosen tab.
    $('pluginsPanel').hidden = !query && activeTab !== 'plugins';
    $('skillsPanel').hidden = !query && activeTab !== 'skills';
    positionMenu();
  }

  async function loadCatalog(refresh = false) {
    const cwd = getContext().cwd;
    if (!refresh && catalogCwd === cwd && catalog) return;
    if (catalogCwd !== cwd) { catalog = null; renderCatalog(); }
    if (loadingCatalog) return loadingCatalog;
    $('refreshCapabilities').disabled = true;
    loadingCatalog = (async () => {
      try {
        const result = await api(`/api/capabilities?cwd=${encodeURIComponent(cwd)}${refresh ? '&refresh=1' : ''}`);
        if (getContext().cwd !== cwd) return;
        catalog = result; catalogCwd = cwd;
        $('capabilityError').textContent = result.warnings?.join('\n') || '';
        $('capabilityError').hidden = !result.warnings?.length;
        $('togglePlan').disabled = running || !result.planSupported;
        renderCatalog();
      } catch (error) { $('capabilityError').textContent = error.message; $('capabilityError').hidden = false; }
      finally { loadingCatalog = null; $('refreshCapabilities').disabled = false; }
    })();
    return loadingCatalog;
  }

  $('addButton').addEventListener('click', () => {
    const open = $('addMenu').hidden;
    $('addMenu').hidden = !open; $('addButton').setAttribute('aria-expanded', String(open));
    if (open) {
      $('permissionMenu').hidden = true; $('permissionButton').setAttribute('aria-expanded', 'false');
      renderCatalog(); loadCatalog(); $('attachFiles').focus();
    }
  });
  document.addEventListener('click', event => { if (!event.target.closest('.add-control')) closeMenu(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('addMenu').hidden) { event.preventDefault(); closeMenu(true); } });
  for (const node of document.querySelectorAll('[data-close]')) node.addEventListener('click', () => $(node.dataset.close).close());
  $('capabilitySearch').addEventListener('input', renderCatalog);
  $('capabilitySearch').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
  $('closeTools').addEventListener('click', () => { closeMenu(); $('prompt').focus(); });
  for (const tab of ['plugins', 'skills']) {
    const selectTab = () => {
      activeTab = tab; $('capabilitySearch').value = '';
      for (const name of ['plugins', 'skills']) { $(`${name}Tab`).setAttribute('aria-selected', String(name === tab)); $(`${name}Tab`).tabIndex = name === tab ? 0 : -1; }
      renderCatalog();
    };
    $(`${tab}Tab`).addEventListener('click', selectTab);
    $(`${tab}Tab`).addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'plugins' : event.key === 'End' ? 'skills' : tab === 'plugins' ? 'skills' : 'plugins';
      $(`${next}Tab`).click(); $(`${next}Tab`).focus();
    });
  }
  $('refreshCapabilities').addEventListener('click', () => loadCatalog(true));
  $('togglePlan').addEventListener('click', () => { if (running) return; plan = !plan; renderChips(); closeMenu(); });
  $('model').addEventListener('change', () => renderEffort());
  $('recordSkill').addEventListener('click', () => { closeMenu(); $('recordingDialog').showModal(); });

  $('attachFiles').addEventListener('click', () => { closeMenu(); $('uploadError').hidden = true; $('attachmentDialog').showModal(); });
  $('chooseFiles').addEventListener('click', () => $('filePicker').click());
  $('chooseFolder').addEventListener('click', () => $('folderPicker').click());
  const fileBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('读取文件失败。'));
    reader.readAsDataURL(file);
  });
  async function uploadFiles(batch) {
    if (!batch.length || uploading || hasPendingPaste() || submitting) return;
    uploading = true; onChange();
    $('chooseFiles').disabled = true; $('chooseFolder').disabled = true; $('uploadError').hidden = true;
    try {
      if (files.length + batch.length > 30) throw new Error('每条消息最多添加 30 个文件；较大的文件夹请使用本机路径引用。');
      if (batch.some(file => file.size > 10 * 1024 * 1024)) throw new Error('单个文件不能超过 10 MB；较大的文件请使用本机路径引用。');
      let index = 0;
      for (const file of batch) {
        $('uploadStatus').textContent = `正在添加 ${++index}/${batch.length}：${file.name}`;
        const result = await api('/api/attachments/upload', { name: file.webkitRelativePath || file.name, base64: await fileBase64(file) });
        files.push(result); renderChips();
      }
      $('uploadStatus').textContent = `已添加 ${batch.length} 个附件。`;
      $('attachmentDialog').close(); $('prompt').focus();
    } catch (error) { $('uploadError').textContent = error.message; $('uploadError').hidden = false; }
    finally { uploading = false; $('chooseFiles').disabled = false; $('chooseFolder').disabled = false; onChange(); }
  }
  for (const id of ['filePicker', 'folderPicker']) $(id).addEventListener('change', () => { const batch = [...$(id).files]; $(id).value = ''; uploadFiles(batch); });
  $('referenceForm').addEventListener('submit', async event => {
    event.preventDefault(); if (uploading) return;
    uploading = true; onChange(); event.submitter.disabled = true; $('uploadError').hidden = true;
    try {
      if (files.length >= 30) throw new Error('每条消息最多添加 30 个文件或文件夹。');
      files.push(await api('/api/attachments/reference', { path: $('referencePath').value.trim() }));
      renderChips(); $('referencePath').value = ''; $('attachmentDialog').close(); $('prompt').focus();
    } catch (error) { $('uploadError').textContent = error.message; $('uploadError').hidden = false; }
    finally { uploading = false; onChange(); event.submitter.disabled = false; }
  });
  $('prompt').addEventListener('paste', event => {
    if (event.defaultPrevented || submitting || $('prompt').readOnly) return;
    const images = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
    if (images.length) { event.preventDefault(); $('attachmentDialog').showModal(); uploadFiles(images); return; }
    const text = event.clipboardData?.getData('text/plain') || '';
    const prompt = $('prompt'), length = prompt.value.length - (prompt.selectionEnd - prompt.selectionStart) + text.length;
    if (text.length < pasteThreshold && length <= promptLimit) return;
    event.preventDefault();
    if (!addPastedText(text)) { prompt.setRangeText(text, prompt.selectionStart, prompt.selectionEnd, 'end'); inputChanged(); }
  });
  const hasProjectReference = (cwd, relative) => files.some(file => (file.projectCwd || file.projectRoot) === cwd && file.projectPath === relative);
  async function addProjectReference({ cwd, path, snapshot }) {
    if (uploading || hasPendingPaste() || submitting) throw new Error('正在提交或添加文件，请稍后再试。');
    if (hasProjectReference(cwd, path)) return false;
    if (files.length >= 30) throw new Error('每条消息最多添加 30 个文件或文件夹。');
    const context = getContext(), threadId = context.thread?.id;
    if (context.cwd !== cwd) throw new Error('项目已切换，请刷新文件树后重试。');
    uploading = true; onChange();
    try {
      let file;
      if (typeof snapshot === 'string') {
        const text = `文件：${cwd}/${path}\n版本：用户明确选择的未保存编辑快照。磁盘文件可能不同，请依据此快照分析，不要假定原文件已保存。\n\n${snapshot}`;
        const bytes = new TextEncoder().encode(text); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        file = await api('/api/attachments/upload', { name: `${path.split('/').at(-1)}.draft.txt`, base64: btoa(binary) });
        file = { ...file, name: path.split('/').at(-1), projectPath: path, sourceVersion: 'snapshot' };
      } else file = await api('/api/project/attach', { cwd, path });
      if (getContext().cwd !== cwd || getContext().thread?.id !== threadId) throw new Error('会话已切换，请在当前会话重新添加文件。');
      if (files.some(existing => existing.id === file.id || (existing.projectRoot === file.projectRoot && existing.projectPath === file.projectPath))) return false;
      files.push({ ...file, projectCwd: cwd }); renderChips(); return true;
    } finally { uploading = false; onChange(); }
  }
  let dragDepth = 0;
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  const resetDrag = () => { dragDepth = 0; $('composer').classList.toggle('is-dragover', false); };
  $('composer').addEventListener('dragenter', event => { if (hasFiles(event)) { event.preventDefault(); dragDepth++; $('composer').classList.toggle('is-dragover', !submitting); } });
  $('composer').addEventListener('dragover', event => { if (hasFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = submitting ? 'none' : 'copy'; } });
  $('composer').addEventListener('dragleave', () => { if (--dragDepth <= 0) resetDrag(); });
  $('composer').addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault(); resetDrag();
    if (submitting) return;
    if ([...(event.dataTransfer.items || [])].some(item => item.webkitGetAsEntry?.()?.isDirectory)) {
      notice('拖入文件夹请使用「＋ → 文件与目录」中的上传文件夹或本机路径引用。'); return;
    }
    $('attachmentDialog').showModal(); uploadFiles([...event.dataTransfer.files]);
  });
  document.addEventListener('dragend', resetDrag);

  function currentGoal() { return draftGoal || getContext().thread?.goal; }
  function renderGoal() {
    const goal = currentGoal(); $('goalBanner').hidden = !goal;
    if (!goal) return;
    $('goalSummary').textContent = goal.objective;
    $('goalStatus').textContent = draftGoal ? '发送后生效' : `${goalNames[goal.status] || goal.status}${goal.tokensUsed != null ? ` · ${goal.tokensUsed.toLocaleString()} tokens${goal.tokenBudget ? ` / ${goal.tokenBudget.toLocaleString()}` : ''}` : ''}`;
    $('pauseGoal').hidden = !!draftGoal || !['active', 'paused'].includes(goal.status);
    $('pauseGoal').textContent = goal.status === 'paused' ? '恢复' : '暂停';
  }
  function openGoal() {
    closeMenu(); const goal = currentGoal();
    $('goalObjective').value = goal?.objective || '';
    $('goalBudget').value = goal?.tokenBudget || '';
    $('goalError').hidden = true;
    $('goalHint').textContent = getContext().thread ? '保存后更新当前对话的目标。' : '新对话的目标将在发送第一条消息时生效。';
    $('clearGoal').hidden = !goal;
    $('goalDialog').showModal();
  }
  $('addGoal').addEventListener('click', openGoal); $('editGoal').addEventListener('click', openGoal);
  $('goalForm').addEventListener('submit', async event => {
    event.preventDefault(); event.submitter.disabled = true;
    try {
      const goal = { objective: $('goalObjective').value.trim(), tokenBudget: $('goalBudget').value ? Number($('goalBudget').value) : null };
      const thread = getContext().thread;
      if (thread) { thread.goal = (await api('/api/goal', { threadId: thread.id, ...goal, status: 'active' })).goal; draftGoal = null; }
      else draftGoal = goal;
      renderGoal(); $('goalDialog').close();
    } catch (error) { $('goalError').textContent = error.message; $('goalError').hidden = false; }
    finally { event.submitter.disabled = false; }
  });
  $('clearGoal').addEventListener('click', async () => {
    $('clearGoal').disabled = true;
    try {
      const thread = getContext().thread;
      if (thread?.goal) { await api('/api/goal', { threadId: thread.id, clear: true }); thread.goal = null; }
      draftGoal = null; renderGoal(); $('goalDialog').close();
    } catch (error) { $('goalError').textContent = error.message; $('goalError').hidden = false; }
    finally { $('clearGoal').disabled = false; }
  });
  $('pauseGoal').addEventListener('click', async () => {
    const thread = getContext().thread; if (!thread?.goal) return;
    $('pauseGoal').disabled = true;
    try { thread.goal = (await api('/api/goal', { threadId: thread.id, status: thread.goal.status === 'paused' ? 'active' : 'paused' })).goal; renderGoal(); }
    catch (error) { notice(error.message); }
    finally { $('pauseGoal').disabled = false; }
  });

  const canvas = $('drawingCanvas'), ctx = canvas.getContext('2d');
  let drawing = false, undo = [], hasDrawing = false;
  function clearCanvas() { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); hasDrawing = false; }
  function saveDrawing() { undo.push({ image: ctx.getImageData(0, 0, canvas.width, canvas.height), hasDrawing }); if (undo.length > 15) undo.shift(); }
  function point(event) { const box = canvas.getBoundingClientRect(); return [(event.clientX - box.left) * canvas.width / box.width, (event.clientY - box.top) * canvas.height / box.height]; }
  clearCanvas();
  $('drawButton').addEventListener('click', () => { closeMenu(); $('drawingError').hidden = true; $('drawingDialog').showModal(); });
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    event.preventDefault(); saveDrawing(); drawing = true; hasDrawing = true; canvas.setPointerCapture(event.pointerId);
    ctx.strokeStyle = $('penColor').value; ctx.lineWidth = Number($('penSize').value); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const [x, y] = point(event); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + .1, y + .1); ctx.stroke();
  });
  canvas.addEventListener('pointermove', event => { if (!drawing) return; ctx.lineTo(...point(event)); ctx.stroke(); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(type, () => { drawing = false; });
  $('undoDrawing').addEventListener('click', () => { const prev = undo.pop(); if (prev) { ctx.putImageData(prev.image, 0, 0); hasDrawing = prev.hasDrawing; } });
  $('clearDrawing').addEventListener('click', () => { saveDrawing(); clearCanvas(); });
  $('attachDrawing').addEventListener('click', async () => {
    if (uploading) return;
    uploading = true; onChange();
    $('attachDrawing').disabled = true; $('drawingError').hidden = true;
    try {
      if (!hasDrawing) throw new Error('请先在画布上绘制内容。');
      if (files.length >= 30) throw new Error('每条消息最多添加 30 个附件。');
      files.push(await api('/api/attachments/upload', { name: `草图-${Date.now()}.png`, base64: canvas.toDataURL('image/png').split(',')[1] }));
      renderChips(); clearCanvas(); undo = []; $('drawingDialog').close(); $('prompt').focus();
    } catch (error) { $('drawingError').textContent = error.message; $('drawingError').hidden = false; }
    finally { uploading = false; onChange(); $('attachDrawing').disabled = false; }
  });

  return {
    get uploading() { return uploading || hasPendingPaste(); },
    get hasPastedText() { return pastedFiles().length > 0; },
    get canSend() { return $('prompt').value.length <= promptLimit && !hasFailedPaste() && !hasPendingPaste() && (!!$('prompt').value.trim() || pastedFiles().some(file => file.pasteState === 'ready')); },
    messageText() { return $('prompt').value.trim() || (pastedFiles().some(file => file.pasteState === 'ready') ? '请读取附加的完整长文本，按其中的要求处理；内容较长时请分段读取。' : ''); },
    addProjectReference,
    hasProjectReference,
    payload() { return { effort: $('effort').value, plan, attachments: files.filter(f => f.id && (!f.pasteState || f.pasteState === 'ready')).map(f => f.id), capabilities: [...chosen.keys()], ...(draftGoal ? { goal: draftGoal } : {}) }; },
    sent(payload) { files = files.filter(f => !payload.attachments.includes(f.id)); for (const key of payload.capabilities) chosen.delete(key); draftGoal = null; renderChips(); renderGoal(); },
    setModels(value) { models = value; renderEffort(); },
    snapshot() { return structuredClone({ files, chosen: [...chosen], plan, draftGoal, effort: $('effort').value }); },
    restoreDraft(draft) { resetPastes(); files = structuredClone(draft.files || []); for (const file of pastedFiles()) if (file.pasteState === 'uploading') { file.pasteState = 'error'; file.pasteError = '添加尚未完成，原文已保留，请重试'; } chosen = new Map(draft.chosen || []); plan = !!draft.plan; draftGoal = draft.draftGoal || null; renderEffort(draft.effort || ''); renderChips(); renderCatalog(); renderGoal(); },
    restore(thread) { resetPastes(); files = []; chosen.clear(); plan = !!thread.plan; draftGoal = null; renderEffort(thread.effort || ''); renderChips(); renderGoal(); closeMenu(); },
    reset() { resetPastes(); files = []; chosen.clear(); plan = false; draftGoal = null; renderChips(); renderGoal(); closeMenu(); },
    renderGoal,
    setBusy(busy, sending) { running = busy; submitting = sending; $('effort').disabled = busy || sending; $('togglePlan').disabled = busy || sending || catalog?.planSupported === false; $('addButton').disabled = sending; if (sending) closeMenu(); syncTextState(); },
  };
}
