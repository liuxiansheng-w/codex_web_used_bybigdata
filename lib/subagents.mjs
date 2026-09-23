import { check } from './workspace.mjs';

const parentOf = raw => raw.parentThreadId || raw.source?.subAgent?.thread_spawn?.parent_thread_id;
const itemsOf = raw => raw.items || raw.turns?.flatMap(turn => turn.items || []) || [];
export class Subagents {
  constructor(workspace) {
    this.workspace = workspace; this.bridge = workspace.bridge; this.inflight = new Map(); this.started = new Map(); this.active = new Set();
    this.bridge.on('notification', ({ method, params }) => {
      const raw = params?.thread;
      if (method === 'thread/started' && raw && parentOf(raw)) { this.started.set(raw.id, parentOf(raw)); if (this.started.size > 200) this.started.delete(this.started.keys().next().value); }
    });
    this.bridge.on('offline', () => this.active.clear());
  }
  async list(parentId) {
    this.workspace.validId(parentId);
    if (this.inflight.has(parentId)) return this.inflight.get(parentId);
    const operation = this.read(parentId).finally(() => this.inflight.delete(parentId)); this.inflight.set(parentId, operation); return operation;
  }
  async read(parentId) {
    const root = await this.workspace.get(parentId), queue = [{ id: parentId, raw: root, depth: 0 }], seen = new Set([parentId]), agents = [];
    let limited = false; const deadline = Date.now() + 8000;
    for (let index = 0; index < queue.length; index++) {
      const parent = queue[index], candidates = new Map();
      for (const item of itemsOf(parent.raw)) {
        if (item.type === 'collabAgentToolCall') {
          for (const id of item.receiverThreadIds || []) {
            const previous = candidates.get(id);
            if (item.tool === 'spawnAgent' && item.senderThreadId === parent.id) candidates.set(id, { ...previous, trusted: true, prompt: item.prompt || '', state: item.agentsStates?.[id] || previous?.state });
            else if (previous) { previous.state = item.agentsStates?.[id] || previous.state; if (['followupTask', 'sendInput'].includes(item.tool)) previous.prompt = item.prompt || previous.prompt; }
          }
        }
        if (item.type === 'subAgentActivity' && !candidates.has(item.agentThreadId)) candidates.set(item.agentThreadId, { name: item.agentPath });
      }
      for (const [id, owner] of this.started) if (owner === parent.id && !candidates.has(id)) candidates.set(id, { trusted: true });
      for (const cached of this.workspace.threads.values()) if (cached.parentThreadId === parent.id && !candidates.has(cached.id)) candidates.set(cached.id, { trusted: true });
      for (const [id, record] of candidates) {
        if (seen.has(id)) continue;
        if (agents.length >= 40 || parent.depth >= 8 || Date.now() > deadline) { limited = true; break; }
        seen.add(id); this.workspace.validId(id);
        let raw, error;
        try { ({ thread: raw } = await this.bridge.request('thread/read', { threadId: id, includeTurns: true }, 3000)); }
        catch { error = '当前状态未同步'; }
        if (raw && parentOf(raw) && parentOf(raw) !== parent.id) continue;
        if (!record.trusted && parentOf(raw || {}) !== parent.id) continue;
        const last = raw?.turns?.at(-1), nativeState = raw?.status?.type;
        let status = error ? 'unknown' : nativeState === 'active' || last?.status === 'inProgress' ? 'running' : last?.status === 'failed' || nativeState === 'systemError' ? 'errored' : last?.status === 'interrupted' ? 'interrupted' : record.state?.status === 'shutdown' ? 'shutdown' : last?.status === 'completed' ? 'completed' : record.state?.status || 'pendingInit';
        if (!raw) { error ||= '当前状态未同步'; status = 'unknown'; }
        const pending = raw?.status?.activeFlags || [];
        if (status === 'running' && pending.some(flag => /waiting|approval|input/i.test(flag))) status = 'waiting';
        const message = last ? (last.items || []).filter(item => item.type === 'agentMessage').at(-1)?.text || '' : record.state?.message || '';
        const activityItem = (last?.items || []).filter(item => ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)).at(-1);
        const activity = status === 'errored' ? last?.error?.message || '执行失败，打开完整会话查看错误。' : status === 'running' && activityItem?.status === 'inProgress' ? ({ commandExecution: '正在执行命令', fileChange: '正在修改文件', mcpToolCall: '正在调用工具', webSearch: '正在搜索资料' })[activityItem.type] || '' : '';
        agents.push({ id, parentId: parent.id, depth: parent.depth + 1, cwd: raw?.cwd || root.cwd, name: raw?.agentNickname || record.name || raw?.name || `子任务 ${agents.length + 1}`, role: raw?.agentRole || '', prompt: (record.prompt || raw?.preview || '').slice(0, 5000), status, lastKnownStatus: record.state?.status || null, message: message.slice(0, 5000), messageTruncated: message.length > 5000, activity: activity.slice(0, 1200), error, canStop: ['running', 'waiting'].includes(status) && last?.status === 'inProgress', updatedAt: raw?.updatedAt || null });
        if (['running', 'waiting', 'unknown'].includes(status)) this.active.add(id); else this.active.delete(id);
        if (raw) queue.push({ id, raw, depth: parent.depth + 1 });
      }
    }
    return { parentId, parentThreadId: root.parentThreadId || null, agents, limited, checkedAt: Date.now() };
  }
  async interrupt(parentId, { childId }) {
    const result = await this.list(parentId), agent = result.agents.find(row => row.id === childId);
    check(agent?.canStop, '这个子任务不在运行中，或不属于当前会话。', 409);
    const { thread } = await this.bridge.request('thread/read', { threadId: childId, includeTurns: true });
    check(!parentOf(thread) || parentOf(thread) === agent.parentId, '子任务归属已变化。', 409);
    const turn = thread.turns?.at(-1); check(turn?.status === 'inProgress', '子任务已经结束，请刷新状态。', 409);
    await this.bridge.request('turn/interrupt', { threadId: childId, turnId: turn.id });
    return { ok: true, message: '停止请求已发送；当前状态见任务卡片。' };
  }
}
