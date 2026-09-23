// Freeze the wire representation: Workspace mutates its thread/items in place.
// A prepared version can be shared by all clients, including slow readers.
export function prepareThread(thread) {
  const { items, ...fields } = thread;
  return { id: thread.id, revision: thread.revision, fields: JSON.stringify(fields), items: new Map(items.map(item => [item.id, JSON.stringify(item)])) };
}

const fullThread = thread => `${thread.fields.slice(0, -1)},"items":[${[...thread.items.values()].join(',')}]}`;
function patchThread(previous, current) {
  const changed = [...current.items].filter(([id, item]) => previous.items.get(id) !== item).map(([, item]) => item);
  return `{"baseRevision":${JSON.stringify(previous.revision ?? null)},"thread":${current.fields},"order":${JSON.stringify([...current.items.keys()])},"items":[${changed.join(',')}]}`;
}

export function createEventStream(res, { delta = false, stallMs = 60_000, heartbeatMs = 15_000, onClose = () => {} } = {}) {
  const versions = new Map(), pending = new Map();
  let blocked = false, closed = false, stallTimer;
  const cleanup = () => {
    if (closed) return;
    closed = true; clearTimeout(stallTimer); clearInterval(heartbeat);
    pending.clear(); versions.clear(); res.off('drain', drain); onClose();
  };
  const write = text => {
    if (closed) return;
    // false means accepted but waiting for the socket, not a broken connection.
    if (!res.write(text)) {
      blocked = true;
      stallTimer = setTimeout(() => res.destroy(), stallMs);
      stallTimer.unref?.();
    }
  };
  const frame = (event, json) => write(`event: ${event}\ndata: ${json}\n\n`);
  const deliver = value => {
    if (value.event === 'thread') {
      const current = value.thread, previous = versions.get(current.id);
      frame(delta && previous ? 'thread-patch' : 'thread', delta && previous ? patchThread(previous, current) : fullThread(current));
      versions.set(current.id, current);
    } else frame(value.event, value.json);
  };
  const enqueue = (key, value) => {
    if (closed) return;
    // Thread events represent complete state. Keep only the newest pending
    // version per thread instead of queuing the entire history on every token.
    if (blocked) pending.set(key, value);
    else deliver(value);
  };
  function drain() {
    clearTimeout(stallTimer); blocked = false;
    for (const [key, value] of pending) {
      pending.delete(key); deliver(value);
      if (blocked || closed) break;
    }
  }
  const heartbeat = setInterval(() => { if (!blocked && !closed) write(': heartbeat\n\n'); }, heartbeatMs);
  heartbeat.unref?.();
  res.on('drain', drain); res.once('close', cleanup); res.once('error', cleanup);
  return {
    snapshot(connected, threads) {
      for (const thread of threads) versions.set(thread.id, thread);
      frame('snapshot', `{"connected":${JSON.stringify(connected)},"threads":[${threads.map(fullThread).join(',')}]}`);
    },
    thread(thread) { enqueue(`thread:${thread.id}`, { event: 'thread', thread }); },
    connection(data) { enqueue('connection', { event: 'connection', json: JSON.stringify(data) }); },
    close() { cleanup(); res.end(); },
  };
}
