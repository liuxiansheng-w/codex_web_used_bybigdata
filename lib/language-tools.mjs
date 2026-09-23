import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { check } from './workspace.mjs';
let activeWorkers = 0;

// Parse/format text in a bounded worker. Never execute Python or SQL.
export async function languageTools({ content, language, dialect = 'sql', action }) {
  check(typeof content === 'string' && content.length <= 200000, '格式化/诊断最多支持 20 万字符。');
  check(['python', 'sql'].includes(language) && ['format', 'check'].includes(action), '仅支持 SQL / Python 格式化或静态检查。');
  check(['sql', 'postgresql', 'mysql', 'hive', 'spark', 'transactsql', 'sqlite'].includes(dialect), 'SQL 方言无效。');
  check(activeWorkers < 4, '静态分析任务过多，请稍后重试。', 429); activeWorkers++;
  try { return await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { content, language, dialect, action } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('静态分析超时，请缩小文件。')); }, 5000);
    worker.once('message', result => { clearTimeout(timer); worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(new Error('静态分析进程已结束。')); });
  }); } finally { activeWorkers--; }
}
if (!isMainThread) {
  try {
    const { content, language, action, dialect } = workerData;
    if (language === 'python') {
      const { Workspace, PositionEncoding } = await import('@astral-sh/ruff-wasm-nodejs');
      const workspace = new Workspace({ 'line-length': 88, 'indent-width': 4, lint: { select: ['E4', 'E7', 'E9', 'F'] } }, PositionEncoding.Utf16);
      try { parentPort.postMessage(action === 'format' ? { content: workspace.format(content), engine: 'Ruff' } : { diagnostics: workspace.check(content), engine: 'Ruff（静态检查，不执行代码）' }); }
      finally { workspace.free(); }
    } else {
      const { format } = await import('sql-formatter');
      const formatted = format(content, { language: dialect, tabWidth: 2 });
      parentPort.postMessage(action === 'format' ? { content: formatted, engine: 'SQL Formatter' } : { diagnostics: [], engine: 'SQL Formatter 词法/格式解析通过；未验证表名、字段或数据库语义' });
    }
  } catch (error) { parentPort.postMessage({ error: String(error.message || error).slice(0, 2000) }); }
}
