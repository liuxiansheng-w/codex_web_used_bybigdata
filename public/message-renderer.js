import { markdown } from './markdown.js';
import { enhanceMarkdown } from './markdown-preview.js';

// Reconcile locally rendered, sanitized Markdown. Unchanged blocks, code scroll,
// buttons and focus survive updates; a text selection defers only this reply.
function reconcile(parent, source) {
  let current = parent.firstChild;
  for (const next of [...source.childNodes]) {
    const compatible = node => node && node.nodeType === next.nodeType && (node.nodeType !== 1 || node.tagName === next.tagName);
    if (!compatible(current)) {
      const match = [...parent.childNodes].slice(current ? [...parent.childNodes].indexOf(current) : parent.childNodes.length).find(node => node.isEqualNode(next));
      if (match) { parent.insertBefore(match, current); current = match; }
      else { const added = next.cloneNode(true); parent.insertBefore(added, current); continue; }
    }
    if (current.nodeType === 3) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; }
    else if (current.nodeType === 1 && current.matches('[data-ai-chart]') && next.matches('[data-ai-chart]') && current.querySelector('[data-ai-chart-source]')?.textContent === next.querySelector('[data-ai-chart-source]')?.textContent) { /* Preserve mounted charts during streaming. */ }
    else if (current.nodeType === 1 && current.matches('[data-markdown-diagram]') && next.matches('[data-markdown-diagram]') && current.querySelector('pre code')?.textContent === next.querySelector('pre code')?.textContent) { /* Preserve rendered diagrams, zoom and source disclosure. */ }
    else if (current.nodeType === 1 && !current.isEqualNode(next)) {
      for (const attribute of [...current.attributes]) if (attribute.name !== 'open' && !next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
      for (const attribute of [...next.attributes]) if (attribute.name !== 'open' && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
      reconcile(current, next);
    }
    current = current.nextSibling;
  }
  while (current) { const next = current.nextSibling; current.remove(); current = next; }
}

export function createMessageRenderer({ document: doc = document, onCopy, onOpenFile, runnerPath = () => null, onContext, loadCharts = () => import('./vendor/toolbox.js'), diagram }) {
  const views = new WeakMap(), pending = new Set(), chartViews = new Set(), diagramViews = new Set(); let chartModule, disposed = false;
  function clearDiagrams(view) { for (const state of view.diagrams?.values() || []) state.viewer.dispose(); view.diagrams?.clear(); diagramViews.delete(view); }
  function syncDiagrams(view) {
    const figures = new Set(view.body.querySelectorAll('[data-markdown-diagram]'));
    view.diagrams ||= new Map();
    for (const [figure, state] of view.diagrams) {
      if (figures.has(figure) && state.source === figure.querySelector('pre code')?.textContent) continue;
      state.viewer.dispose(); view.diagrams.delete(figure);
    }
    for (const figure of figures) if (!view.diagrams.has(figure)) view.diagrams.set(figure, { source: figure.querySelector('pre code').textContent, viewer: enhanceMarkdown(figure, { diagram }) });
    if (view.diagrams.size) diagramViews.add(view); else diagramViews.delete(view);
  }
  function clearCharts(view) { view.chartGeneration = (view.chartGeneration || 0) + 1; view.charts?.destroy(); view.charts = null; chartViews.delete(view); }
  function syncCharts(view) {
    if (!view.body.querySelector('[data-ai-chart]')) { clearCharts(view); return; }
    if (view.charts) { view.charts.sync(); return; }
    const token = (view.chartGeneration || 0) + 1; view.chartGeneration = token; chartViews.add(view);
    void (chartModule ||= loadCharts()).then(module => {
      if (disposed || token !== view.chartGeneration || !view.el.isConnected) return;
      view.charts = module.createMessageCharts(view.body, { onContext });
    }).catch(() => { chartModule = null; if (token === view.chartGeneration && !disposed) for (const host of view.body.querySelectorAll('[data-ai-chart-host]')) host.textContent = '图表模块暂时无法加载，请刷新页面后重试；配置与数据仍可查看。'; });
  }
  const selected = body => { const selection = doc.getSelection?.(); return selection && !selection.isCollapsed && (body.contains(selection.anchorNode) || body.contains(selection.focusNode)); };
  const focused = body => body.contains(doc.activeElement) && doc.activeElement?.matches('input, textarea, select, [contenteditable=true]');
  function flush(view) {
    if (selected(view.body) || focused(view.body)) { pending.add(view); view.refresh.hidden = false; return; }
    const template = doc.createElement('template'); template.innerHTML = markdown(view.item.text, { charts: true, diagrams: true });
    for (const code of template.content.querySelectorAll('pre > code')) {
      if (code.closest('[data-markdown-diagram]')) continue;
      const copy = doc.createElement('button'); copy.type = 'button'; copy.className = 'code-copy'; copy.textContent = '复制代码'; code.parentElement.prepend(copy);
    }
    for (const link of template.content.querySelectorAll('a[href]')) if (runnerPath(link.href)) { link.removeAttribute('target'); link.title = '在当前工作台打开 SQL'; }
    const scrolls = [...view.body.querySelectorAll('pre, .markdown-table')].map(node => [node, node.scrollTop, node.scrollLeft]);
    reconcile(view.body, template.content);
    for (const [node, top, left] of scrolls) if (node.isConnected) { node.scrollTop = top; node.scrollLeft = left; }
    syncDiagrams(view);
    syncCharts(view);
    view.visibleText = view.item.text; view.refresh.hidden = true; pending.delete(view);
  }
  function create(el, item) {
    el.className = 'message agent';
    const duration = doc.createElement('div'); duration.className = 'turn-duration'; duration.hidden = true;
    const label = doc.createElement('div'); label.className = 'message-label';
    const icon = doc.createElement('img'); icon.src = '/favicon.svg'; icon.alt = ''; label.append(icon, item.type === 'plan' ? '执行计划' : '柠檬');
    const copy = doc.createElement('button'); copy.type = 'button'; copy.className = 'copy-response'; copy.textContent = '复制'; copy.setAttribute('aria-label', '复制这条回复'); label.append(copy);
    const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.className = 'text-button reply-refresh'; refresh.textContent = '有新内容 · 更新'; refresh.hidden = true; label.append(refresh);
    const body = doc.createElement('div'); body.className = 'message-body';
    const questions = doc.createElement('div'); questions.className = 'async-question-summary'; questions.hidden = true;
    el.replaceChildren(duration, label, body, questions);
    const view = { el, body, label, refresh, questions, item, visibleText: '' }; views.set(el, view);
    copy.addEventListener('click', () => onCopy(view.visibleText || ''));
    refresh.addEventListener('click', () => { doc.getSelection?.()?.removeAllRanges(); flush(view); });
    body.addEventListener('click', event => {
      const codeButton = event.target.closest?.('.code-copy');
      if (codeButton) { void onCopy(codeButton.parentElement.querySelector('code')?.textContent || '', true); return; }
      const file = event.target.closest?.('[data-file-link]');
      if (file) { event.preventDefault(); void onOpenFile(file.dataset.fileLink); return; }
      const link = event.target.closest?.('a[href]'), path = link && runnerPath(link.href);
      if (path) { event.preventDefault(); void onOpenFile(path); }
    });
    return view;
  }
  function update(el, item) {
    const view = views.get(el) || create(el, item); view.item = item;
    const questionKey = JSON.stringify([item.questions, item.questionState]);
    if (view.questionKey !== questionKey) {
      view.questionKey = questionKey; view.questions.replaceChildren(); view.questions.hidden = !item.questions?.length;
      if (item.questions?.length) {
        const label = doc.createElement('strong'); label.textContent = item.questionState === 'resolved' ? '补充问题 · 已处理' : item.questionState === 'past' ? '此前的补充问题' : '补充问题'; view.questions.append(label);
        for (const question of item.questions) { const p = doc.createElement('p'); p.textContent = question.question; view.questions.append(p); }
      }
    }
    if (view.visibleText !== item.text) flush(view);
  }
  const release = () => { for (const view of pending) { if (!view.el.isConnected) pending.delete(view); else flush(view); } };
  doc.addEventListener('selectionchange', release); doc.addEventListener('focusout', release);
  const observer = doc.defaultView?.MutationObserver ? new doc.defaultView.MutationObserver(() => {
    for (const view of chartViews) if (!view.el.isConnected) clearCharts(view);
    for (const view of diagramViews) if (!view.el.isConnected) clearDiagrams(view);
  }) : null;
  observer?.observe(doc.body, { childList: true, subtree: true });
  return { update, dispose() { disposed = true; observer?.disconnect(); for (const view of chartViews) clearCharts(view); for (const view of diagramViews) clearDiagrams(view); pending.clear(); doc.removeEventListener('selectionchange', release); doc.removeEventListener('focusout', release); } };
}
