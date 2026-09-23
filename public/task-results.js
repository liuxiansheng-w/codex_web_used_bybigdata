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
