import { readChartSpec } from './chart-protocol.js';
import { createChartPanel } from './chart-panel.js';

// Each complete chart block owns its controls; ordinary streamed text updates
// preserve those controls and the user's local styling changes.
export function createMessageCharts(article, { onContext } = {}) {
  const records = new Map();
  function sync() {
    const figures = [...article.querySelectorAll('[data-ai-chart]')];
    for (const [figure, record] of records) if (!figures.includes(figure)) { record.panel?.destroy(); records.delete(figure); }
    for (const [index, figure] of figures.entries()) {
      const source = figure.querySelector('[data-ai-chart-source]')?.textContent || '';
      if (records.get(figure)?.source === source) continue;
      records.get(figure)?.panel?.destroy();
      const record = { source }, host = figure.querySelector('[data-ai-chart-host]'); records.set(figure, record); if (!host) continue; host.replaceChildren();
      try {
        if (index >= 10) throw new Error('单条回复最多渲染 10 张图表；其余保留完整 JSON 源码。');
        const spec = readChartSpec(source); record.panel = createChartPanel(host, { onContext });
        record.panel.setData(spec.table, { settings: spec.settings, note: 'AI 返回的数据，请结合原始数据核对' });
      } catch (error) { const message = article.ownerDocument.createElement('p'); message.className = 'chart-status'; message.dataset.error = 'true'; message.setAttribute('role', 'status'); message.textContent = '图表无法渲染：' + error.message; host.append(message); }
    }
  }
  sync();
  return { sync, destroy() { for (const record of records.values()) record.panel?.destroy(); records.clear(); } };
}
