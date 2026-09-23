import { renderDiagram } from './vendor/markdown/mermaid.js';
let pending = Promise.resolve();
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'lemon-render-diagram') return;
  const { id, source, dark } = event.data;
  if (typeof id !== 'string' || typeof source !== 'string' || source.length > 100000) return;
  pending = pending.catch(() => {}).then(async () => {
    try { parent.postMessage({ type: 'lemon-diagram', id, svg: await renderDiagram(source, !!dark) }, location.origin); }
    catch { parent.postMessage({ type: 'lemon-diagram', id, error: '图表语法无法解析，请展开源码检查 Mermaid 语法。' }, location.origin); }
  });
});
parent.postMessage({ type: 'lemon-diagram-ready' }, location.origin);
