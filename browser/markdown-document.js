import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import katexPlugin from '@vscode/markdown-it-katex';
import hljs from 'highlight.js/lib/common';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const escape = md.utils.escapeHtml;
md.use(footnote).use(katexPlugin.default || katexPlugin, { output: 'mathml', trust: false, throwOnError: false, maxExpand: 1000, maxSize: 20, enableFencedBlocks: true });
const mathFence = md.renderer.rules.fence;
const codeBlock = (code, language = '') => {
  let html = escape(code);
  if (code.length <= 100000 && hljs.getLanguage(language)) {
    try { html = hljs.highlight(code, { language, ignoreIllegals: true }).value; } catch { /* readable source remains available */ }
  }
  return `<div class="markdown-code"><div class="markdown-code-tools"><span>${escape(language || 'text')}</span><button type="button" data-markdown-copy>复制代码</button></div><pre><code>${html}</code></pre></div>`;
};
md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const token = tokens[index], language = token.info.trim().split(/\s+/)[0].toLowerCase(), code = token.content.replace(/\n$/, '');
  if (language === 'math') return mathFence(tokens, index, options, env, renderer);
  if (language !== 'mermaid') return codeBlock(code, language);
  return `<figure class="markdown-diagram" data-markdown-diagram><div class="markdown-diagram-tools"><span>Mermaid</span><button type="button" data-diagram-action="out" aria-label="缩小图表">−</button><button type="button" data-diagram-action="fit">适应宽度</button><button type="button" data-diagram-action="in" aria-label="放大图表">＋</button><button type="button" data-diagram-action="expand">放大查看</button><button type="button" data-diagram-action="download" disabled>下载 SVG</button></div><div class="markdown-diagram-canvas" aria-label="Mermaid 图表"><p role="status">正在渲染图表…</p></div><details class="markdown-diagram-source"><summary>图表源码</summary>${codeBlock(code, 'mermaid')}</details></figure>`;
};
md.renderer.rules.code_block = (tokens, index) => codeBlock(tokens[index].content.replace(/\n$/, ''));
md.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';
// Alignment is a class: the main application retains its strict style CSP.
for (const name of ['th_open', 'td_open']) md.renderer.rules[name] = (tokens, index, options, env, renderer) => {
  const token = tokens[index], style = token.attrGet('style');
  if (style) { token.attrs = token.attrs.filter(([key]) => key !== 'style'); token.attrJoin('class', `markdown-align-${style.split(':')[1]}`); }
  return renderer.renderToken(tokens, index, options);
};
md.renderer.rules.link_open = (tokens, index) => {
  const token = tokens[index], target = token.attrGet('href') || '', title = token.attrGet('title');
  const extra = title ? ` title="${escape(title)}"` : '';
  if (/^(https?:\/\/|mailto:)/i.test(target)) { token.meta = 'external'; return `<a href="${escape(target)}" target="_blank" rel="noopener noreferrer"${extra}>`; }
  token.meta = 'local';
  return `<button type="button" class="project-link" ${target.startsWith('#') ? 'data-markdown-anchor' : 'data-file-link'}="${escape(target.startsWith('#') ? target.slice(1) : target)}"${extra}>`;
};
md.renderer.rules.link_close = (tokens, index) => {
  for (let i = index - 1; i >= 0; i--) if (tokens[i].type === 'link_open') return tokens[i].meta === 'external' ? '</a>' : '</button>';
  return '';
};
md.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index], target = token.attrGet('src') || '', label = renderer.renderInlineAsText(token.children || [], options, env);
  return `<span class="markdown-image" data-markdown-image="${escape(target)}" data-image-alt="${escape(label)}"><span role="status">图片：${escape(label || target)}</span></span>`;
};
md.renderer.rules.footnote_ref = (tokens, index) => {
  const { id, subId = 0 } = tokens[index].meta;
  return `<sup data-markdown-heading="fnref-${id}-${subId}" tabindex="-1"><button type="button" class="project-link" data-markdown-anchor="fn-${id}">[${id + 1}]</button></sup>`;
};
md.renderer.rules.footnote_open = (tokens, index) => `<li data-markdown-heading="fn-${tokens[index].meta.id}" tabindex="-1">`;
md.renderer.rules.footnote_anchor = (tokens, index) => `<button type="button" class="project-link" data-markdown-anchor="fnref-${tokens[index].meta.id}-${tokens[index].meta.subId || 0}" aria-label="返回正文">↩</button>`;
md.core.ruler.after('inline', 'document_features', state => {
  const headings = [], anchors = new Set();
  for (let index = 0; index < state.tokens.length; index++) {
    const token = state.tokens[index];
    if (token.type === 'heading_open') {
      const text = (state.tokens[index + 1].children || []).filter(t => !['html_inline', 'footnote_ref'].includes(t.type)).map(t => t.content).join('');
      const slug = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
      let anchor = slug, suffix = 0; while (anchors.has(anchor)) anchor = `${slug}-${++suffix}`; anchors.add(anchor);
      token.attrSet('data-markdown-heading', anchor); token.attrSet('tabindex', '-1');
      headings.push({ text, anchor, level: Number(token.tag.slice(1)) });
    }
    if (token.type === 'inline' && state.tokens[index - 1]?.type === 'paragraph_open' && state.tokens[index - 2]?.type === 'list_item_open' && /^\[[ xX]\]\s/.test(token.content)) {
      const first = token.children[0]; if (first?.type !== 'text') continue;
      const checked = /^\[[xX]\]/.test(first.content); first.content = first.content.replace(/^\[[ xX]\]\s/, '');
      const checkbox = new state.Token('html_inline', '', 0); checkbox.content = `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? '已完成' : '未完成'}">`;
      token.children.unshift(checkbox); state.tokens[index - 2].attrJoin('class', 'markdown-task');
    }
    if (token.type === 'inline' && state.tokens[index - 2]?.type === 'blockquote_open') {
      const alert = token.children[0]?.content.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:$|\s)/);
      if (alert) { state.tokens[index - 2].attrJoin('class', `markdown-alert markdown-alert-${alert[1].toLowerCase()}`); token.children[0].content = token.children[0].content.replace(alert[0], `${({ NOTE: '说明', TIP: '提示', IMPORTANT: '重要', WARNING: '注意', CAUTION: '警告' })[alert[1]]} `); }
    }
  }
  state.env.headings = headings;
});

export function documentMarkdown(text) {
  const env = {}, html = md.render(String(text || ''), env);
  const toc = (env.headings || []).map(h => `<li class="markdown-outline-level-${h.level}"><button type="button" class="project-link" data-markdown-anchor="${escape(h.anchor)}">${escape(h.text)}</button></li>`).join('');
  const outline = `<details class="markdown-outline"><summary>文档目录</summary><nav aria-label="文档目录"><ul>${toc}</ul></nav></details>`;
  if (/<p>\[toc\]<\/p>/i.test(html)) return html.replace(/<p>\[toc\]<\/p>/gi, outline);
  return (env.headings.length >= 3 ? outline : '') + html;
}
