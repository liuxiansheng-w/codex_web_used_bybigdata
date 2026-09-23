import { extractParams, substituteParams, sqlStatementKind } from '../public/sql-parameters.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
// The original SQL runner owns SQL type, syntax and operation policy. The web
// workbench only checks the request envelope; do not add a second SQL allowlist.
export function validateQuery(sql) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 200000) fail('请选择非空且不超过 20 万字符的 SQL。');
  return sql;
}

export function prepareQuery({ sql, params = {}, engine = 'huawei' }) {
  validateQuery(sql);
  if (!['huawei', 'aliyun'].includes(engine)) fail('请选择华为云或阿里云。');
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('参数格式无效。');
  const names = extractParams(sql);
  if (names.length > 100) fail('单次查询最多支持 100 个参数。');
  for (const name of names) {
    if (!Object.hasOwn(params, name)) fail(`请填写参数：${name}`);
    if (!['string', 'number'].includes(typeof params[name]) || String(params[name]).length > 10000) fail(`参数 ${name} 无效或过长。`);
  }
  // The runner also adds this mark; adding it here makes the request auditable.
  const marked = /^--\s*lzy\b/i.test(sql.trim().split(/\r?\n/, 1)[0]) ? sql.trim() : `--lzy\n${sql.trim()}`;
  const cleanParams = Object.fromEntries(names.map(name => [name, params[name]]));
  return { sql: marked, params: cleanParams, engine, timeoutSeconds: engine === 'aliyun' ? 3000 : 900 };
}

export class SqlRunner {
  constructor({ base = process.env.SQL_RUNNER_URL || 'http://127.0.0.1:5177', fetchImpl = fetch } = {}) {
    const url = new URL(base);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('SQL_RUNNER_URL 必须是本机 HTTP 服务地址。');
    this.base = url.origin; this.fetch = fetchImpl; this.active = false;
  }
  async status() {
    try {
      const response = await this.fetch(`${this.base}/api/runner-state`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
      const body = await response.json();
      return { available: response.ok && body.ok === true, service: this.base };
    } catch { return { available: false, service: this.base }; }
  }
  async execute(payload) {
    const request = prepareQuery(payload);
    if (this.active) fail('已有查询正在执行，请等待完成后再查询。', 409);
    this.active = true;
    try {
      const response = await this.fetch(`${this.base}/api/execute-sql`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
        redirect: 'error', signal: AbortSignal.timeout((request.timeoutSeconds + 15) * 1000),
      });
      let text = '', bytes = 0; const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 16 * 1024 * 1024) fail('结果超过 16 MB，请减少查询范围或列数后再查询。', 413);
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
      let data; try { data = JSON.parse(text); } catch { fail('查询服务返回了无效结果。', 502); }
      if (!response.ok || data.ok !== true) fail(String(data.error || '查询失败，请检查 SQL。').slice(0, 12000), 502);
      const source = Array.isArray(data.rows) ? data.rows : [];
      // Page the table in the browser; keep every row returned by the bounded
      // upstream response so filtering and "download all" use the full result.
      const rows = source;
      const columns = Array.isArray(data.columns) ? data.columns.map(String) : [];
      let downloadUrl = null;
      try { const url = new URL(data.ossUrl); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) downloadUrl = url.href; } catch {}
      return { ok: true, engine: request.engine, sqlType: sqlStatementKind(substituteParams(request.sql, request.params)), durationMs: Number(data.durationMs) || 0, rowCount: source.length, rows, columns,
        truncated: source.length > rows.length, executedSql: String(data.executedSql || substituteParams(request.sql, request.params)), downloadUrl };
    } catch (error) {
      if (error.status) throw error;
      if (error.name === 'TimeoutError' || error.name === 'AbortError') fail('查询等待超时，远端任务可能仍在执行，请先核实状态。', 504);
      fail('SQL 查询服务连接失败或中断。请确认本机 DGC SQL runner 已启动（默认端口 5177）；若查询已提交，请先核实远端状态再重试。', 503);
    } finally { this.active = false; }
  }
}
