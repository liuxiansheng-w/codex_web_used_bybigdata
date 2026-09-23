import { highlightCode } from './code-highlight.js';
import { documentMarkdown } from './vendor/markdown/document.js';
// Raw HTML stays inert. Project links are buttons resolved against the active root.
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Copy the displayed cells, never message prose or interactive link markup.
export function tableClipboard(table) {
  const rows = [...table.rows].map(row => [...row.cells].map(cell => {
    const clone = cell.cloneNode(true); for (const br of clone.querySelectorAll('br')) br.replaceWith('\n');
    let text = clone.textContent.replace(/\r\n?/g, '\n');
    // Keep formula-like prose inert when pasted into spreadsheet applications.
    if (/^\s*[=+@-]/.test(text) && !/^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(text)) text = `'${text}`;
    return { text, tag: cell.tagName.toLowerCase() === 'th' ? 'th' : 'td' };
  }));
  const tsv = text => /[\t\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  return {
    text: rows.map(row => row.map(cell => tsv(cell.text)).join('\t')).join('\n'),
    html: `<table>${rows.map(row => `<tr>${row.map(cell => `<${cell.tag}>${escapeHtml(cell.text).replaceAll('\n', '<br>')}</${cell.tag}>`).join('')}</tr>`).join('')}</table>`,
  };
}

const tableCopyBindings = new WeakMap();
export function bindMarkdownTableCopy(root, { notify = () => {} } = {}) {
  if (tableCopyBindings.has(root)) return tableCopyBindings.get(root);
  const doc = root.ownerDocument || root, win = doc.defaultView, timers = new Set(), resetTimers = new WeakMap();
  let disposed = false;
  const click = async event => {
    const button = event.target.closest?.('[data-copy-markdown-table]');
    if (!button || !root.contains(button) || button.disabled) return;
    const table = button.closest('.markdown-table')?.querySelector('table'); if (!table) return;
    const previousTimer = resetTimers.get(button); if (previousTimer) { win.clearTimeout(previousTimer); timers.delete(previousTimer); }
    const payload = tableClipboard(table), clipboard = win.navigator.clipboard;
    button.disabled = true;
    try {
      let copied = false;
      if (clipboard?.write && win.ClipboardItem) {
        try {
          await clipboard.write([new win.ClipboardItem({ 'text/html': new win.Blob([payload.html], { type: 'text/html' }), 'text/plain': new win.Blob([payload.text], { type: 'text/plain' }) })]);
          copied = true;
        } catch { /* Text-only clipboard implementations can still paste columns. */ }
      }
      if (!copied) await clipboard.writeText(payload.text);
      if (!disposed) { button.textContent = '已复制'; notify('已复制表格（含表头），可直接粘贴到 Excel。'); }
    } catch {
      if (!disposed) { button.textContent = '复制失败，重试'; notify('剪贴板不可用，请重试或手动选中表格复制。'); }
    } finally {
      if (!disposed) {
        button.disabled = false;
        const timer = win.setTimeout(() => { timers.delete(timer); resetTimers.delete(button); if (button.isConnected) button.textContent = '复制表格'; }, 2200); timers.add(timer); resetTimers.set(button, timer);
      }
    }
  };
  root.addEventListener('click', click);
  const dispose = () => { disposed = true; root.removeEventListener('click', click); for (const timer of timers) win.clearTimeout(timer); timers.clear(); tableCopyBindings.delete(root); };
  tableCopyBindings.set(root, dispose); return dispose;
}

function inline(text, documentMode = false) {
  const tokens = [];
  const save = html => { tokens.push(html); return `\u0000${tokens.length - 1}\u0000`; };
  let s = escapeHtml(text.replace(/\u0000/g, ''));
  s = s.replace(/`([^`]+)`/g, (_, code) => save(`<code>${code}</code>`));
  // HTML is escaped before inline parsing, so angle-delimited Markdown targets
  // contain &lt;/&gt; here. Keep spaces and parentheses inside those targets.
  s = s.replace(/\[([^\]\n]+)\]\((?:&lt;((?:(?!&lt;|&gt;)[^\n])+)&gt;|((?:[^\s()]|\([^\s()]*\))+))\)/g, (original, label, angled, bare) => {
    const target = angled ?? bare;
    if (/\u0000|[\x01-\x1f\x7f]/.test(target)) return original;
    label = label.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)]);
    if (documentMode && target.startsWith('#')) return save(`<button type="button" class="project-link" data-markdown-anchor="${target.slice(1)}">${label}</button>`);
    if (/^https?:\/\//i.test(target)) return save(`<a href="${target}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    const filePath = target.replace(documentMode ? /(?::\d+|#[^#]*)$/ : /(?::\d+|#L\d+)$/, '');
    if (/^[a-zA-Z][\w+.-]*:/.test(filePath) || target.includes('://') || !/\.[a-zA-Z0-9]+$/.test(filePath)) return original;
    return save(`<button type="button" class="project-link" data-file-link="${target}" title="在编辑器中打开：${target}">${label}</button>`);
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)]);
}

