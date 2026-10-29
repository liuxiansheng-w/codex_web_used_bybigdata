import { positionPopover } from './interactions.js';

const $ = id => document.getElementById(id);
const folderIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h6l2 2h10v12H3Z"/></svg>';
const basename = path => path.split('/').filter(Boolean).at(-1) || '/';
const parent = path => path.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
const normalize = path => path === '/' ? path : path.replace(/\/+$/, '');

// Only paths are persisted here. File buffers and conversation drafts have their own stores.
export function createProjectList({ api, onSelect, onGit = () => {}, getContext, getTabs = () => [], notice, storage = localStorage, remote = null }) {
  let projects = [], busy = false, collapsed = false, sequence = 0, location = '', nextOffset = null, loading = false, choosing = false;
  const selectedFolders = new Set();
  let remoteQueue = Promise.resolve(), remoteReady = !remote, remoteRevision = 0;
  const actions = document.createElement('div'); actions.id = 'projectActionsPopup'; actions.className = 'project-row-menu'; actions.hidden = true; actions.setAttribute('role', 'menu');
  const git = document.createElement('button'); git.type = 'button'; git.textContent = 'Git 提交与推送'; git.setAttribute('role', 'menuitem'); actions.append(git); document.body.append(actions);
  const pull = document.createElement('button'); pull.type = 'button'; pull.textContent = '拉取远程更新…'; pull.setAttribute('role', 'menuitem'); actions.append(pull);
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制项目路径'; copy.setAttribute('role', 'menuitem'); actions.append(copy);
  let actionProject = null, actionTrigger = null;
  function closeActions(restoreFocus = false) {
    const trigger = actionTrigger; actions.hidden = true; actionProject = actionTrigger = null;
    trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }
  function openActions(cwd, trigger) {
    if (busy) return;
    if (actionTrigger === trigger) { closeActions(true); return; }
    closeActions(); actionProject = cwd; actionTrigger = trigger;
    actions.setAttribute('aria-label', `${basename(cwd)} 项目操作`); actions.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    positionPopover(trigger, actions, 210); git.focus();
  }
  git.addEventListener('click', async () => {
    const cwd = actionProject; closeActions(true);
    if (!cwd || busy) return;
    try { await onGit(cwd); } catch (error) { notice(error.message); }
  });
  pull.addEventListener('click', async () => {
    const cwd = actionProject; closeActions(true);
    if (!cwd || busy) return;
    try { await onGit(cwd, 'pull'); } catch (error) { notice(error.message); }
  });
  copy.addEventListener('click', async () => {
    const cwd = actionProject, expected = getContext().cwd; closeActions(true);
    if (!cwd) return;
    try { await window.navigator.clipboard.writeText(cwd); if (getContext().cwd === expected) notice('已复制项目绝对路径。'); }
    catch { if (getContext().cwd === expected) notice(`剪贴板不可用，请手动复制项目路径：${cwd}`); }
  });
  actions.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeActions(true); }
    else if (event.key === 'Tab') closeActions(true);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const controls = [git, pull, copy], index = controls.indexOf(document.activeElement);
      controls[event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length].focus();
    }
  });
  document.addEventListener('click', event => { if (!actions.contains(event.target) && !actionTrigger?.contains(event.target)) closeActions(); });
  $('projectList').addEventListener('scroll', () => closeActions());
  window.addEventListener('resize', () => closeActions());
  try { const saved = JSON.parse(storage.getItem('codex-desk:projects') || '[]'); if (Array.isArray(saved)) projects = [...new Set(saved.filter(path => typeof path === 'string' && path.startsWith('/')).map(normalize))]; } catch {}
  const persist = () => { try { storage.setItem('codex-desk:projects', JSON.stringify(projects)); } catch { notice('浏览器无法保存项目列表，本页仍可使用。'); } };
  function syncRemote() {
    if (!remote) return;
    const value = [...projects];
    remoteQueue = remoteQueue.then(() => remote.save(value)).catch(() => {
      if (remoteReady) notice('项目已保存在本机，但暂未同步到服务端；稍后会自动重试。');
    });
  }
  async function loadRemote() {
    if (!remote) return;
    const revision = remoteRevision;
    try {
      const result = await remote.load();
      if (!Array.isArray(result?.projects)) return;
      const serverProjects = [...new Set(result.projects.filter(path => typeof path === 'string' && path.startsWith('/')).map(normalize))];
      const merged = [...new Set([...serverProjects, ...projects])];
      if (revision !== remoteRevision && merged.length === projects.length && merged.every((cwd, index) => cwd === projects[index])) return;
      projects = merged;
      persist(); render();
      if (JSON.stringify(serverProjects) !== JSON.stringify(projects)) syncRemote();
    } catch {}
    finally { remoteReady = true; }
  }
  function remember(cwd) {
    if (!cwd?.startsWith('/')) return;
    cwd = normalize(cwd);
    if (!projects.includes(cwd)) { projects.push(cwd); persist(); remoteRevision++; syncRemote(); }
    render();
  }
  function forget(cwd) {
    if (cwd === getContext().cwd) throw new Error('请先切换到其他项目，再从列表移除此项目。');
    projects = projects.filter(path => path !== cwd); persist(); remoteRevision++; syncRemote(); render();
  }
  function render() {
    closeActions();
    $('projectList').replaceChildren();
    for (const cwd of projects) {
      const current = cwd === getContext().cwd, row = document.createElement('div'); row.className = 'project-row';
      const select = document.createElement('button'); select.type = 'button'; select.className = 'project-select'; select.innerHTML = folderIcon;
      select.title = cwd; select.dataset.cwd = cwd; select.disabled = busy; select.setAttribute('aria-current', String(current));
      const title = document.createElement('span'), name = document.createElement('strong'), hint = document.createElement('small');
      const unsaved = getTabs().filter(tab => tab.cwd === cwd && tab.dirty).length;
      name.textContent = basename(cwd); hint.textContent = unsaved ? `${current ? '当前项目 · ' : ''}${unsaved} 个文件未保存` : current ? '当前项目' : parent(cwd); title.append(name, hint); select.append(title);
      select.addEventListener('click', async () => { try { await onSelect(cwd); } catch (error) { notice(error.message); } });
      const more = document.createElement('button'); more.type = 'button'; more.className = 'icon-button project-more'; more.textContent = '⋯'; more.disabled = busy;
      more.dataset.cwd = cwd; more.title = `${basename(cwd)}：项目操作`; more.setAttribute('aria-label', `${basename(cwd)} 更多操作`); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-controls', actions.id); more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', () => openActions(cwd, more));
      more.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); openActions(cwd, more); } });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'project-remove'; remove.textContent = '×';
      remove.title = current ? '切换到其他项目后可从列表移除' : '从列表移除，不删除文件或草稿'; remove.setAttribute('aria-label', `从列表移除项目 ${basename(cwd)}`); remove.disabled = current || busy;
      remove.addEventListener('click', () => { try { forget(cwd); } catch (error) { notice(error.message); } });
      row.append(select, more, remove); $('projectList').append(row);
    }
    $('addProjectButton').disabled = busy; $('projectList').hidden = collapsed;
  }
  function pickerState() {
    $('projectPicker').setAttribute('aria-busy', String(loading || choosing));
    const currentLocation = normalize($('projectLocation').value.trim()) === location;
    const hasSelection = selectedFolders.size > 0;
    $('chooseProject').disabled = loading || choosing || (!hasSelection && (!location || !currentLocation));
    $('chooseProject').textContent = hasSelection ? `添加并打开 ${selectedFolders.size} 个项目` : '添加并打开项目';
    $('projectUp').disabled = choosing || !location || location === '/';
    $('projectBrowse').disabled = choosing; $('projectLocation').readOnly = choosing;
    $('closeProjectPicker').disabled = choosing; $('cancelProjectPicker').disabled = choosing;
    $('projectMore').hidden = nextOffset == null; $('projectMore').disabled = loading || choosing;
  }
  async function browse(path, append = false) {
    if (choosing) return;
    if (!append) selectedFolders.clear();
    const generation = ++sequence; loading = true; $('projectPickerError').textContent = ''; pickerState();
    try {
      if (!path.startsWith('/')) throw new Error('请输入本机文件夹的绝对路径，例如 /Users/你的名字/Desktop。');
      const result = await api(`/api/project/files?cwd=${encodeURIComponent(path)}${append ? `&offset=${nextOffset}` : ''}`);
      if (generation !== sequence || !$('projectPicker').open) return;
      location = result.cwd; nextOffset = result.nextOffset; $('projectLocation').value = location;
      if (!append) $('projectFolders').replaceChildren();
      for (const entry of result.entries.filter(item => item.kind === 'folder')) {
        const relative = entry.path || entry.name;
        const absolute = `${result.cwd === '/' ? '' : result.cwd}/${relative}`;
        const row = document.createElement('div'); row.className = 'project-folder'; row.dataset.cwd = absolute;
        const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'project-folder-check'; check.checked = selectedFolders.has(absolute); check.setAttribute('aria-label', `选择项目 ${entry.name}`);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'project-folder-open'; button.innerHTML = folderIcon;
        const label = document.createElement('span'); label.textContent = entry.name; button.append(label); button.title = `进入文件夹 ${entry.name}`;
        check.addEventListener('click', event => event.stopPropagation());
        check.addEventListener('change', () => { if (check.checked) selectedFolders.add(absolute); else selectedFolders.delete(absolute); pickerState(); renderChosen(); });
        button.addEventListener('click', () => browse(absolute));
        row.addEventListener('click', event => { if (event.target.closest('input,button')) return; browse(absolute); });
        row.append(check, button); $('projectFolders').append(row);
      }
      renderChosen();
      $('projectPickerHint').textContent = result.limited ? '目录条目过多，列表已截断；可直接输入目标文件夹的绝对路径。' : '单击文件夹进入；勾选多个文件夹后可一次加入项目列表。隐藏项、依赖及排除目录不显示。';
      $('projectFoldersEmpty').hidden = $('projectFolders').children.length > 0;
    } catch (error) { if (generation === sequence) { location = ''; nextOffset = null; $('projectChosenPath').textContent = '尚未选择有效文件夹'; $('projectFolders').replaceChildren(); $('projectPickerError').textContent = error.message; } }
    finally { if (generation === sequence) { loading = false; pickerState(); } }
  }
  function renderChosen() {
    const paths = [...selectedFolders];
    $('projectChosenLabel').textContent = paths.length ? `已选 ${paths.length} 个项目` : '将添加此文件夹';
    $('projectChosenPath').textContent = paths.length ? paths.map(basename).join('、') : location;
  }
  function showPicker() {
    if (busy) return; location = ''; nextOffset = null; selectedFolders.clear(); $('projectFolders').replaceChildren(); $('projectChosenPath').textContent = '读取中…';
    $('projectPicker').showModal(); $('projectLocation').value = parent(getContext().cwd || '/'); browse($('projectLocation').value); $('projectLocation').focus();
  }
  const close = () => { if (!choosing) { sequence++; loading = false; selectedFolders.clear(); $('projectPicker').close(); $('addProjectButton').focus(); } };
  $('addProjectButton').addEventListener('click', showPicker);
  $('collapseProjects').addEventListener('click', () => { collapsed = !collapsed; $('collapseProjects').textContent = collapsed ? '+' : '−'; $('collapseProjects').setAttribute('aria-expanded', String(!collapsed)); render(); });
  $('projectLocationForm').addEventListener('submit', event => { event.preventDefault(); browse($('projectLocation').value.trim()); });
  $('projectLocation').addEventListener('input', pickerState);
  $('projectUp').addEventListener('click', () => browse(parent(location)));
  $('projectMore').addEventListener('click', () => browse(location, true));
  $('closeProjectPicker').addEventListener('click', close); $('cancelProjectPicker').addEventListener('click', close);
  $('projectPicker').addEventListener('cancel', event => { event.preventDefault(); close(); });
  $('chooseProject').addEventListener('click', async () => {
    if ($('chooseProject').disabled) return; choosing = true; pickerState(); $('projectPickerError').textContent = '';
    try {
      const targets = selectedFolders.size ? [...selectedFolders] : [location];
      for (const target of targets) { if (!await onSelect(target)) throw new Error(`无法打开项目：${target}`); remember(target); }
      selectedFolders.clear(); $('projectPicker').close();
    }
    catch (error) { $('projectPickerError').textContent = error.message; }
    finally { choosing = false; pickerState(); }
  });
  render();
  void loadRemote();
  return { remember, forget, list: () => [...projects], refresh: render, showPicker, setBusy(value) { if (busy !== value) { busy = value; render(); } } };
}
