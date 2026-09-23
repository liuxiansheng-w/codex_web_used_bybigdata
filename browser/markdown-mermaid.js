import mermaid from 'mermaid';
import createDOMPurify from 'dompurify';

const purifier = createDOMPurify(window);
export function cleanSvg(svg) {
  const clean = purifier.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['foreignObject', 'image', 'a', 'script', 'animate', 'set'] });
  const doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
  for (const node of doc.querySelectorAll('*')) for (const attr of [...node.attributes]) {
    if (/href$/i.test(attr.name) && !attr.value.startsWith('#')) node.removeAttribute(attr.name);
  }
  // Diagram authors cannot introduce CSS imports or network URLs in SVG styles.
  for (const style of doc.querySelectorAll('style')) style.textContent = style.textContent.replace(/@import[^;]+;?/gi, '').replace(/url\(([^)]*)\)/gi, (match, target) => target.trim().replace(/^['"]|['"]$/g, '').startsWith('#') ? match : 'none');
  return new XMLSerializer().serializeToString(doc.documentElement);
}
let sequence = 0;
export async function renderDiagram(source, dark) {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: dark ? 'dark' : 'default', htmlLabels: false, fontFamily: 'system-ui, sans-serif', flowchart: { htmlLabels: false }, maxTextSize: 100000, maxEdges: 2000, secure: [...Object.keys(mermaid.mermaidAPI.defaultConfig), 'secure'] });
  const container = document.createElement('div'); document.body.append(container);
  try { const result = await mermaid.render(`lemon-diagram-${++sequence}`, source, container); return cleanSvg(result.svg); }
  finally { container.remove(); }
}
