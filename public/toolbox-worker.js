import { runTool } from './toolbox-core.js';
self.onmessage = async ({ data }) => {
  try { self.postMessage({ result: await runTool(data) }); }
  catch (error) { self.postMessage({ error: String(error.message || '处理失败。').slice(0, 1000) }); }
};
