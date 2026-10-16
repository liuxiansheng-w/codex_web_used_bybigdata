import { markdown } from './markdown.js';
// Project files for the on-demand changes and artifacts panels.
export function projectPath(value, cwd) {
  if (typeof value !== 'string' || !cwd) return null;
  let path = value.replace(/^(?:<)|(?:>)$/g, '').replace(/(?::\d+|#L\d+)$/, '');
  if (path.startsWith(cwd.replace(/\/$/, '') + '/')) path = path.slice(cwd.replace(/\/$/, '').length + 1);
  if (!path || path.startsWith('/') || /^[a-z][\w+.-]*:/i.test(path) || path.includes('\\') || path.split('/').some(p => !p || p === '..' || p.startsWith('.'))) return null;
  return path;
}

export function taskResult(thread) {
  const all = thread?.items || [];
  const latest = thread?.latestTurnId;
  const lastUser = all.map(item => item.type).lastIndexOf('userMessage');
  const items = latest && all.some(item => item.turnId) ? all.filter(item => item.turnId === latest) : all.slice(Math.max(0, lastUser));
  const changes = [], artifacts = new Map();
  for (const item of items) {
    if (item.type === 'fileChange') for (const change of item.changes || []) {
      const path = projectPath(change.path, thread.cwd);
      if (path) { changes.push({ ...change, path, itemId: item.id, status: item.status }); if (item.status === 'completed' && change.kind !== 'delete') artifacts.set(path, { path, source: '文件变更记录' }); }
    }
    if (item.type === 'agentMessage') for (const match of (item.text || '').matchAll(/\[[^\]]+\]\((?:<([^>]+)>|([^\s)]+))\)/g)) {
      const path = projectPath(match[1] || match[2], thread.cwd);
      if (path) artifacts.set(path, { path, source: '回复中提及，打开时核对文件' });
    }
  }
  return { changes, artifacts: [...artifacts.values()].slice(0, 50) };
}

function diffCounts(diff) {
  let added = 0, removed = 0, hunk = false, known = false;
  for (const line of String(diff || '').split('\n')) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) { hunk = known = true; continue; }
    if (/^(diff --git |\*\*\* )/.test(line)) { hunk = false; continue; }
    if (hunk && line.startsWith('+')) added++;
    if (hunk && line.startsWith('-')) removed++;
  }
  return { added, removed, known };
}

// Only confirmed changes from this turn, never the whole dirty Git workspace.
export function completedChangeSummaries(thread) {
  const turns = new Map(); let key = 'history';
  for (const item of thread?.items || []) {
    key = item.turnId || (item.type === 'userMessage' ? item.id : key);
    if (!turns.has(key)) turns.set(key, { key, cwd: thread.cwd, itemIds: [], changes: [], files: new Map(), seen: new Set() });
    const turn = turns.get(key); turn.itemIds.push(item.id);
    if (item.type !== 'fileChange' || item.status !== 'completed' || turn.seen.has(item.id)) continue;
    turn.seen.add(item.id);
    for (const raw of item.changes || []) {
      const path = projectPath(raw.path, thread.cwd); if (!path) continue;
      const movePath = raw.movePath ? projectPath(raw.movePath, thread.cwd) : null;
      if (raw.movePath && !movePath) continue;
      const change = { ...raw, path, ...(movePath ? { movePath } : {}), itemId: item.id, status: item.status };
      const destination = movePath || path, file = turn.files.get(path) || turn.files.get(destination) || { path: destination, originalPath: path, added: 0, removed: 0, known: true, edits: 0 };
      if (movePath) turn.files.delete(path);
      Object.assign(file, { path: destination, kind: raw.kind || 'update' });
      const counts = diffCounts(raw.diff); file.added += counts.added; file.removed += counts.removed; file.known &&= counts.known; file.edits++;
      turn.files.set(destination, file); turn.changes.push(change);
    }
  }
  const latest = [...turns.keys()].at(-1);
  return [...turns.values()].filter(turn => {
    if (thread.busy && turn.key === (thread.turnId || latest)) return false;
    const status = thread.turnTimings?.find(timing => timing.id === turn.key)?.status || (turn.key === thread.latestTurnId || (!thread.latestTurnId && turn.key === latest) ? thread.completion : null);
    return ['completed', 'interrupted', 'failed'].includes(status) && turn.files.size;
  }).map(({ seen, ...turn }) => ({ ...turn, files: [...turn.files.values()] }));
}

