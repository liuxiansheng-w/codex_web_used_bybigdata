import { markdown } from './markdown.js';

// Preserve the rendered message nodes and selections: search uses DOM Ranges,
// not inserted markup that would interfere with streaming Markdown updates.
function segments(root, doc) {
  const groups = []; let text = '', nodes = [];
  const flush = () => { if (text) groups.push({ text, nodes }); text = ''; nodes = []; };
  const blocks = new Set(['P', 'PRE', 'DIV', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);
  function walk(node, top = false) {
    if (node.nodeType === 3) { if (node.data) { nodes.push({ node, start: text.length, end: text.length + node.data.length }); text += node.data; } return; }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    if (node.nodeType === 1 && (node.matches('button, script, style, svg, [hidden]') || node.tagName === 'DETAILS' && !node.open)) return;
    if (node.nodeType === 1 && node.tagName === 'BR') { flush(); return; }
    const block = !top && blocks.has(node.tagName);
    if (block) flush();
    for (const child of node.childNodes) walk(child);
    if (block) flush();
  }
  walk(root, true); flush(); return groups;
}

function* findOffsets(text, query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of text.matchAll(new RegExp(escaped, 'giu'))) yield [match.index, match.index + match[0].length];
}

function toRange(doc, segment, from, to) {
  const first = segment.nodes.find(entry => entry.start <= from && entry.end > from);
  const last = segment.nodes.find(entry => entry.start < to && entry.end >= to);
  if (!first || !last) return null;
  const range = doc.createRange(); range.setStart(first.node, from - first.start); range.setEnd(last.node, to - last.start); return range;
}

