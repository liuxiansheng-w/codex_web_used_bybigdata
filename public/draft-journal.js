// Opt-in, per-document and per-window storage. Writers never overwrite each
// other's slots; recovery keeps concurrent versions without caching attachments.
export function createDraftJournal({ storage, name, limit = 1_000_000, maxEntries = 60, onError = () => {} }) {
  const prefix = 'codex-desk:' + name + ':v2:', legacy = 'codex-desk:' + name;
  const writer = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  const known = new Map(), own = new Map();
  const enabled = () => storage?.getItem('codex-desk:persistDrafts') === 'true';
  function keys() {
    const result = [];
    for (let i = 0; i < (storage?.length || 0); i++) { const key = storage.key(i); if (key?.startsWith(prefix)) result.push(key); }
    return result;
  }
  function list() {
    if (!enabled()) return [];
    try {
      return keys().flatMap(key => {
        const raw = storage.getItem(key); known.set(key, raw);
        try {
          const record = JSON.parse(raw);
          return record && typeof record.id === 'string' && record.value && typeof record.value === 'object' && Number.isFinite(record.at) ? [{ ...record, key }] : [];
        } catch { return []; }
      }).sort((a, b) => b.at - a.at || b.key.localeCompare(a.key));
    } catch { onError('本机草稿读取失败，请手动备份。'); return []; }
  }
  function put(id, value) {
    if (!enabled()) return false;
    try {
      const data = JSON.stringify(value), records = list(), existing = records.find(record => record.id === id);
      if (existing && JSON.stringify(existing.value) === data) return true;
      const key = own.get(id) || prefix + encodeURIComponent(id) + ':' + writer;
      const record = JSON.stringify({ id, at: Math.max(Date.now(), (records[0]?.at || 0) + 1), value });
      const others = records.filter(item => item.key !== key);
      if (others.length >= maxEntries || record.length + others.reduce((n, item) => n + (known.get(item.key)?.length || 0), 0) > limit) throw new Error('limit');
      storage.setItem(key, record); own.set(id, key); known.set(key, record); return true;
    } catch { onError('浏览器草稿空间不足，未覆盖已有版本；请手动备份或清理本机草稿。'); return false; }
  }
  function remove(id, matches = null) {
    // Delete only versions this page has observed, with an exact readback check.
    // An edit made in another window since then remains recoverable.
    if (!enabled()) return;
    try {
      for (const [key, raw] of known) {
        let record; try { record = JSON.parse(raw); } catch { continue; }
        if (record?.id === id && (matches ? matches(record.value) : key === own.get(id)) && storage.getItem(key) === raw) { storage.removeItem(key); known.delete(key); }
      }
      own.delete(id);
    } catch { onError('草稿缓存清理失败，已有内容仍保留。'); }
  }
  function migrate() {
    if (!enabled()) return;
    try {
      const raw = storage.getItem(legacy); if (!raw) return;
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        const pair = Array.isArray(entry) ? entry : [JSON.stringify([entry.cwd, entry.path]), entry];
        if (typeof pair[0] !== 'string' || !pair[1] || typeof pair[1] !== 'object') continue;
        const key = prefix + encodeURIComponent(pair[0]) + ':legacy';
        if (storage.getItem(key) === null) storage.setItem(key, JSON.stringify({ id: pair[0], at: 0, value: name === 'promptDrafts' ? { text: pair[1].text, model: pair[1].model, context: {} } : pair[1] }));
      }
      if (storage.getItem(legacy) === raw) storage.removeItem(legacy);
    } catch { onError('旧草稿尚未完成迁移，原缓存已保留。'); }
  }
  migrate(); list();
  return {
    put, remove, list,
    latest() { return [...new Map(list().reverse().map(record => [record.id, record])).values()]; },
    clear() { try { for (const key of keys()) storage.removeItem(key); storage?.removeItem(legacy); known.clear(); own.clear(); } catch { onError('本机草稿清理失败。'); } },
    matches(key) { return key === legacy || key?.startsWith(prefix) || key === 'codex-desk:persistDrafts'; },
  };
}