export function createChangeSummary({ onOpen, onReview, onError = () => {} }) {
  const node = (tag, cls, parent) => { const el = document.createElement(tag); el.className = cls; parent?.append(el); return el; };
  const el = node('section', 'change-summary'), header = node('header', 'change-summary-heading', el);
  const heading = node('div', 'change-summary-heading-text', header), title = node('strong', '', heading), total = node('span', 'change-counts', heading);
  const review = node('button', 'text-button change-summary-review', header); review.type = 'button'; review.textContent = '审查'; review.title = '查看本轮差异，可预览并撤销单次改动';
  const list = node('ul', 'change-summary-files', el), hint = node('p', 'change-summary-hint', el), feedback = node('p', 'change-summary-feedback', el); feedback.hidden = true; feedback.setAttribute('role', 'status');
  const rows = new Map(); let current, signature;
  const setText = (target, text) => { if (target.textContent !== text) target.textContent = text; };
  function setCounts(target, known, added, removed, unknown) {
    if (!known) { setText(target, unknown); return; }
    if (!target.querySelector('.change-count-added')) { target.replaceChildren(node('span', 'change-count-added'), document.createTextNode(' '), node('span', 'change-count-removed')); }
    setText(target.firstElementChild, `+${added}`); setText(target.lastElementChild, `−${removed}`);
  }
  async function act(button, fn) {
    button.disabled = true; feedback.hidden = true;
    try { await fn(); } catch (error) { feedback.textContent = error.message; feedback.hidden = false; onError(error.message); }
    finally { button.disabled = false; }
  }
  review.addEventListener('click', () => act(review, () => onReview(current)));
  function update(summary) {
    current = summary; const next = JSON.stringify(summary); if (next === signature) return; signature = next;
    el.dataset.turnId = summary.key; el.setAttribute('aria-label', '本轮文件修改');
    setText(title, `已编辑 ${summary.files.length} 个文件`);
    const known = summary.files.every(file => file.known);
    setCounts(total, known, summary.files.reduce((n, file) => n + file.added, 0), summary.files.reduce((n, file) => n + file.removed, 0), '部分行数未提供');
    total.title = '本轮各次修改的累计增删行数';
    const paths = new Set(summary.files.map(file => file.path));
    for (const [path, row] of rows) if (!paths.has(path)) { row.el.remove(); rows.delete(path); }
    let cursor = list.firstChild;
    for (const file of summary.files) {
      let row = rows.get(file.path);
      if (!row) {
        const item = node('li', 'change-summary-file'), open = node('button', 'text-button change-summary-path', item), kind = node('span', 'change-summary-kind', item), counts = node('span', 'change-counts', item);
        open.type = 'button'; row = { el: item, open, kind, counts, file }; rows.set(file.path, row);
        open.addEventListener('click', () => act(open, () => row.file.kind === 'delete' ? onReview({ ...current, changes: current.changes.filter(change => change.path === row.file.path || change.movePath === row.file.path) }) : onOpen(row.file, current)));
      }
      row.file = file;
      setText(row.open, file.path); row.open.title = file.originalPath !== file.path ? `${file.originalPath} → ${file.path}` : file.path;
      setText(row.kind, file.kind === 'delete' ? '已删除' : file.originalPath !== file.path ? '已重命名' : file.kind === 'add' ? '新增' : '');
      setCounts(row.counts, file.known, file.added, file.removed, '行数未提供');
      row.counts.title = '本轮各次修改的累计增删行数';
      if (row.el !== cursor) list.insertBefore(row.el, cursor); cursor = row.el.nextSibling;
    }
    setText(hint, '本轮已确认的文件修改 · 增删行数按各次修改累计');
  }
  return { el, update };
}