export function createChatFind({ document: doc = document, getThread, elementFor, ensureVisible, userText }) {
  const win = doc.defaultView, heading = doc.querySelector('.conversation-heading'), area = doc.getElementById('scrollArea');
  const trigger = doc.createElement('button'); trigger.type = 'button'; trigger.className = 'icon-button chat-find-trigger';
  trigger.title = '在当前聊天中查找 · ⌘ / Ctrl + F'; trigger.setAttribute('aria-label', '在当前聊天中查找');
  trigger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>';
  heading.insertBefore(trigger, doc.getElementById('chatSearchButton'));
  const bar = doc.createElement('form'); bar.className = 'chat-find'; bar.hidden = true; bar.setAttribute('role', 'search'); bar.setAttribute('aria-label', '查找当前聊天');
  bar.innerHTML = '<input type="search" maxlength="500" placeholder="查找当前聊天…" aria-label="查找当前聊天"><span class="chat-find-count" role="status"></span><button type="button" data-previous aria-label="上一个匹配">↑</button><button type="submit" aria-label="下一个匹配">↓</button><button type="button" data-close aria-label="关闭聊天查找">×</button>';
  area.before(bar);
  const input = bar.querySelector('input'), count = bar.querySelector('.chat-find-count');
  let results = [], current = 0, generation = 0, threadId = null, timer, truncated = false, scanning = false, rescan = false, pendingNavigate = false;
  const cache = new Map();
  const clearHighlights = () => { win.CSS?.highlights?.delete('lemon-chat-find'); win.CSS?.highlights?.delete('lemon-chat-find-current'); };
  const bodyFor = item => {
    const el = elementFor(item.id);
    return item.type === 'userMessage' ? el?.children[1] : el?.querySelector('.message-body');
  };
  function detached(item) {
    const source = item.type === 'userMessage' ? userText(item) : String(item.text || '');
    const key = item.id, previous = cache.get(key);
    if (previous?.source === source && previous.type === item.type) return previous.texts;
    const root = doc.createElement('div');
    if (item.type === 'userMessage') root.textContent = source;
    else root.innerHTML = markdown(source, { charts: true, diagrams: true });
    const texts = segments(root, doc).map(group => group.text);
    cache.set(key, { source, type: item.type, texts });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return texts;
  }
  function rangesForCurrentDOM() {
    const all = [], active = [];
    results.forEach((match, index) => {
      const item = getThread()?.items?.[match.itemIndex], body = item && bodyFor(item);
      if (!body) return;
      const group = segments(body, doc)[match.segment], range = group && toRange(doc, group, match.from, match.to);
      if (range) { all.push(range); if (index === current) active.push(range); }
    });
    if (win.CSS?.highlights && win.Highlight) {
      win.CSS.highlights.set('lemon-chat-find', new win.Highlight(...all));
      win.CSS.highlights.set('lemon-chat-find-current', new win.Highlight(...active));
    }
    return active[0];
  }
  function updateCount() {
    count.textContent = input.value ? results.length ? `${current + 1} / ${truncated ? '≥' : ''}${results.length}` : '无匹配' : '';
  }
  function go(index) {
    if (!results.length) { updateCount(); return; }
    current = (index + results.length) % results.length; updateCount();
    const match = results[current]; ensureVisible(match.itemIndex);
    win.requestAnimationFrame(() => {
      const range = rangesForCurrentDOM(), target = range?.startContainer?.parentElement || bodyFor(getThread()?.items?.[match.itemIndex] || {});
      for (let parent = target?.parentElement; parent && parent !== area; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
      if (range?.getBoundingClientRect && area.getBoundingClientRect) {
        const rect = range.getBoundingClientRect(), viewport = area.getBoundingClientRect();
        if (rect.height || rect.width) area.scrollTop += rect.top - viewport.top - viewport.height / 2 + rect.height / 2;
        else target?.scrollIntoView?.({ block: 'center' });
      } else target?.scrollIntoView?.({ block: 'center' });
      input.focus({ preventScroll: true });
    });
  }
  async function scan({ navigate = false } = {}) {
    const at = ++generation, thread = getThread(), query = input.value;
    if (!thread || !query.trim()) { results = []; current = 0; truncated = false; clearHighlights(); updateCount(); return; }
    count.textContent = '正在查找…';
    const old = results[current], matches = [];
    for (let i = 0; i < thread.items.length; i++) {
      const item = thread.items[i];
      if (!['userMessage', 'agentMessage', 'plan'].includes(item.type)) continue;
      const body = bodyFor(item), texts = body ? segments(body, doc).map(group => group.text) : detached(item);
      for (let part = 0; part < texts.length; part++) {
        for (const [from, to] of findOffsets(texts[part], query)) {
          matches.push({ id: item.id, itemIndex: i, segment: part, from, to });
          if (matches.length >= 10000) break;
        }
        if (matches.length >= 10000) break;
      }
      if (matches.length >= 10000) break;
      if (i && i % 60 === 0) { await new Promise(resolve => win.setTimeout(resolve, 0)); if (at !== generation) return; }
    }
    if (at !== generation || getThread()?.id !== thread.id) return;
    results = matches; truncated = matches.length >= 10000;
    const preserved = old && results.findIndex(match => match.id === old.id && match.segment === old.segment && match.from === old.from);
    current = preserved >= 0 ? preserved : 0; updateCount(); rangesForCurrentDOM(); if (navigate && results.length) go(current);
  }
  function schedule(navigate = false) {
    if (navigate) { generation++; pendingNavigate = true; win.clearTimeout(timer); timer = null; }
    if (scanning) { rescan = true; return; }
    if (timer) return;
    timer = win.setTimeout(async () => {
      timer = null; scanning = true;
      const move = pendingNavigate; pendingNavigate = false;
      try { await scan({ navigate: move }); }
      finally { scanning = false; if (rescan) { rescan = false; schedule(); } }
    }, navigate ? 90 : 200);
  }
  function open() { if (!getThread()) return; bar.hidden = false; trigger.setAttribute('aria-expanded', 'true'); input.focus(); input.select(); schedule(); }
  function close() { generation++; win.clearTimeout(timer); timer = null; rescan = false; pendingNavigate = false; bar.hidden = true; trigger.setAttribute('aria-expanded', 'false'); clearHighlights(); trigger.focus(); }
  trigger.addEventListener('click', () => bar.hidden ? open() : close());
  input.addEventListener('input', () => schedule(true));
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); go(current - 1); }
  });
  bar.addEventListener('submit', event => { event.preventDefault(); if (!event.isComposing) go(current + 1); });
  bar.querySelector('[data-previous]').addEventListener('click', () => go(current - 1));
  bar.querySelector('[data-close]').addEventListener('click', close);
  doc.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f' || doc.querySelector('dialog[open]')) return;
    if (!doc.getElementById('mainPanel').contains(event.target) || doc.getElementById('mainPanel').dataset.chatView === 'history' || !getThread()) return;
    event.preventDefault(); event.stopPropagation(); open();
  }, true);
  return { update() {
    const next = getThread()?.id || null;
    if (threadId !== next) { threadId = next; generation++; win.clearTimeout(timer); timer = null; rescan = false; pendingNavigate = false; cache.clear(); results = []; current = 0; input.value = ''; clearHighlights(); updateCount(); }
    if (!bar.hidden) schedule();
  }, open, close };
}
