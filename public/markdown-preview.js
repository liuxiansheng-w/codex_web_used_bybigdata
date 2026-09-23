// Rich document interactions are independent of the source textarea and chat.
// Mermaid measures text in a dedicated, network-isolated document. The main
// application keeps its existing strict CSP; only inert SVG images come back.
const renderers = new WeakMap();
export function requestDiagram(source, dark, win = window) {
  let state = renderers.get(win);
  if (!state) {
    const frame = win.document.createElement('iframe'), jobs = new Map();
    frame.className = 'markdown-render-frame'; frame.title = '本机图表渲染'; frame.tabIndex = -1; frame.setAttribute('aria-hidden', 'true');
    frame.src = '/markdown-renderer.html';
    state = { frame, jobs, ready: false, next: 0 };
    win.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.origin !== win.location.origin) return;
      if (event.data?.type === 'lemon-diagram-ready') { state.ready = true; for (const job of jobs.values()) job.send(); return; }
      if (event.data?.type !== 'lemon-diagram') return;
      const job = jobs.get(event.data.id); if (!job) return;
      jobs.delete(event.data.id); win.clearTimeout(job.timer);
      if (event.data.error) job.reject(new Error(event.data.error));
      else if (typeof event.data.svg === 'string' && /^<svg[\s>]/.test(event.data.svg)) job.resolve(event.data.svg);
      else job.reject(new Error('图表未能生成，请重试。'));
    });
    win.document.body.append(frame); renderers.set(win, state);
  }
  return new Promise((resolve, reject) => {
    if (source.length > 100000) { reject(new Error('图表过大，请拆分为多个图表。')); return; }
    const id = String(++state.next), job = { resolve, reject, send: () => state.frame.contentWindow.postMessage({ type: 'lemon-render-diagram', id, source, dark }, win.location.origin) };
    job.timer = win.setTimeout(() => { state.jobs.delete(id); reject(new Error('图表渲染超时，请点击重试。')); }, 45000);
    state.jobs.set(id, job); if (state.ready) job.send();
  });
}