export const agentLabels = { pendingInit: '准备中', running: '运行中', waiting: '需要确认', completed: '已完成', interrupted: '已停止', errored: '执行失败', shutdown: '已关闭', notFound: '不可用', unknown: '未同步' };
export const isAgentItem = item => ['collabAgentToolCall', 'subAgentActivity'].includes(item.type);
export function agentSummary(agents) {
  const counts = new Map(); for (const agent of agents) { const label = agentLabels[agent.status] || '未同步'; counts.set(label, (counts.get(label) || 0) + 1); }
  return [...counts].map(([label, count]) => `${count} ${label}`).join(' · ');
}
// One readable group per parent turn. Repeated wait/send/activity records update
// that group; they do not become another empty tool card in the transcript.
export function subtaskGroups(thread) {
  const groups = new Map(), owners = new Map(), known = new Map(); let fallbackTurn = 'history';
  for (const item of thread?.items || []) {
    if (item.type === 'userMessage') fallbackTurn = item.id;
    if (!isAgentItem(item)) continue;
    const ids = (item.type === 'subAgentActivity' ? [item.agentThreadId] : item.receiverThreadIds || []).filter(id => id && id !== thread.id);
    if (!ids.length) continue; // Keep failed/unassigned calls visible in the original transcript.
    const key = item.turnId || fallbackTurn;
    if (!groups.has(key)) groups.set(key, { key, anchor: item.id, itemIds: [], agents: new Map() });
    const group = groups.get(key); group.itemIds.push(item.id);
    for (const id of ids) {
      const old = group.agents.get(id) || known.get(id) || { id, name: '子任务', status: 'pendingInit', message: '', prompt: '', canStop: false };
      const state = item.agentsStates?.[id], agent = { ...old };
      if (item.tool === 'spawnAgent' || item.tool === 'followupTask' || item.tool === 'sendInput') { agent.prompt = item.prompt || agent.prompt; if (!state?.message) agent.message = ''; }
      if (state) { agent.status = state.status || 'unknown'; if (state.message) agent.message = state.message; }
      if (item.type === 'subAgentActivity') { agent.name = item.agentPath || agent.name; agent.status = ({ started: 'running', completed: 'completed', interrupted: 'interrupted' })[item.kind] || agent.status; }
      group.agents.set(id, agent); known.set(id, agent); owners.set(id, key);
    }
  }
  return [...groups.values()].map(group => ({ ...group, agents: [...group.agents.values()].map(agent => ({ ...agent, live: owners.get(agent.id) === group.key })) })).filter(group => group.agents.length);
}

