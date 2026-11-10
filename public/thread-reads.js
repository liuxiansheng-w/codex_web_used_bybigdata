const time = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n < 1e12 ? n * 1000 : n) : 0;
};

export function isThreadUnread(thread, state) {
  if (!state || !thread?.id || !thread.cwd) return false;
  const item = state.threads.find(entry => entry.id === thread.id && entry.cwd === thread.cwd);
  const project = state.projects.find(entry => entry.cwd === thread.cwd);
  if (item?.forcedAt) return true;
  return time(thread.updatedAt) > Math.max(state.baseline, state.globalReadAt, project?.readAt || 0, item?.readAt || 0);
}

export function createThreadReads({ api, getContext, onChange, notice }) {
  let snapshot = null, loading = null, pending = false, held = null, timer, queue = Promise.resolve();
  const available = () => getContext().available === true;
  function accept(value) {
    if (!value || !Number.isSafeInteger(value.revision) || !Array.isArray(value.threads) || !Array.isArray(value.projects)) return;
    if (snapshot && value.revision < snapshot.revision) return;
    snapshot = value; onChange();
  }
  async function refresh() {
    if (!available()) return;
    if (!loading) loading = api('/api/thread-reads').then(accept).finally(() => { loading = null; });
    return loading;
  }
  function action(fields, silent = false) {
    const run = async () => {
      if (!available()) return false;
      if (!snapshot) await refresh();
      if (!snapshot) return false;
      pending = true;
      try { accept(await api('/api/thread-reads', { revision: snapshot.revision, ...fields })); return true; }
      catch (error) {
        if (error.status === 409) await refresh().catch(() => {});
        if (!silent) notice(error.message);
        return false;
      } finally { pending = false; onChange(); }
    };
    const next = queue.then(run, run); queue = next.catch(() => {}); return next;
  }
  async function toggle(thread) {
    if (!thread?.id || !thread.cwd) return;
    const unread = isThreadUnread(thread, snapshot);
    if (!unread && getContext().thread?.id === thread.id) held = thread.id;
    const ok = await action({ action: unread ? 'read' : 'unread', threadId: thread.id, cwd: thread.cwd, ...(unread ? { seenAt: time(thread.updatedAt) || Date.now() } : {}) });
    if (!ok && held === thread.id) held = null;
  }
  function selected(thread) {
    held = null; clearTimeout(timer);
    if (thread && isThreadUnread(thread, snapshot)) void action({ action: 'read', threadId: thread.id, cwd: thread.cwd, seenAt: time(thread.updatedAt) || Date.now() }, true);
  }
  function observe(thread) {
    clearTimeout(timer);
    if (!thread || held === thread.id || !isThreadUnread(thread, snapshot) || !getContext().reading) return;
    const id = thread.id, seenAt = time(thread.updatedAt);
    timer = setTimeout(() => {
      const context = getContext();
      if (context.reading && context.thread?.id === id && held !== id && isThreadUnread(context.thread, snapshot)) void action({ action: 'read', threadId: id, cwd: thread.cwd, seenAt }, true);
    }, 700);
  }
  return { accept, refresh, toggle, observe, selected, isUnread: thread => isThreadUnread(thread, snapshot),
    allRead: () => action({ action: 'all-read', cwd: getContext().cwd, allProjects: getContext().allProjects, seenAt: Date.now() }),
    get ready() { return !!snapshot; }, get busy() { return pending; } };
}
