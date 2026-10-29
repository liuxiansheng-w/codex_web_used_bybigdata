const pinIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 3 6 6-3 1-4 4v4l-2 2-3-5-5-3 2-2h4l4-4Z M9 15l-6 6"/></svg>';
const folderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v12H3Z"/></svg>';

export function createThreadOrganization({ api, getContext, onChange, notify, notice, legacyPins = () => new Set() }) {
  const $ = id => document.getElementById(id), snapshots = new Map(), threadIndex = new Map(), folderIndex = new Map(), pending = new Set(), collapsed = new Map();
  let editing = null, actionThread = null, batch = null, listed = [];
  const supported = () => !!getContext().available;
  const current = (cwd = getContext().cwd) => snapshots.get(cwd);
  const ready = cwd => supported() && !!current(cwd);
  const metadata = thread => threadIndex.get(thread.cwd || getContext().cwd)?.get(thread.id);
  const isPinned = thread => metadata(thread)?.pinned ?? legacyPins().has(thread.id);
  const folderFor = thread => folderIndex.get(thread.cwd || getContext().cwd)?.get(metadata(thread)?.folderId);
  const batchSupported = () => supported() && getContext().batch === true && !!$('threadBatchToggle');

  function accept(value) {
    if (!value || typeof value.cwd !== 'string' || !Number.isSafeInteger(value.revision) || !Array.isArray(value.folders) || !Array.isArray(value.threads)) return;
    if ((current(value.cwd)?.revision ?? -1) <= value.revision) {
      snapshots.set(value.cwd, value);
      threadIndex.set(value.cwd, new Map(value.threads.map(item => [item.id, item])));
      folderIndex.set(value.cwd, new Map(value.folders.map(item => [item.id, item])));
    }
    sync();
  }

  function sync() {
    const { cwd } = getContext();
    syncBatch();
    $('newThreadFolder').hidden = !supported();
    $('newThreadFolder').disabled = !ready(cwd) || pending.has(cwd);
    $('threadFolderMove').hidden = !supported();
    if (editing && editing.cwd !== cwd) closeEditor();
    for (const control of $('threadFolderForm').querySelectorAll('input, button')) control.disabled = pending.has(editing?.cwd);
    if (actionThread) {
      const project = actionThread.cwd || cwd, blocked = supported() && (!ready(project) || pending.has(project));
      const pin = document.querySelector('[data-thread-action=pin]');
      pin.textContent = (isPinned(actionThread) ? '取消置顶' : '置顶会话') + (supported() ? '' : '（本浏览器）');
      pin.disabled = blocked;
      $('threadFolderSelect').disabled = blocked;
      document.querySelector('[data-thread-action=move]').disabled = blocked;
    }
  }

  async function mutate(cwd, fields) {
    if (!ready(cwd)) throw new Error('会话分组尚未读取，请刷新会话列表后重试。');
    if (pending.has(cwd)) throw new Error('正在保存会话分组，请稍候。');
    pending.add(cwd); sync(); onChange();
    try {
      const value = await api('/api/thread-organization', { cwd, revision: current(cwd).revision, ...fields });
      accept(value); return value;
    } catch (error) {
      if (error.status === 409) {
        try { accept(await api(`/api/thread-organization?cwd=${encodeURIComponent(cwd)}`)); } catch { /* Preserve the last confirmed state. */ }
      }
      throw error;
    } finally { pending.delete(cwd); sync(); if (getContext().cwd === cwd) onChange(); }
  }

  function syncBatch() {
    if (!$('threadBatchToggle')) return;
    const { cwd, scope } = getContext(), available = batchSupported();
    if (batch && (!available || batch.cwd !== cwd || batch.scope !== scope)) batch = null;
    $('threadBatchToggle').hidden = !available;
    $('threadBatchToggle').disabled = !ready(cwd) || pending.has(cwd);
    $('threadBatchToggle').setAttribute('aria-expanded', String(!!batch));
    $('threadBatchToggle').textContent = batch ? '结束选择' : '批量移动';
    $('threadBatchPanel').hidden = !batch;
    $('threadList').classList.toggle('is-selecting', !!batch);
    if (!batch) return;
    const busy = pending.has(cwd), folders = current(cwd)?.folders || [];
    const selectedFolder = batch.destination ?? '__choose__', signature = JSON.stringify([folders, selectedFolder]);
    if (signature !== batch.optionsSignature) {
      const select = $('threadBatchFolder'), placeholder = new Option('选择目标文件夹', '__choose__'); placeholder.disabled = true;
      select.replaceChildren(placeholder, new Option('未分组', ''));
      for (const folder of folders) select.add(new Option(folder.name, folder.id));
      if (selectedFolder !== '__choose__' && selectedFolder && !folders.some(folder => folder.id === selectedFolder)) { const missing = new Option('原目标文件夹已移除，请重新选择', selectedFolder); missing.disabled = true; select.add(missing); }
      select.value = selectedFolder; batch.optionsSignature = signature;
    }
    const validFolder = batch.destination !== undefined && (!batch.destination || folders.some(folder => folder.id === batch.destination));
    $('threadBatchCount').textContent = `已选 ${batch.selected.size} 个`;
    $('threadBatchAll').disabled = busy || !listed.length || listed.every(thread => batch.selected.has(thread.id));
    $('threadBatchClear').disabled = busy || !batch.selected.size;
    $('threadBatchCancel').disabled = busy;
    $('threadBatchFolder').disabled = busy;
    $('threadBatchMove').disabled = busy || !batch.selected.size || !validFolder;
    $('threadBatchMove').textContent = busy ? '正在保存…' : '移动所选会话';
  }
  function finishBatch() {
    if (batch && pending.has(batch.cwd)) return;
    batch = null; syncBatch(); onChange(); $('threadBatchToggle')?.focus();
  }
  function activateSelection(thread) {
    if (!batch || batch.cwd !== (thread.cwd || getContext().cwd)) return false;
    if (pending.has(batch.cwd)) return true;
    if (batch.selected.has(thread.id)) batch.selected.delete(thread.id);
    else if (batch.selected.size < 100) batch.selected.add(thread.id);
    else { $('threadBatchError').textContent = '每次最多移动 100 个会话，请分批处理。'; return true; }
    $('threadBatchError').textContent = ''; onChange(); return true;
  }
  function selectionControl(thread) {
    if (!batch) return null;
    const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'thread-select';
    input.checked = batch.selected.has(thread.id); input.setAttribute('aria-label', `选择会话 ${thread.title}`);
    input.disabled = pending.has(batch.cwd) || !input.checked && batch.selected.size >= 100;
    input.addEventListener('change', () => activateSelection(thread));
    return input;
  }
  $('threadBatchToggle')?.addEventListener('click', () => {
    if (!batchSupported() || !ready() || pending.has(getContext().cwd)) return;
    if (batch) { finishBatch(); return; }
    const { cwd, scope } = getContext(); batch = { cwd, scope, selected: new Set(), destination: undefined };
    $('threadBatchError').textContent = ''; onChange();
    $('threadList').querySelector('.thread-select:not(:disabled)')?.focus();
  });
  $('threadBatchCancel')?.addEventListener('click', finishBatch);
  $('threadBatchClear')?.addEventListener('click', () => { if (batch && !pending.has(batch.cwd)) { batch.selected.clear(); $('threadBatchError').textContent = ''; onChange(); } });
  $('threadBatchAll')?.addEventListener('click', () => {
    if (!batch || pending.has(batch.cwd)) return;
    if (listed.length > 100) { $('threadBatchError').textContent = `当前已加载 ${listed.length} 个会话，每次最多 100 个，请分批勾选。`; return; }
    batch.selected = new Set(listed.map(thread => thread.id)); $('threadBatchError').textContent = ''; onChange();
  });
  $('threadBatchFolder')?.addEventListener('change', () => { if (batch) { batch.destination = $('threadBatchFolder').value; $('threadBatchError').textContent = ''; syncBatch(); } });
  $('threadBatchMove')?.addEventListener('click', async () => {
    syncBatch();
    const target = batch;
    if (!target || pending.has(target.cwd) || !target.selected.size || target.destination === undefined || $('threadBatchMove').disabled) return;
    const ids = [...target.selected], folderId = target.destination || null;
    $('threadBatchError').textContent = '';
    try {
      await mutate(target.cwd, { action: 'move-many', threadIds: ids, folderId });
      if (batch === target) { finishBatch(); notify(`已移动 ${ids.length} 个会话`); }
    } catch (error) { if (batch === target) $('threadBatchError').textContent = error.message; }
  });

  function closeEditor() { editing = null; $('threadFolderForm').hidden = true; $('threadFolderError').textContent = ''; }
  function editFolder(folder = null) {
    const { cwd } = getContext();
    if (!ready(cwd) || pending.has(cwd)) return;
    editing = { cwd, folderId: folder?.id || null };
    $('threadFolderForm').hidden = false;
    $('threadFolderLabel').textContent = folder ? '文件夹名称' : '新建会话文件夹';
    $('threadFolderName').value = folder?.name || '';
    $('threadFolderRemove').hidden = !folder;
    $('threadFolderSave').textContent = folder ? '保存' : '创建';
    $('threadFolderError').textContent = '';
    $('threadFolderName').focus(); $('threadFolderName').select();
  }
  $('newThreadFolder').addEventListener('click', () => editFolder());
  $('threadFolderCancel').addEventListener('click', () => { closeEditor(); $('newThreadFolder').focus(); });
  $('threadFolderForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); closeEditor(); $('newThreadFolder').focus(); }
  });
  $('threadFolderForm').addEventListener('submit', async event => {
    event.preventDefault();
    const target = editing;
    if (!target || pending.has(target.cwd)) return;
    $('threadFolderError').textContent = '';
    try {
      await mutate(target.cwd, { action: target.folderId ? 'rename-folder' : 'create-folder', folderId: target.folderId, name: $('threadFolderName').value });
      if (editing === target) { closeEditor(); $('newThreadFolder').focus(); notify(target.folderId ? '文件夹已重命名' : '会话文件夹已创建'); }
    } catch (error) { if (editing === target) $('threadFolderError').textContent = error.message; }
  });
  $('threadFolderRemove').addEventListener('click', async () => {
    const target = editing;
    if (!target?.folderId || pending.has(target.cwd) || !confirm('移除此文件夹？其中的会话会回到“未分组”，聊天记录和置顶状态都会保留。')) return;
    try {
      await mutate(target.cwd, { action: 'remove-folder', folderId: target.folderId });
      if (editing === target) { closeEditor(); $('newThreadFolder').focus(); notify('已移除文件夹，会话已回到未分组'); }
    } catch (error) { if (editing === target) $('threadFolderError').textContent = error.message; }
  });

  function prepareActions(thread) {
    actionThread = thread;
    const select = $('threadFolderSelect'), value = current(thread.cwd || getContext().cwd);
    select.replaceChildren(new Option('未分组', ''));
    for (const folder of value?.folders || []) select.add(new Option(folder.name, folder.id));
    select.value = metadata(thread)?.folderId || '';
    sync();
  }
  $('threadActionsDialog').addEventListener('close', () => { actionThread = null; });
  async function act(action, thread) {
    const cwd = thread.cwd || getContext().cwd;
    await mutate(cwd, action === 'pin' ? { action, threadId: thread.id, pinned: !isPinned(thread) } : { action: 'move', threadId: thread.id, folderId: $('threadFolderSelect').value || null });
    if (getContext().cwd === cwd) notify(action === 'pin' ? (isPinned(thread) ? '会话已置顶' : '已取消置顶') : '会话已移动');
  }

  function pinButton(thread) {
    if (!supported()) return null;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'thread-pin'; button.innerHTML = pinIcon;
    const pinned = isPinned(thread), label = `${pinned ? '取消置顶' : '置顶会话'} ${thread.title}`;
    button.setAttribute('aria-pressed', String(pinned)); button.setAttribute('aria-label', label); button.title = label;
    button.disabled = !ready(thread.cwd) || pending.has(thread.cwd || getContext().cwd);
    button.addEventListener('click', () => { void act('pin', thread).catch(error => { if (getContext().cwd === thread.cwd) notice(error.message); }); });
    return button;
  }

  function render(list, row, { query = '' } = {}) {
    sync();
    if (!ready()) return false;
    listed = list;
    if (batch) { const ids = new Set(list.map(thread => thread.id)); for (const id of batch.selected) if (!ids.has(id)) batch.selected.delete(id); syncBatch(); }
    const { cwd } = getContext(), value = current(), target = $('threadList');
    if (!collapsed.has(cwd)) collapsed.set(cwd, new Set());
    const folded = collapsed.get(cwd), pins = list.filter(isPinned);
    const groups = [
      ...(pins.length ? [{ id: 'pinned', name: '置顶', items: pins, count: pins.length, icon: pinIcon }] : []),
      ...value.folders.map(folder => {
        const members = list.filter(thread => metadata(thread)?.folderId === folder.id);
        return { ...folder, folder, items: members.filter(thread => !isPinned(thread)), count: members.length, pinned: members.filter(isPinned).length, icon: folderIcon };
      }),
      { id: 'ungrouped', name: '未分组', items: list.filter(thread => !isPinned(thread) && !folderFor(thread)), icon: folderIcon },
    ];
    for (const group of groups) {
      if (query && !group.items.length) continue;
      if (!query && group.id === 'ungrouped' && !group.items.length && list.length && !value.folders.length) continue;
      const section = document.createElement('section'); section.className = 'thread-group'; section.dataset.group = group.id;
      const header = document.createElement('div'); header.className = 'thread-group-heading';
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'thread-group-toggle'; toggle.dataset.groupToggle = group.id;
      toggle.innerHTML = '<span class="thread-group-chevron" aria-hidden="true">›</span>' + group.icon;
      const name = document.createElement('span'); name.className = 'thread-group-name'; name.textContent = group.name;
      const count = document.createElement('small'); count.textContent = String(group.count ?? group.items.length); count.title = '当前已加载的会话数';
      toggle.append(name, count); toggle.setAttribute('aria-expanded', String(!!query || !folded.has(group.id))); header.append(toggle);
      const body = document.createElement('div'); body.className = 'thread-group-items'; body.id = `thread-group-${group.id}`;
      toggle.setAttribute('aria-controls', body.id); body.hidden = !query && folded.has(group.id);
      toggle.addEventListener('click', () => {
        body.hidden = !body.hidden;
        body.hidden ? folded.add(group.id) : folded.delete(group.id);
        toggle.setAttribute('aria-expanded', String(!body.hidden));
      });
      if (group.folder) {
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'thread-folder-edit'; edit.textContent = '⋯'; edit.dataset.folderEdit = group.id;
        edit.title = edit.ariaLabel = `管理文件夹 ${group.name}`; edit.disabled = pending.has(cwd); edit.addEventListener('click', () => editFolder(group.folder)); header.append(edit);
      }
      for (const thread of group.items) body.append(row(thread));
      if (!group.items.length) {
        const hint = document.createElement('p'); hint.className = 'thread-group-empty';
        hint.textContent = group.pinned ? `${group.pinned} 个会话已显示在置顶区` : group.folder ? '暂无会话，可从会话 ⋯ 菜单移入' : '暂无未分组会话'; body.append(hint);
      }
      section.append(header, body); target.append(section);
    }
    if (query && !list.length) { const empty = document.createElement('p'); empty.className = 'list-empty'; empty.textContent = '没有匹配的对话'; target.append(empty); }
    return true;
  }

  async function migrate(threads) {
    const { cwd } = getContext();
    if (!ready(cwd) || pending.has(cwd)) return;
    const known = new Set(current(cwd).threads.map(item => item.id));
    const ids = threads.filter(thread => thread.cwd === cwd && legacyPins().has(thread.id) && !known.has(thread.id)).map(thread => thread.id).slice(0, 100);
    if (ids.length) {
      try { await mutate(cwd, { action: 'import-pins', threadIds: ids }); }
      catch (error) { if (getContext().cwd === cwd) notice(`旧置顶仍保留在本浏览器，迁移暂未完成：${error.message}`); }
    }
  }

  sync();
  return { accept, sync, supported, ready, isPinned, folderFor, prepareActions, act, pinButton, render, migrate, activateSelection, selectionControl };
}
