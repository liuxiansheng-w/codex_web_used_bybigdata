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

// Native message directives are data, never HTML or executable instructions.
// Parse the quoted attributes before Markdown so backticks/braces in values
// cannot escape into a second interactive element.
function messageDirective(text, start) {
  const head = text.slice(start).match(/^:{1,2}codex-(file-citation|followup)(?:\[([^\]\n]{1,240})\])?\{/);
  if (!head || /[:\\]/.test(text[start - 1] || '')) return null;
  const from = start + head[0].length; let end = from, quoted = false, escaped = false;
  for (; end < Math.min(text.length, from + 16000); end++) {
    const char = text[end];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    else if (char === '}' && !quoted) break;
  }
  if (quoted || text[end] !== '}') return null;
  const body = text.slice(from, end), attrs = Object.create(null), field = /\s*([a-zA-Z_][\w-]*)\s*=\s*("(?:[^"\\]|\\.)*")/y;
  let offset = 0;
  while (offset < body.length) {
    if (!body.slice(offset).trim()) break;
    field.lastIndex = offset; const match = field.exec(body);
    if (!match || Object.hasOwn(attrs, match[1])) return null;
    try { attrs[match[1]] = JSON.parse(match[2]); } catch { return null; }
    offset = field.lastIndex;
    if (offset < body.length && !/\s/.test(body[offset])) return null;
  }
  let html;
  if (head[1] === 'followup') {
    const prompt = attrs.prompt;
    if (!head[2]?.trim() || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) return null;
    html = `<button type="button" class="message-followup" data-followup-prompt="${escapeHtml(prompt)}" title="填入输入框，确认后发送">${escapeHtml(head[2])}<span aria-hidden="true">↗</span></button>`;
  } else {
    const path = attrs.path;
    if (typeof path !== 'string' || !path || path.length >= 4096 || /[\x00-\x1f\x7f\\]/.test(path) || /^[a-zA-Z][\w+.-]*:/.test(path) || path.startsWith('//') || path.includes('://')) return null;
    const relative = path.replace(/^(?:\/|\.\/)/, '');
    if (relative.split('/').some(part => !part || part === '.' || part === '..')) return null;
    const name = head[2] || path.split('/').at(-1), extension = path.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1].toUpperCase() || 'FILE';
    const location = [attrs.sheet, attrs.range].filter(value => typeof value === 'string' && value.length <= 240 && !/[\x00-\x1f\x7f]/.test(value)).join(' · ');
    html = `<button type="button" class="file-citation" data-file-link="${escapeHtml(path)}" title="打开文件：${escapeHtml(path)}"><span class="file-citation-type" aria-hidden="true">${extension}</span><span class="file-citation-info"><span class="file-citation-name">${escapeHtml(name)}</span>${location ? `<span class="file-citation-location">${escapeHtml(location)}</span>` : ''}</span><span class="file-citation-open" aria-hidden="true">打开 ↗</span></button>`;
  }
  return { html, end: end + 1 };
}

function protectedInline(text, save) {
  const source = text.replace(/\u0000/g, ''), marker = /`+|:{1,2}codex-(?:file-citation|followup)/g;
  let result = '', position = 0, match;
  while ((match = marker.exec(source))) {
    result += escapeHtml(source.slice(position, match.index));
    if (match[0][0] === '`') {
      let end = source.indexOf(match[0], marker.lastIndex);
      while (end >= 0 && (source[end - 1] === '`' || source[end + match[0].length] === '`')) end = source.indexOf(match[0], end + 1);
      if (end < 0) return result + escapeHtml(source.slice(match.index));
      result += save(`<code>${escapeHtml(source.slice(marker.lastIndex, end))}</code>`); position = end + match[0].length;
    } else {
      const directive = messageDirective(source, match.index);
      if (directive) { result += save(directive.html); position = directive.end; }
      else { result += escapeHtml(match[0]); position = marker.lastIndex; }
    }
    marker.lastIndex = position;
  }
  return result + escapeHtml(source.slice(position));
}

function inline(text, documentMode = false) {
  const tokens = [];
  const save = html => { tokens.push(html); return `\u0000${tokens.length - 1}\u0000`; };
  let s = protectedInline(text, save);
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
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      flush(); endList(); const code = [];
      const language = fence[2].trim().toLowerCase(), close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (++i < lines.length && !close.test(lines[i])) code.push(lines[i]);
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
