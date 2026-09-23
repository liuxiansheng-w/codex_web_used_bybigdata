const $ = id => document.getElementById(id);
const icons = {
  folder: '<path d="M3 7V5h6l2 2h10v12H3Z"/>',
  file: '<path d="M5 3h9l5 5v13H5Z"/><path d="M14 3v6h5M9 13h6m-6 4h6"/>',
};

export function createFileTree({ api, onOpen, onAttach, onManage, onSearch, hasAttachment, notice }) {
  let cwd = '', generation = 0, blocked = false, pending = false;
  let activePath = null, revealRevision = 0, revealPromise = Promise.resolve(false), revealError = '';
  const fileRows = new Map();
  let searchTimer, searchRevision = 0, searchResult = null, searchLoading = false, searchError = '', searchController, searchPage = 0;
  const searchPageSize = 200;
  async function searchProject(append = false) {
    searchController?.abort(); searchController = new AbortController(); const controller = searchController;
    clearTimeout(searchTimer); const revision = ++searchRevision, root = cwd, query = $('fileSearch').value.trim();
    if (!append) { searchResult = null; searchPage = 0; }
    searchError = ''; searchLoading = !!query; render(); if (!query) return;
    let cursor = append ? searchResult?.nextCursor : null;
    const hits = new Map((searchResult?.results || []).map(hit => [hit.path, hit]));
    try {
      do {
        const result = await api(`/api/project/search?cwd=${encodeURIComponent(root)}&query=${encodeURIComponent(query)}&filenames=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, { signal: controller.signal });
        if (revision !== searchRevision || root !== cwd) return;
        for (const hit of result.results) hits.set(hit.path, hit);
        searchResult = { ...result, results: [...hits.values()] }; cursor = result.nextCursor;
        render();
      } while (cursor && hits.size < (searchPage + 1) * searchPageSize);
    }
    catch (error) { if (revision === searchRevision) searchError = error.message; }
    finally { if (revision === searchRevision) { searchLoading = false; if (searchResult?.complete) searchPage = Math.min(searchPage, Math.max(0, Math.ceil(searchResult.results.length / searchPageSize) - 1)); render(); } }
  }
  const directories = new Map(), expanded = new Set(), rowControls = [];
  const selected = entry => hasAttachment(cwd, entry.path);

  function syncSelection() {
    for (const { entry, button, mark } of rowControls) {
      const added = selected(entry);
      button.disabled = blocked || pending || added;
      button.title = added ? '已加入当前消息，可在输入框上方移除' : `加入对话：${entry.path}`;
      button.setAttribute('aria-label', added ? `已加入对话：${entry.path}` : `加入对话：${entry.path}`);
      mark.textContent = added ? '✓' : '+';
      button.classList.toggle('is-attached', added);
    }
  }

  async function attach(entry) {
    if (blocked || pending || selected(entry)) return;
    pending = true; syncSelection();
    try { await onAttach({ cwd, path: entry.path }); }
    catch (error) { notice(error.message); }
    finally { pending = false; syncSelection(); }
  }

  function note(parent, text, retry) {
    const row = document.createElement('li'); row.className = 'file-tree-note';
    const label = document.createElement('span'); label.textContent = text; row.append(label);
    if (retry) { const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = '重试'; button.addEventListener('click', retry); row.append(button); }
    parent.append(row);
  }

  function renderEntry(entry, parent, searching = false) {
    const item = document.createElement('li'); item.className = 'file-tree-item';
    const row = document.createElement('div'); row.className = 'file-tree-row';
    const main = document.createElement('button'); main.type = 'button'; main.className = 'file-main'; main.title = entry.path;
    // Icon markup is a fixed application constant; filenames only use textContent.
    const icon = document.createElement('span'); icon.className = `file-icon ${entry.kind}`; icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[entry.kind] || icons.file}</svg>`;
    const label = document.createElement('span'); label.className = 'file-name'; label.textContent = searching ? entry.path : entry.name;
    const mark = document.createElement('span'); mark.className = 'file-add-mark'; mark.setAttribute('aria-hidden', 'true');
    if (entry.kind === 'folder') {
      const arrow = document.createElement('span'); arrow.className = 'file-chevron'; arrow.textContent = expanded.has(entry.path) ? '⌄' : '›'; arrow.setAttribute('aria-hidden', 'true');
      main.append(arrow, icon, label); main.setAttribute('aria-expanded', String(expanded.has(entry.path)));
      main.addEventListener('click', async () => {
        revealRevision++; revealError = '';
        expanded.has(entry.path) ? expanded.delete(entry.path) : expanded.add(entry.path);
        render();
        if (expanded.has(entry.path) && !directories.has(entry.path)) await load(entry.path);
        $('projectFileTree').querySelector(`[data-focus-key="${encodeURIComponent(entry.path)}"]`)?.focus();
      });
      main.dataset.focusKey = encodeURIComponent(entry.path);
      const add = document.createElement('button'); add.type = 'button'; add.className = 'file-add'; add.append(mark);
      add.addEventListener('click', () => attach(entry)); rowControls.push({ entry, button: add, mark }); row.append(main, add);
    } else {
      main.append(icon, label); main.classList.add('file-leaf'); main.title = `打开编辑：${entry.path}`;
      main.setAttribute('aria-label', `打开编辑：${entry.path}`);
      main.dataset.filePath = entry.path; fileRows.set(entry.path, { row, main });
      main.setAttribute('aria-current', String(entry.path === activePath));
      row.classList.toggle('is-active-file', entry.path === activePath);
      main.addEventListener('click', async () => { try { await onOpen({ cwd, path: entry.path }); } catch (error) { notice(error.message); } });
      const add = document.createElement('button'); add.type = 'button'; add.className = 'file-add'; add.append(mark);
      add.addEventListener('click', () => attach(entry));
      rowControls.push({ entry, button: add, mark }); row.append(main, add);
    }
    if (onManage) { const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'file-add'; manage.textContent = '⋯'; manage.title = `管理：${entry.path}`; manage.setAttribute('aria-label', `管理：${entry.path}`); manage.addEventListener('click', () => onManage({ cwd, ...entry })); row.append(manage); }
    if (onManage) main.addEventListener('contextmenu', event => { event.preventDefault(); onManage({ cwd, ...entry }); });
    item.append(row); parent.append(item);
    if (!searching && entry.kind === 'folder' && expanded.has(entry.path)) {
      const children = document.createElement('ul'); children.className = 'file-tree-children'; children.setAttribute('aria-label', entry.path);
      renderDirectory(entry.path, children); item.append(children);
    }
  }

  function renderDirectory(relative, parent) {
    const data = directories.get(relative);
    for (const entry of data?.entries || []) renderEntry(entry, parent);
    if (!data || data.loading) note(parent, '正在读取…');
    else if (data.error) note(parent, data.error, () => load(relative, data.nextOffset || 0));
    else {
      if (!data.entries.length) note(parent, '此目录没有可显示的文件');
      if (data.nextOffset != null) {
        const item = document.createElement('li'), more = document.createElement('button'); more.type = 'button'; more.className = 'text-button'; more.textContent = '加载更多文件';
        more.addEventListener('click', () => load(relative, data.nextOffset)); item.append(more); parent.append(item);
      }
      if (data.limited) note(parent, '目录过大，仅列出前 10000 个扫描条目中的可见文件。');
    }
  }

  function render() {
    rowControls.length = 0; fileRows.clear(); $('projectFileTree').replaceChildren();
    if (!cwd) { note($('projectFileTree'), '选择项目后显示文件'); return; }
    const query = $('fileSearch').value.trim().toLowerCase();
    if (query) {
      const hits = searchResult?.results || [];
      for (const hit of hits.slice(searchPage * searchPageSize, (searchPage + 1) * searchPageSize)) renderEntry({ path: hit.path, name: hit.path.split('/').at(-1), kind: 'file' }, $('projectFileTree'), true);
      if (searchLoading) note($('projectFileTree'), `正在搜索项目文件…${searchResult ? ` 已检查 ${searchResult.scanned} 项` : ''}`);
      else if (searchError) note($('projectFileTree'), searchError, () => searchProject());
      else if (searchResult) {
        if (!hits.length) note($('projectFileTree'), searchResult.limited || searchResult.skipped ? '可读取的目录中没有匹配文件。' : '项目中没有匹配的文件。');
        if (searchResult.skipped) note($('projectFileTree'), `${searchResult.skipped} 个目录暂时无法读取，可刷新重试。`);
        if (searchResult.limited) note($('projectFileTree'), '搜索未完成，请重试。', () => searchProject());
        if (searchPage || hits.length > searchPageSize || searchResult.nextCursor) {
          const row = document.createElement('li'); row.className = 'file-tree-note';
          const label = document.createElement('span'); label.textContent = `第 ${searchPage + 1} 页 · ${searchResult.nextCursor ? '已找到' : '共'} ${hits.length} 项`; row.append(label);
          const previous = document.createElement('button'); previous.type = 'button'; previous.className = 'text-button'; previous.textContent = '上一页'; previous.disabled = searchPage === 0; previous.onclick = () => { searchPage--; render(); }; row.append(previous);
          const next = document.createElement('button'); next.type = 'button'; next.className = 'text-button'; next.textContent = '下一页'; next.disabled = !searchResult.nextCursor && hits.length <= (searchPage + 1) * searchPageSize;
          next.onclick = () => { searchPage++; if (searchResult.nextCursor && hits.length < (searchPage + 1) * searchPageSize) void searchProject(true); else render(); }; row.append(next); $('projectFileTree').append(row);
        }
      }
    } else renderDirectory('', $('projectFileTree'));
    if (revealError) note($('projectFileTree'), revealError, () => setActive({ cwd, path: activePath }, { force: true }));
    syncSelection();
  }

  function load(relative = '', offset = 0) {
    if (!cwd) return Promise.resolve();
    if (directories.get(relative)?.loading) return directories.get(relative).promise;
    const expected = generation, requestedCwd = cwd;
    const old = directories.get(relative);
    const data = { entries: offset ? old?.entries || [] : [], loading: true, nextOffset: offset || null, error: '' };
    directories.set(relative, data); render();
    data.promise = (async () => {
      try {
        const result = await api(`/api/project/files?cwd=${encodeURIComponent(requestedCwd)}&path=${encodeURIComponent(relative)}&offset=${offset}`);
        if (expected !== generation) return;
        data.entries = [...new Map([...data.entries, ...result.entries].map(entry => [entry.path, entry])).values()];
        data.nextOffset = result.nextOffset; data.limited = result.limited;
      } catch (error) { if (expected === generation) data.error = error.message; }
      finally { if (expected === generation) { data.loading = false; render(); } }
    })();
    return data.promise;
  }

  function resetSearch() {
    searchController?.abort(); clearTimeout(searchTimer); searchRevision++; searchPage = 0;
    searchResult = null; searchLoading = false; searchError = ''; $('fileSearch').value = '';
  }
  function setActive(entry, { force = false } = {}) {
    const next = entry?.cwd === cwd && typeof entry.path === 'string' && entry.path.split('/').every(part => part && part !== '.' && part !== '..') ? entry.path : null;
    if (!force && next === activePath) return revealPromise;
    activePath = next; revealError = ''; const revision = ++revealRevision, root = cwd;
    for (const [path, { row, main }] of fileRows) { row.classList.toggle('is-active-file', path === next); main.setAttribute('aria-current', String(path === next)); }
    if (!next) return Promise.resolve(false);
    resetSearch();
    const current = () => root === cwd && revision === revealRevision;
    revealPromise = (async () => {
      try {
        const parts = next.split('/'); let parent = '';
        for (let index = 0; index < parts.length && current(); index++) {
          const target = parts.slice(0, index + 1).join('/');
          let refreshed = !directories.has(parent), found;
          const offsets = new Set();
          if (refreshed) await load(parent);
          while (current()) {
            const data = directories.get(parent);
            if (data?.loading) { await data.promise; continue; }
            if (data?.error) throw new Error(data.error);
            found = data?.entries.find(entry => entry.path === target);
            if (found) break;
            if (data?.nextOffset != null && !offsets.has(data.nextOffset)) { offsets.add(data.nextOffset); await load(parent, data.nextOffset); continue; }
            // A file may have just been created by AI or another editor.
            if (!refreshed) { refreshed = true; offsets.clear(); await load(parent); continue; }
            throw new Error(`目录中未找到 ${parts[index]}，文件可能已移动或当前目录不可见。`);
          }
          if (!current()) return false;
          if (index < parts.length - 1) {
            if (found?.kind !== 'folder') throw new Error(`无法展开 ${target}`);
            expanded.add(target); parent = target;
          }
        }
        if (!current()) return false;
        render();
        // Only scroll the directory; do not take focus from the editor or chat.
        const row = fileRows.get(next)?.row, viewport = $('projectFileTree').parentElement;
        if (row && viewport) {
          const r = row.getBoundingClientRect(), v = viewport.getBoundingClientRect();
          if (r.top < v.top) viewport.scrollTop += r.top - v.top;
          else if (r.bottom > v.bottom) viewport.scrollTop += r.bottom - v.bottom;
        }
        return !!row;
      } catch (error) { if (current()) { revealError = `定位文件失败：${error.message}`; render(); } return false; }
    })();
    return revealPromise;
  }

  $('fileSearch').addEventListener('input', () => { revealRevision++; revealError = ''; searchController?.abort(); clearTimeout(searchTimer); searchRevision++; searchPage = 0; searchResult = null; searchLoading = !!$('fileSearch').value.trim(); searchError = ''; render(); searchTimer = setTimeout(searchProject, 280); });
  $('refreshFiles').addEventListener('click', () => { generation++; revealRevision++; revealError = ''; directories.clear(); expanded.clear(); if ($('fileSearch').value.trim()) { void searchProject(); return load(); } return activePath ? setActive({ cwd, path: activePath }, { force: true }) : load(); });
  $('collapseFiles').addEventListener('click', () => { revealRevision++; revealError = ''; expanded.clear(); searchController?.abort(); clearTimeout(searchTimer); searchRevision++; searchPage = 0; searchResult = null; searchLoading = false; $('fileSearch').value = ''; render(); });
  render();
  return {
    setProject(value) { if (value === cwd) return; cwd = value; generation++; revealRevision++; activePath = null; revealError = ''; directories.clear(); expanded.clear(); searchController?.abort(); clearTimeout(searchTimer); searchRevision++; searchPage = 0; searchResult = null; searchLoading = false; $('fileSearch').value = ''; render(); load(); },
    setActive,
    setBusy(value) { blocked = value; syncSelection(); },
  };
}