// Shared by the conversation and the optional overview. Nodes are keyed by
// agent ID so a status refresh keeps selection, focus and reading position.
export function createAgentCards(container, { onOpen, onStop, onFile = () => {} }) {
  const cards = new Map();
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
  const action = (label, fn) => { const el = node('button', label, 'text-button'); el.type = 'button'; el.addEventListener('click', fn); return el; };
  function create(id) {
    const el = node('section', '', 'agent-card'), head = node('header', '', 'agent-heading'), name = node('strong'), badge = node('span', '', 'agent-state'), prompt = node('p', '', 'agent-assignment');
    const activity = node('p', '', 'agent-activity'), output = node('div', '', 'agent-output'), hint = node('p', '', 'agent-hint'), feedback = node('p', '', 'agent-feedback'); feedback.setAttribute('role', 'status');
    const actions = node('footer', '', 'agent-actions');
    const card = { el, name, badge, prompt, activity, output, hint, feedback, agent: null, lastMessage: null, pending: false, stopping: false };
    const open = action('完整会话', async () => { if (card.pending) return; card.pending = true; open.disabled = true; try { await onOpen(card.agent.id); } catch (error) { feedback.textContent = error.message; } finally { card.pending = false; open.disabled = false; } });
    const stop = action('停止', async () => {
      if (card.stopping) return; card.stopping = true; stop.disabled = true; stop.textContent = '正在停止…';
      try { await onStop(card.agent.id); if (card.stopping) feedback.textContent = '停止请求已发送，等待状态更新。'; }
      catch (error) { card.stopping = false; stop.textContent = '停止'; stop.disabled = !card.agent.canStop; feedback.textContent = error.message; }
    });
    stop.classList.add('agent-stop'); stop.setAttribute('aria-label', '停止子任务');
    head.append(name, badge); actions.append(open, stop); el.append(head, prompt, activity, output, hint, feedback, actions); el.dataset.agentId = id;
    Object.assign(card, { open, stop });
    output.addEventListener('click', event => { const link = event.target.closest?.('[data-file-link]'); if (link) onFile(link.dataset.fileLink, card.agent); });
    return card;
  }
  function update(agents) {
    const ids = new Set(agents.map(agent => agent.id));
    for (const [id, card] of cards) if (!ids.has(id)) { card.el.remove(); cards.delete(id); }
    for (const [index, agent] of agents.entries()) {
      let card = cards.get(agent.id); if (!card) { card = create(agent.id); cards.set(agent.id, card); container.append(card.el); }
      // Preserve order without moving an unchanged, focused card on every poll.
      if (container.children[index] !== card.el) container.insertBefore(card.el, container.children[index] || null);
      card.agent = agent; card.name.textContent = agent.name || '子任务'; card.badge.textContent = agentLabels[agent.status] || '未同步'; card.badge.className = `agent-state state-${agent.status}`;
      const prompt = (agent.prompt || '').trim(); card.prompt.textContent = prompt.length > 240 ? `${prompt.slice(0, 240)}…` : prompt; card.prompt.hidden = !prompt;
      const activity = agent.error || (agent.status === 'waiting' ? '等待你的输入或审批，可在完整会话中处理。' : agent.activity || '');
      card.activity.textContent = activity; card.activity.hidden = !activity;
      let message = agent.message || '';
      if (!message) message = ({ pendingInit: '任务已分配，等待开始。', running: '正在处理，回复会自动显示在这里。', waiting: '等待确认后继续。', completed: '任务已结束，没有返回文字结果。', interrupted: '任务已停止，没有新的回复。', errored: '任务未完成。', shutdown: '子任务已关闭。', unknown: '暂时无法读取回复，正在重新同步。' })[agent.status] || '暂无文字回复。';
      const selection = document.getSelection?.();
      if (message !== card.lastMessage && !(selection && !selection.isCollapsed && card.output.contains(selection.anchorNode))) { card.output.innerHTML = markdown(message); card.lastMessage = message; }
      const historical = agent.status === 'unknown' && agent.message ? '以上为上次读取的内容，当前状态待同步。' : '';
      card.hint.textContent = [historical, agent.messageTruncated ? '回复较长，此处显示前 5,000 字符；完整会话保留全部内容。' : ''].filter(Boolean).join(' '); card.hint.hidden = !card.hint.textContent;
      card.stop.hidden = !agent.canStop && !card.stopping;
      if (card.stopping && !['running', 'waiting', 'unknown'].includes(agent.status)) { card.stopping = false; card.stop.hidden = true; card.feedback.textContent = agent.status === 'interrupted' ? '已停止。' : ''; }
      card.stop.disabled = card.stopping || !agent.canStop; card.stop.textContent = card.stopping ? '正在停止…' : '停止';
    }
  }
  return { update };
}