export function markdown(text, { document: documentMode = false } = {}) {
  if (documentMode) return documentMarkdown(text);
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const renderInline = text => inline(text, documentMode), anchors = new Set();
  let html = '', paragraph = [], list = null;
  const flush = () => { if (paragraph.length) { html += `<p>${paragraph.map(renderInline).join('<br>')}</p>`; paragraph = []; } };
  const endList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush(); endList(); const code = [];
      const language = line.replace(/^\s*```/, '').trim().toLowerCase();
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      const mode = ['sql', 'hive', 'postgresql'].includes(language) ? 'sql' : ['py', 'python'].includes(language) ? 'python' : 'text';
      html += `<pre><code>${highlightCode(code.join('\n'), mode).html}</code></pre>`; continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}.*\|/.test(lines[i + 1])) {
      flush(); endList();
      const cells = row => row.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim());
      html += `<div class="markdown-table"><div class="markdown-table-tools"><button type="button" class="markdown-table-copy" data-copy-markdown-table title="复制这张表格（含表头），可粘贴到 Excel" aria-live="polite">复制表格</button></div><div class="table-scroll"><table><thead><tr>${cells(line).map(c => `<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>`;
      i += 2;
      for (; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) html += `<tr>${cells(lines[i]).map(c => `<td>${renderInline(c)}</td>`).join('')}</tr>`;
      i--; html += '</tbody></table></div></div>'; continue;
    }
    const heading = line.match(documentMode ? /^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/ : /^(#{1,4})\s+(.+)$/);
    if (heading) {
      flush(); endList(); const n = documentMode ? heading[1].length : Math.min(heading[1].length + 1, 4);
      const slug = heading[2].toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
      let anchor = slug, suffix = 0; while (anchors.has(anchor)) anchor = `${slug}-${++suffix}`; anchors.add(anchor);
      html += `<h${n}${documentMode ? ` data-markdown-heading="${escapeHtml(anchor)}" tabindex="-1"` : ''}>${renderInline(heading[2])}</h${n}>`; continue;
    }
    const bullet = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
    if (bullet) { flush(); const kind = /\d/.test(bullet[1]) ? 'ol' : 'ul'; if (list !== kind) { endList(); list = kind; html += `<${kind}${documentMode && kind === 'ol' ? ` start="${parseInt(bullet[1], 10)}"` : ''}>`; } html += `<li>${renderInline(bullet[2])}</li>`; continue; }
    endList();
    if (!line.trim()) { flush(); continue; }
    if (/^>\s?/.test(line)) { flush(); html += `<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }
    if (/^---+$/.test(line.trim())) { flush(); html += '<hr>'; continue; }
    paragraph.push(line);
  }
  flush(); endList(); return html;
}
