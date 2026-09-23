import { Worker } from 'node:worker_threads';
import { check } from './workspace.mjs';

export class SpreadsheetPreview {
  workers = new Set();
  constructor(workbench) { this.workbench = workbench; }
  async read(input) {
    check(Number.isInteger(input.sheet ?? 0) && (input.sheet ?? 0) >= 0 && (input.sheet ?? 0) < 100, '工作表编号无效。');
    check(/\.(xlsx|xls|xlsm)$/i.test(input.path || ''), '请选择 Excel 文件。');
    check(this.workers.size < 2, '正在解析其他工作簿，请稍后重试。', 429);
    const artifact = await this.workbench.artifact(input);
    check(!input.version || input.version === artifact.version, '文件已更新，请重新打开预览。', 409);
    check(this.workers.size < 2, '正在解析其他工作簿，请稍后重试。', 429);
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./spreadsheet-worker.mjs', import.meta.url), { workerData: { bytes: Buffer.from(artifact.base64, 'base64'), sheet: input.sheet ?? 0 }, resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32 } });
      this.workers.add(worker); let finished = false;
      const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); this.workers.delete(worker); void worker.terminate(); if (error) reject(error); else resolve({ ...result, version: artifact.version }); };
      const timer = setTimeout(() => finish(new Error('工作簿解析超时，请下载后用 Excel 打开。')), 10000);
      worker.once('message', result => result.error ? finish(new Error(result.error)) : finish(null, result));
      worker.once('error', () => finish(new Error('工作簿过大或格式异常，请下载后查看。')));
      worker.once('exit', () => finish(new Error('工作簿解析中断，请重新打开。')));
    });
  }
  close() { for (const worker of this.workers) void worker.terminate(); }
}
