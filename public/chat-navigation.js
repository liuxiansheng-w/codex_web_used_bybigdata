const valid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

export function linkedThread(url) {
  const value = new URL(url).searchParams.get('thread');
  return value === null ? undefined : valid(value) ? value : null;
}

export function chatLink(url, id) {
  if (id !== null && !valid(id)) throw new Error('会话编号无效。');
  const result = new URL(url);
  if (id) result.searchParams.set('thread', id); else result.searchParams.delete('thread');
  return result.href;
}

export function createChatNavigation({ win = window, select, reset, current, notify }) {
  let navigating = false, generation = 0;
  const write = (id, replace = false) => {
    if (navigating) return;
    const next = chatLink(win.location.href, id);
    if (next !== win.location.href) win.history[replace ? 'replaceState' : 'pushState']({}, '', next);
  };
  win.addEventListener('popstate', async () => {
    const at = ++generation, id = linkedThread(win.location.href);
    if (id === null) { navigating = false; notify('聊天链接中的会话编号无效。'); write(current(), true); return; }
    navigating = true;
    try {
      const ok = id ? await select(id) : await reset();
      if (at !== generation) return;
      if (ok === false) { navigating = false; write(current(), true); }
    } catch (error) { if (at === generation) { notify(error.message); navigating = false; write(current(), true); } }
    finally { if (at === generation) navigating = false; }
  });
  return { write, initial: linkedThread(win.location.href), link: id => chatLink(win.location.href, id) };
}