export function enhanceMarkdown(article, { api, entry, resolveLink, diagram = requestDiagram } = {}) {
  const doc = article.ownerDocument, win = doc.defaultView, urls = new Set(), figures = [...article.querySelectorAll('[data-markdown-diagram]')];
  let disposed = false, version = 0, theme, dialog;
  const live = node => !disposed && article.contains(node);
  const element = (tag, cls, text) => { const node = doc.createElement(tag); if (cls) node.className = cls; if (text) node.textContent = text; return node; };
  const button = (label, action) => { const node = element('button', '', label); node.type = 'button'; node.addEventListener('click', action); return node; };
  const blobUrl = blob => { const url = win.URL.createObjectURL(blob); urls.add(url); return url; };
  const release = url => { if (urls.delete(url)) win.URL.revokeObjectURL(url); };
  const owner = () => article.closest('[data-module-theme]') || doc.documentElement;
  const dark = () => (owner().dataset.theme || doc.documentElement.dataset.theme) !== 'light';
  const mirrorTheme = target => { for (const key of ['theme', 'skin', 'appearance', 'moduleTheme']) { const value = owner().dataset[key] || doc.documentElement.dataset[key]; if (value) target.dataset[key] = value; } };
  function imageIn(host, src, alt) {
    const image = element('img'); image.src = src; image.alt = alt; image.decoding = 'async'; image.draggable = false; host.replaceChildren(image); return image;
  }
  function enlarge(src, label) {
    dialog?.close(); dialog?.remove();
    dialog = element('dialog', 'markdown-image-dialog'); mirrorTheme(dialog);
    const toolbar = element('div', 'markdown-dialog-tools'), stage = element('div', 'markdown-dialog-stage'), image = imageIn(stage, src, label);
    let scale = 0;
    const zoom = delta => { scale = Math.max(.25, Math.min(8, (scale || 1) + delta)); image.style.width = `${(image.naturalWidth || 1000) * scale}px`; image.style.maxWidth = 'none'; };
    toolbar.append(element('span', '', label), button('−', () => zoom(-.25)), button('适应窗口', () => { scale = 0; image.style.width = ''; image.style.maxWidth = ''; }), button('＋', () => zoom(.25)), button('关闭', () => dialog.close()));
    dialog.append(toolbar, stage); doc.body.append(dialog);
    const currentDialog = dialog;
    dialog.addEventListener('close', () => { currentDialog.remove(); if (dialog === currentDialog) dialog = null; });
    dialog.addEventListener('click', event => { if (event.target === currentDialog) currentDialog.close(); });
    dialog.showModal();
  }
  async function renderFigure(figure, generation, mode) {
    const canvas = figure.querySelector('.markdown-diagram-canvas'), source = figure.querySelector('pre code').textContent;
    figure.dataset.rendering = 'true';
    try {
      const svg = await diagram(source, mode, win);
      if (!live(figure) || generation !== version) return;
      const url = blobUrl(new win.Blob([svg], { type: 'image/svg+xml' })), oldUrl = figure.dataset.url;
      imageIn(canvas, url, 'Mermaid 图表（可放大查看）'); figure.dataset.url = url; if (oldUrl) release(oldUrl);
      figure.querySelector('[data-diagram-action="download"]').disabled = false;
      const image = canvas.querySelector('img'); image.style.width = '100%';
      figure.dataset.scale = '1'; delete figure.dataset.failed;
    } catch (error) {
      if (!live(figure) || generation !== version) return;
      figure.dataset.failed = 'true';
      canvas.replaceChildren(element('p', 'markdown-render-error', error.message), button('重新渲染', () => void renderFigure(figure, version, dark())));
      figure.querySelector('details').open = true;
    } finally { if (live(figure) && generation === version) delete figure.dataset.rendering; }
  }
  function refresh() {
    if (disposed) return;
    const mode = dark(); if (mode === theme) return;
    theme = mode; const generation = ++version;
    if (dialog) { dialog.close(); }
    for (const figure of figures) void renderFigure(figure, generation, mode);
  }
  async function localImage(host) {
    const target = host.dataset.markdownImage, alt = host.dataset.imageAlt || '文档图片';
    try {
      if (/^https?:\/\//i.test(target)) {
        const link = element('a', 'project-link', `在新标签页查看外部图片：${alt}`); link.href = target; link.target = '_blank'; link.rel = 'noopener noreferrer';
        host.replaceChildren(link); return;
      }
      let src;
      if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=\s]+$/i.test(target) && target.length <= 14_000_000) src = target;
      else {
        const file = resolveLink(target, entry), extension = file.path.match(/\.(png|jpg|jpeg|gif|webp|svg)$/i)?.[1].toLowerCase();
        if (!extension) throw new Error('图片格式暂不支持。');
        const result = await api(`/api/project/artifact?${new URLSearchParams({ cwd: file.cwd, path: file.path })}`);
        if (!live(host)) return;
        const bytes = Uint8Array.from(win.atob(result.base64), char => char.charCodeAt(0));
        // SVG in an image has no script, navigation or external resource access.
        src = blobUrl(new win.Blob([bytes], { type: `image/${extension === 'jpg' ? 'jpeg' : extension === 'svg' ? 'svg+xml' : extension}` }));
      }
      if (!live(host)) return;
      const image = imageIn(host, src, alt); image.loading = 'lazy'; image.tabIndex = 0; image.setAttribute('role', 'button'); image.title = '点击放大图片';
      image.addEventListener('click', () => enlarge(src, alt));
      image.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); enlarge(src, alt); } });
      image.addEventListener('error', () => { if (live(host)) host.replaceChildren(element('span', 'markdown-render-error', `图片无法显示：${alt}`)); });
    } catch (error) { if (live(host)) host.replaceChildren(element('span', 'markdown-render-error', `图片无法显示：${error.message}`)); }
  }
  async function click(event) {
    const copy = event.target.closest('[data-markdown-copy]');
    if (copy && article.contains(copy)) {
      try { await win.navigator.clipboard.writeText(copy.closest('.markdown-code').querySelector('code').textContent); if (live(copy)) copy.textContent = '已复制'; }
      catch { if (live(copy)) copy.textContent = '请选中代码复制'; } return;
    }
    const action = event.target.closest('[data-diagram-action]'); if (!action || !article.contains(action)) return;
    const figure = action.closest('[data-markdown-diagram]'), url = figure.dataset.url, image = figure.querySelector('.markdown-diagram-canvas img');
    if (!url || !image) return;
    if (action.dataset.diagramAction === 'expand') { enlarge(url, 'Mermaid 图表'); return; }
    if (action.dataset.diagramAction === 'download') { const link = element('a'); link.href = url; link.download = `${entry?.path?.split('/').pop()?.replace(/\.[^.]+$/, '') || 'diagram'}-${figures.indexOf(figure) + 1}.svg`; link.click(); return; }
    const scale = action.dataset.diagramAction === 'fit' ? 1 : Math.max(.25, Math.min(8, Number(figure.dataset.scale || 1) + (action.dataset.diagramAction === 'in' ? .25 : -.25)));
    figure.dataset.scale = String(scale); image.style.width = `${scale * 100}%`;
  }
  article.addEventListener('click', click);
  const observer = new win.MutationObserver(() => refresh());
  observer.observe(doc.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-theme', 'data-module-theme'] });
  refresh();
  for (const host of article.querySelectorAll('[data-markdown-image]')) void localImage(host);
  return { refresh, dispose() { disposed = true; version++; observer.disconnect(); article.removeEventListener('click', click); dialog?.close(); dialog?.remove(); for (const url of [...urls]) release(url); } };
}
