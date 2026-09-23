const cacheKey = 'lemon:queryResults:v1', preferenceKey = 'lemon:keepQueryResults';
export function createQueryHistory(storage) {
  const enabled = () => { try { return storage?.getItem(preferenceKey) === 'true'; } catch { return false; } };
  const safeUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } };
  function read() {
    try {
      if (!enabled()) return [];
      const text = storage.getItem(cacheKey); if (!text || text.length > 4_000_000) return [];
      const data = JSON.parse(text); if (!Array.isArray(data)) return [];
      const seen = new Set();
      return data.slice(0, 20).filter(tab => tab && Number.isSafeInteger(tab.id) && tab.id > 0 && !seen.has(tab.id) && seen.add(tab.id) && typeof tab.result?.cwd === 'string' && typeof tab.result?.path === 'string' && typeof tab.result?.sql === 'string' && Array.isArray(tab.result.columns) && tab.result.columns.every(column => typeof column === 'string') && Array.isArray(tab.result.rows) && tab.result.rows.every(row => row && typeof row === 'object')).map(tab => ({
        id: tab.id, name: typeof tab.name === 'string' ? tab.name.slice(0, 60) : '', page: 0, pageSize: [50, 100, 200].includes(tab.pageSize) ? tab.pageSize : 50, filter: typeof tab.filter === 'string' ? tab.filter : '',
        sort: tab.result.columns.includes(tab.sort?.column) && [1, -1].includes(tab.sort.direction) ? tab.sort : null,
        filters: (Array.isArray(tab.filters) ? tab.filters : []).filter(rule => rule && tab.result.columns.includes(rule.column) && (rule.op === 'in' ? Array.isArray(rule.values) && rule.values.every(value => typeof value === 'string') : ['contains', 'notcontains', 'equals', 'notequals', 'gt', 'gte', 'lt', 'lte', 'empty', 'notempty'].includes(rule.op) && typeof rule.value === 'string')),
        result: { ...tab.result, rows: tab.result.rows.slice(0, 1000), truncated: !!tab.result.truncated || tab.result.rows.length > 1000, engine: tab.result.engine === 'aliyun' ? 'aliyun' : 'huawei', startedAt: Number.isFinite(tab.result.startedAt) ? tab.result.startedAt : 0, durationMs: Number.isFinite(tab.result.durationMs) ? tab.result.durationMs : 0, downloadUrl: safeUrl(tab.result.downloadUrl), restored: true, ...(tab.result.loading ? { loading: false, ok: false, error: '页面已重新打开，此次远端查询状态待核对。重新查询前请确认原任务是否结束。', uncertain: true } : {}) },
      }));
    } catch { return []; }
  }
  function write(tabs) {
    if (!enabled()) return;
    // Keep the most recent 20 snapshots, bound the local cache, and explicitly
    // mark a shortened preview so export-all never claims to contain lost rows.
    const saved = tabs.slice().sort((a, b) => b.result.startedAt - a.result.startedAt).slice(0, 20).map(tab => {
      const result = { ...tab.result, rows: tab.result.rows.slice(0, 1000) };
      if (result.rows.length < tab.result.rows.length) result.truncated = true;
      return { ...tab, result };
    });
    let json = JSON.stringify(saved);
    while (json.length > 3_800_000 && saved.some(tab => tab.result.rows.length)) {
      const tab = saved.reduce((a, b) => JSON.stringify(a.result.rows).length > JSON.stringify(b.result.rows).length ? a : b);
      tab.result.rows = tab.result.rows.slice(0, Math.floor(tab.result.rows.length / 2)); tab.result.truncated = true; json = JSON.stringify(saved);
    }
    if (json.length > 3_800_000) throw new Error('查询记录过大，本次没有保存。请下载需要保留的数据。');
    storage.setItem(cacheKey, json);
  }
  function setEnabled(value) { if (!storage) throw new Error('浏览器存储不可用。'); storage.setItem(preferenceKey, String(value)); if (!value) storage.removeItem(cacheKey); }
  return { enabled, read, write, setEnabled };
}
