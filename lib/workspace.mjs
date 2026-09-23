import { EventEmitter } from 'node:events';
import { COSMOS_MODEL, COSMOS_PROVIDER } from './model-connections.mjs';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ContextStore, CapabilityCatalog, attachmentInput } from './context.mjs';
import { PermissionPolicy } from './permissions.mjs';
import { permissionSettings } from '../public/permission-presets.js';
import { validateElicitation } from './mcp-forms.mjs';
import { milliseconds, turnTiming, readHistoryTiming } from './message-timing.mjs';
import { userMessageContent } from './image-previews.mjs';
import { previewTitle, titleSource, validTitle } from './thread-titles.mjs';

export function check(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), { status });
}

export async function directory(value) {
  check(typeof value === 'string' && path.isAbsolute(value) && value.length < 4096, '请输入工作目录的绝对路径。');
  try {
    const resolved = await realpath(value);
    check((await stat(resolved)).isDirectory(), '所选路径不是文件夹。');
    return resolved;
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error('工作目录不存在或无法访问。'), { status: 400 });
  }
}

const supportedRequests = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

// Retain only displayable items, never raw reasoning content or account tokens.
function visibleItem(item, context) {
  const base = { id: item.id, type: item.type };
  if (item.type === 'userMessage') return { ...base, ...userMessageContent(item.content, context.images) };
  if (item.type === 'agentMessage' || item.type === 'plan') return { ...base, text: item.text || '', ...(item.phase ? { phase: item.phase } : {}) };
  if (item.type === 'reasoning') return null;
  if (item.type === 'commandExecution') return { ...base, title: item.command, text: item.aggregatedOutput || '', status: item.status, exitCode: item.exitCode };
  if (item.type === 'fileChange') return { ...base, title: '修改文件', text: (item.changes || []).map(c => `${c.path}\n${c.diff || ''}`).join('\n\n'), changes: (item.changes || []).map(c => ({ path: c.path, diff: c.diff || '', kind: typeof c.kind === 'string' ? c.kind : c.kind?.type, ...(c.kind?.move_path ? { movePath: c.kind.move_path } : {}) })), status: item.status };
  if (item.type === 'collabAgentToolCall') return { ...base, title: 'AI 子任务', tool: item.tool, status: item.status, senderThreadId: item.senderThreadId, receiverThreadIds: item.receiverThreadIds || [], prompt: (item.prompt || '').slice(0, 5000), agentsStates: Object.fromEntries(Object.entries(item.agentsStates || {}).map(([id, state]) => [id, { status: state.status, message: (state.message || '').slice(0, 5000) }])) };
  if (item.type === 'subAgentActivity') return { ...base, title: 'AI 子任务', agentPath: item.agentPath, agentThreadId: item.agentThreadId, kind: item.kind };
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return { ...base, title: `${item.server || item.namespace || '工具'} / ${item.tool}`, text: (item.error?.message || JSON.stringify(item.result || item.contentItems || '', null, 2)).slice(0, 100000), status: item.status };
  if (['enteredReviewMode', 'exitedReviewMode'].includes(item.type)) return { ...base, title: '代码审查', text: item.review || '', status: 'completed' };
  if (item.type === 'webSearch') return { ...base, title: '搜索网页', text: item.action?.query || '', status: 'completed' };
  if (item.type === 'contextCompaction') return { ...base, title: '已整理对话上下文', text: '', status: 'completed' };
  return null;
}

export class Workspace extends EventEmitter {
  constructor(bridge, defaultCwd, { titleGenerator = null, modelConnections = null } = {}) {
    super();
    this.bridge = bridge;
    this.defaultCwd = defaultCwd;
    this.context = new ContextStore();
    this.catalog = new CapabilityCatalog(bridge);
    this.permissions = new PermissionPolicy(bridge);
    this.models = [];
    this.threads = new Map();
    this.requests = new Map();
    this.resumed = new Set();
    this.locks = new Set();
    this.timers = new Map();
    this.titleReads = new Map();
    this.titleGenerator = titleGenerator; this.titleJobs = new Map(); this.titleAttempts = new Map();
    this.modelConnections = modelConnections;
    this.epoch = 0;
    bridge.on('notification', m => this.notification(m));
    bridge.on('request', m => this.serverRequest(m));
    bridge.on('offline', message => {
      this.epoch++;
      this.resumed.clear();
      this.permissions.cached = null;
      this.requests.clear();
      for (const thread of this.threads.values()) {
        if (thread.busy) { thread.busy = false; thread.error = '连接中断，执行结果尚未确认。重新连接后打开会话核对。'; }
        thread.requests = [];
        if (thread.queue?.length) thread.queuePaused = true;
        this.changed(thread);
      }
      this.emit('connection', { connected: false, error: message });
    });
    bridge.on('online', () => this.emit('connection', { connected: true }));
  }

  changed(thread) {
    thread.revision = (thread.revision || 0) + 1;
    if (this.timers.has(thread.id)) return;
    this.timers.set(thread.id, setTimeout(() => {
      this.timers.delete(thread.id);
      this.emit('thread', thread);
    }, 45));
  }

  importThread(raw, extra = {}, history = {}) {
    const previous = this.threads.get(raw.id);
    const previousItems = new Map(previous?.items.map(item => [item.id, item]) || []);
    const turnTimings = (raw.turns || []).map(turn => turnTiming(turn, history.turns?.get(turn.id) || previous?.turnTimings?.find(t => t.id === turn.id)));
    const items = (raw.turns || []).flatMap(turn => {
      const visible = (turn.items || []).map(item => visibleItem(item, this.context)).filter(Boolean), timing = turnTimings.find(t => t.id === turn.id);
      const firstUser = visible.find(item => item.type === 'userMessage'), lastReply = visible.filter(item => item.type === 'agentMessage').at(-1);
      return visible.map(item => {
        const saved = history.messages?.get(item.id), old = previousItems.get(item.id);
        const timestamp = saved?.type === item.type ? saved.timestamp : old?.timestamp;
        const fallback = item === firstUser ? timing.startedAt : item === lastReply && turn.status !== 'inProgress' ? timing.completedAt : null;
        return { ...item, turnId: turn.id, timestamp: timestamp ?? fallback ?? null, timestampSource: timestamp ? saved?.type === item.type ? 'history' : old.timestampSource : fallback ? item === firstUser ? 'turnStart' : 'turnEnd' : null };
      });
    });
    const last = raw.turns?.at(-1);
    const thread = {
      id: raw.id, name: raw.name || null, preview: raw.preview || '', title: raw.name || previewTitle(raw.preview), nameVersion: (previous?.nameVersion || 0) + 1, titleVersion: (previous?.titleVersion || 0) + 1, cwd: raw.cwd ? path.resolve(raw.cwd) : raw.cwd,
      parentThreadId: raw.parentThreadId || raw.source?.subAgent?.thread_spawn?.parent_thread_id || null, agentNickname: raw.agentNickname || null, agentRole: raw.agentRole || null,
      items, turnTimings, updatedAt: raw.updatedAt || previous?.updatedAt || null, busy: last?.status === 'inProgress', turnId: last?.status === 'inProgress' ? last.id : null, latestTurnId: last?.id, completion: last?.status,
      model: raw.modelProvider === COSMOS_PROVIDER ? COSMOS_MODEL : '', modelProvider: raw.modelProvider || previous?.modelProvider || null, mode: 'workspace-write', effort: '', plan: false, goal: null, requests: [], revision: (this.threads.get(raw.id)?.revision || 0) + 1, error: last?.error?.message || null,
      ...extra,
    };
    if (thread.modelProvider === COSMOS_PROVIDER) thread.model = COSMOS_MODEL;
    if (thread.parentThreadId) this.modelConnections?.bind(thread.id, this.modelConnections.bindings.get(thread.parentThreadId));
    this.threads.set(thread.id, thread);
    return thread;
  }

  async importHistory(raw, extra = {}) { return this.importThread(raw, extra, await readHistoryTiming(raw)); }

  updateTitle(thread, raw, force = false) {
    const name = typeof raw.name === 'string' ? raw.name || null : raw.name === null ? null : thread.name;
    const preview = typeof raw.preview === 'string' ? raw.preview : thread.preview || '';
    const title = name || previewTitle(preview);
    if (!force && thread.name === name && thread.preview === preview && thread.title === title) return;
    if (force || thread.name !== name) thread.nameVersion = (thread.nameVersion || 0) + 1;
    Object.assign(thread, { name, preview, title, titleVersion: (thread.titleVersion || 0) + 1 });
    this.changed(thread);
  }

  async refreshTitle(thread) {
    if (this.titleReads.has(thread.id)) return this.titleReads.get(thread.id);
    const epoch = this.epoch, version = thread.titleVersion;
    const pending = (async () => {
      try {
        const { thread: raw } = await this.bridge.request('thread/read', { threadId: thread.id, includeTurns: false }, 10_000);
        if (raw && epoch === this.epoch && this.threads.get(thread.id) === thread && thread.titleVersion === version) {
          this.updateTitle(thread, raw); return true;
        }
        return false;
      } catch { /* A metadata read must not change task state or discard the last known title. */ }
      finally { this.titleReads.delete(thread.id); }
    })();
    this.titleReads.set(thread.id, pending);
    return pending;
  }

  ensureTitle(thread) {
    if ((!this.titleGenerator && thread.model !== COSMOS_MODEL) || thread.name || thread.archived || !this.bridge.ready) return Promise.resolve();
    // Browsing older Codex history while Cosmos is selected must not incur a
    // new Codex inference just to name an old conversation.
    if (this.modelConnections?.value.active === 'cosmos' && thread.model !== COSMOS_MODEL) return Promise.resolve();
    if (this.titleJobs.has(thread.id)) return this.titleJobs.get(thread.id);
    const source = titleSource(thread.items.find(item => item.type === 'userMessage')?.text || thread.preview);
    if (!source || Date.now() - (this.titleAttempts.get(thread.id) || 0) < 60_000) return Promise.resolve();
    this.titleAttempts.set(thread.id, Date.now());
    const epoch = this.epoch, version = thread.nameVersion;
    const stillCurrent = () => this.epoch === epoch && this.threads.get(thread.id) === thread && !thread.name && thread.nameVersion === version && !thread.archived;
    const pending = (async () => {
      try {
        // Cosmos titles use the first message locally: no hidden model request
        // just to label a conversation. Native Codex titles keep their behavior.
        const connection = thread.model !== COSMOS_MODEL && this.modelConnections ? await this.modelConnections.forThread(thread.id, thread.model) : undefined;
        const title = thread.model === COSMOS_MODEL ? previewTitle(source) : validTitle(await this.titleGenerator.generate(source, thread.model, { connection }));
        if (!title || !stillCurrent()) return;
        // Recheck the native name after generation; another client may have renamed it.
        const refreshed = await this.refreshTitle(thread);
        if (!refreshed || !stillCurrent() || this.locks.has(thread.id)) return;
        this.locks.add(thread.id);
        try {
          await this.bridge.request('thread/name/set', { threadId: thread.id, name: title }, 10_000);
          if (stillCurrent()) this.updateTitle(thread, { name: title });
        } finally { this.locks.delete(thread.id); }
      } catch { /* Keep the clean provisional title; never fail the user's task. */ }
      finally { this.titleJobs.delete(thread.id); }
    })();
    this.titleJobs.set(thread.id, pending); return pending;
  }

  recordTurn(thread, turn, event) {
    thread.turnTimings ||= [];
    const index = thread.turnTimings.findIndex(t => t.id === turn.id), previous = thread.turnTimings[index];
    // A delayed start response must not reset completed timing.
    if (previous?.completedAt != null && event !== 'complete') return;
    const timing = turnTiming(turn, previous, event === 'start' ? { startedAt: Date.now() } : event === 'complete' ? { completedAt: Date.now() } : {});
    if (index < 0) thread.turnTimings.push(timing); else thread.turnTimings[index] = timing;
  }

  async bootstrap() {
    const results = await Promise.allSettled([
      this.bridge.request('account/read', { refreshToken: false }),
      this.bridge.request('model/list', { limit: 100 }),
      this.permissions.list(),
    ]);
    const [accountResult, modelResult] = results;
    if (modelResult.status === 'fulfilled') this.models = modelResult.value.data.filter(m => !m.hidden);
    if (this.modelConnections) {
      await this.modelConnections.loading;
      this.models = this.models.filter(m => m.model !== COSMOS_MODEL);
      if (this.modelConnections.value.cosmos?.verifiedAt) this.models.push(this.modelConnections.model());
    }
    const account = accountResult.status === 'fulfilled' ? accountResult.value : null;
    return {
      connected: this.bridge.ready, cwd: this.defaultCwd,
      auth: account ? { loggedIn: Boolean(account.account) || account.requiresOpenaiAuth === false, type: account.account?.type || 'provider' } : null,
      models: this.models.map(m => ({ id: m.model, name: m.displayName, isDefault: m.isDefault, efforts: m.supportedReasoningEfforts || [], defaultEffort: m.defaultReasoningEffort, inputModalities: m.inputModalities || ['text'] })),
      permissions: results[2].status === 'fulfilled' ? results[2].value : null,
      warnings: results.filter(r => r.status === 'rejected').map(r => r.reason.message),
    };
  }

  async list(cwd, cursor = null, { search = '', archived = false, scope = 'title' } = {}) {
    const resolved = await directory(cwd);
    check(typeof search === 'string' && search.length <= 500, '搜索条件过长。');
    const versions = new Map([...this.threads].map(([id, thread]) => [id, thread.titleVersion]));
    const result = await this.bridge.request('thread/list', { cwd: resolved, limit: 40, sortKey: 'updated_at', cursor, archived, ...(this.modelConnections ? { modelProviders: [] } : {}), ...(search && scope !== 'content' ? { searchTerm: search } : {}), useStateDbOnly: true });
    let matches = result.data, partial = false;
    if (search && scope === 'content') {
      const needle = search.toLocaleLowerCase(); matches = [];
      // Bounded reads cover every record on this page; a deadline must not
      // silently skip the tail and then advance the native pagination cursor.
      for (let offset = 0; offset < result.data.length; offset += 4) {
        const batch = await Promise.allSettled(result.data.slice(offset, offset + 4).map(async raw => {
          if (raw.cwd && path.resolve(raw.cwd) !== resolved) return null;
          if (String(raw.name || '').toLocaleLowerCase().includes(needle)) return raw;
          const cached = this.threads.get(raw.id);
          let items = cached?.items;
          if (!items) {
            const read = (await this.bridge.request('thread/read', { threadId: raw.id, includeTurns: true }, 1500)).thread;
            if (!read) throw new Error('会话内容暂时不可用');
            if (read.cwd && path.resolve(read.cwd) !== resolved) return null;
            items = (read.turns || []).flatMap(turn => turn.items || []);
          }
          const textOf = item => ['userMessage', 'agentMessage'].includes(item.type) ? item.text || (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
          const found = items.map(textOf).find(text => text.toLocaleLowerCase().includes(needle));
          if (!found) return null;
          const index = found.toLocaleLowerCase().indexOf(needle);
          return { ...raw, matchPreview: found.slice(Math.max(0, index - 30), index + 130) };
        }));
        for (const entry of batch) { if (entry.status === 'rejected') partial = true; else if (entry.value) matches.push(entry.value); }
      }
    }
    return { cwd: resolved, partial, searched: result.data.length, threads: matches.map(raw => {
      const loaded = this.threads.get(raw.id);
      // Reconcile the loaded cache too, otherwise it masks the fresh list title.
      // An older response must never overwrite a rename received in flight.
      if (loaded && loaded.titleVersion === versions.get(raw.id)) this.updateTitle(loaded, raw);
      return { id: raw.id, title: loaded?.title || raw.name || previewTitle(raw.preview), updatedAt: raw.updatedAt, preview: raw.matchPreview || loaded?.items.filter(item => ['userMessage', 'agentMessage'].includes(item.type)).at(-1)?.text?.slice(0, 180) || raw.preview || '', cwd: raw.cwd };
    }), nextCursor: result.nextCursor };
  }

  async get(id, { refreshTitle = false } = {}) {
    this.validId(id);
    if (this.threads.has(id)) {
      const thread = this.threads.get(id);
      // Child threads can be driven by their parent rather than this bridge's
      // resumed session. Refresh their history without resuming or changing policy.
      if (thread.parentThreadId && !this.resumed.has(id) && !this.locks.has(id) && !thread.requests?.length && !thread.queue?.length) {
        const revision = thread.revision;
        const { thread: raw } = await this.bridge.request('thread/read', { threadId: id, includeTurns: true });
        const timing = await readHistoryTiming(raw);
        if (this.threads.get(id) === thread && thread.revision === revision && !this.resumed.has(id)) return this.importThread(raw, { model: thread.model, mode: thread.mode, effort: thread.effort, goal: thread.goal }, timing);
      }
      if (refreshTitle) { await this.refreshTitle(thread); void this.ensureTitle(thread); }
      return thread;
    }
    const { thread } = await this.bridge.request('thread/read', { threadId: id, includeTurns: true });
    const current = await this.importHistory(thread);
    try { current.goal = (await this.bridge.request('thread/goal/get', { threadId: id }, 10_000)).goal; } catch { /* Older runtimes may not expose goals. */ }
    void this.ensureTitle(current);
    return current;
  }

  validId(id) { check(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id), '会话编号无效。'); }

  async threadAction({ threadId, action, name }) {
    this.validId(threadId); check(!this.locks.has(threadId), '会话正在提交。', 409);
    this.locks.add(threadId);
    try {
      const thread = await this.get(threadId);
      check(!thread.busy && !thread.queue?.length, '请先停止任务或清空队列。', 409);
      if (action === 'rename') {
        check(typeof name === 'string' && name.trim() && name.length <= 200, '名称须为 1–200 个字符。');
        await this.bridge.request('thread/name/set', { threadId, name: name.trim() }); this.updateTitle(thread, { name: name.trim() }, true);
      } else if (action === 'archive' || action === 'unarchive') {
        await this.bridge.request(`thread/${action}`, { threadId }); thread.archived = action === 'archive'; this.resumed.delete(threadId); this.changed(thread);
      } else if (action === 'fork') {
        const { sandboxPolicy, ...permissions } = await this.permissions.resolve({ mode: 'read-only', cwd: thread.cwd });
        const connection = await this.modelConnections?.forThread(thread.id, thread.model);
        const result = await this.bridge.request('thread/fork', { threadId, ...permissions, ...connection, deferGoalContinuation: true });
        const fork = await this.importHistory(result.thread, { model: result.model, mode: 'read-only' }); this.resumed.add(fork.id); this.changed(fork);
        this.modelConnections?.bind(fork.id, connection);
        return { threadId: fork.id };
      } else if (action === 'compact') {
        await this.safeResume(thread); await this.bridge.request('thread/compact/start', { threadId });
      } else check(false, '未知会话操作。');
      return { threadId };
    } finally { this.locks.delete(threadId); }
  }

  async safeResume(thread) {
    check(thread.goal?.status !== 'active', '请先暂停持续目标，再进行审查或上下文整理。', 409);
    const { sandboxPolicy, ...permissions } = await this.permissions.resolve({ mode: 'read-only', cwd: thread.cwd });
    const connection = await this.modelConnections?.forThread(thread.id, thread.model);
    const result = await this.bridge.request('thread/resume', { threadId: thread.id, ...permissions, ...connection });
    this.modelConnections?.bind(thread.id, connection);
    check(!result.thread.turns?.some(t => t.status === 'inProgress'), '会话正在其他客户端运行。', 409);
    thread.mode = 'read-only'; this.resumed.add(thread.id); return thread;
  }

  async review({ threadId, target }) {
    this.validId(threadId); check(!this.locks.has(threadId), '会话正在提交。', 409); this.locks.add(threadId);
    try {
      const thread = await this.get(threadId); check(!thread.busy && !thread.queue?.length, '当前会话仍在执行或有排队消息。', 409);
      check(target && ['uncommittedChanges', 'baseBranch', 'commit', 'custom'].includes(target.type), '审查范围无效。');
      const field = { baseBranch: 'branch', commit: 'sha', custom: 'instructions' }[target.type];
      if (field) check(typeof target[field] === 'string' && target[field].trim() && target[field].length <= 4000, '请输入审查范围。');
      await this.safeResume(thread);
      thread.busy = true; thread.error = null; this.changed(thread);
      try { const result = await this.bridge.request('review/start', { threadId, target: { type: target.type, ...(field ? { [field]: target[field] } : {}) }, delivery: 'inline' }); this.recordTurn(thread, result.turn, 'response'); if (thread.busy) thread.turnId = result.turn.id; this.changed(thread); return { threadId }; }
      catch (error) { thread.busy = /超时/.test(error.message); thread.error = error.message; this.changed(thread); throw error; }
    } finally { this.locks.delete(threadId); }
  }

  async followup(body) {
    const { threadId, behavior = 'steer', text, attachments = [], capabilities = [] } = body;
    this.validId(threadId); const thread = await this.get(threadId);
    check(thread.busy && thread.turnId && this.resumed.has(threadId), '任务已结束或不由本页面启动，请重新发送。', 409);
    check(typeof text === 'string' && text.trim() && text.length <= 100000, '消息不能为空或过长。');
    if (behavior === 'steer') {
      check(!this.locks.has(threadId), '正在提交，请稍后。', 409); this.locks.add(threadId);
      try {
        const input = [{ type: 'text', text, text_elements: [] }, ...attachmentInput(this.context.resolve(attachments)), ...await this.catalog.input(thread.cwd, capabilities)];
        await this.bridge.request('turn/steer', { threadId, expectedTurnId: thread.turnId, input });
      } finally { this.locks.delete(threadId); }
    } else {
      check(behavior === 'queue', '追加方式无效。');
      check(thread.mode !== 'full-access' && thread.mode !== 'danger-full-access', '完全访问模式不支持自动排队，请选择立即追加或降低权限。');
      check(thread.goal?.status !== 'active', '持续目标运行时请使用立即追加，或先暂停目标。');
      this.context.resolve(attachments); await this.catalog.input(thread.cwd, capabilities);
      thread.queue ||= []; check(thread.queue.length < 20, '最多排队 20 条消息。');
      thread.queue.push({ id: randomUUID(), text, attachments, capabilities, cwd: thread.cwd, model: thread.model, mode: thread.mode, effort: thread.effort, plan: thread.plan });
      this.changed(thread);
      this.drainQueue(thread); // Completion may have arrived while resolving attachments/tools.
    }
    return { threadId };
  }

  queueAction({ threadId, id, action }) {
    const thread = this.threads.get(threadId); check(thread, '会话不存在。');
    if (action === 'remove') thread.queue = (thread.queue || []).filter(item => item.id !== id);
    else if (action === 'resume') { thread.queuePaused = false; this.drainQueue(thread); }
    else check(false, '队列操作无效。');
    this.changed(thread); return { ok: true };
  }

  drainQueue(thread) {
    if (thread.busy || thread.queuePaused || !thread.queue?.length || !this.bridge.ready) return;
    if (this.locks.has(thread.id)) { const timer = setTimeout(() => this.drainQueue(thread), 100); timer.unref(); return; }
    const queued = thread.queue.shift(); this.changed(thread);
    this.send({ ...queued, threadId: thread.id }).catch(error => { thread.queue.unshift(queued); thread.queuePaused = true; thread.error = `队列已暂停：${error.message}`; this.changed(thread); });
  }

  async send({ threadId, text, cwd, model, modelService, mode, fullAccessConfirmed = false, effort = '', plan = false, attachments = [], capabilities = [], goal = undefined }) {
    check(typeof text === 'string' && text.trim().length > 0 && text.length <= 100_000, '消息不能为空，且不能超过 100,000 个字符。');
    permissionSettings(mode, cwd);
    check(model === undefined || (typeof model === 'string' && model.length < 150), '无效的模型。');
    check(typeof plan === 'boolean', '无效的计划模式。');
    check(typeof effort === 'string' && (!effort || ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)), '无效的推理强度。');
    if (goal !== undefined) this.validateGoal(goal);
    if (threadId) this.validId(threadId);
    const lock = threadId || 'new';
    check(!this.locks.has(lock), '该会话正在提交，请稍候。', 409);
    this.locks.add(lock);
    let current;
    let submitted = false;
    try {
      if (this.modelConnections) {
        await this.modelConnections.status();
        check(modelService === undefined || ['codex', 'cosmos'].includes(modelService), '无效的模型服务。');
        if (modelService === 'cosmos') model = COSMOS_MODEL;
        if (modelService === 'codex') check(model !== COSMOS_MODEL, '模型与所选服务不一致。');
        if (threadId) {
          current = await this.get(threadId);
          if (!model) model = current.model;
          check((model === COSMOS_MODEL) === (current.modelProvider === COSMOS_PROVIDER || current.model === COSMOS_MODEL), '切换模型服务请新建对话，原会话与任务会保留。', 409);
        } else if (!model && !modelService && this.modelConnections.value.active === 'cosmos') model = COSMOS_MODEL;
      }
      const connection = await this.modelConnections?.forThread(threadId, model);
      const resolved = await directory(cwd);
      const permissions = await this.permissions.resolve({ mode, cwd: resolved, plan, fullAccessConfirmed });
      const files = this.context.resolve(attachments);
      const capabilityInput = await this.catalog.input(resolved, capabilities);
      if (plan) check((await this.catalog.get(resolved)).planSupported, '当前助手运行时不支持计划模式。');
      const selectedModel = this.models.find(m => m.model === (model || this.threads.get(threadId)?.model)) || (!model ? this.models.find(m => m.isDefault) : undefined);
      if (connection) {
        check(!files.some(f => f.kind === 'image'), '当前 Cosmos 接入仅验证了文本能力，请移除图片。');
        check(!effort, 'Cosmos 使用服务端配置的推理强度，请选择默认强度。');
      }
      if (effort && selectedModel) check(selectedModel.supportedReasoningEfforts?.some(e => e.reasoningEffort === effort), '当前模型不支持所选推理强度。');
      if (files.some(f => f.kind === 'image') && selectedModel) check(selectedModel.inputModalities?.includes('image'), '当前模型不支持图片，请选择支持图片的模型。');
      const { sandboxPolicy, ...threadPermissions } = permissions;
      const overrides = { cwd: resolved, ...threadPermissions, ...(model ? { model } : {}), ...connection };
      if (!threadId) {
        const result = await this.bridge.request('thread/start', overrides);
        current = this.importThread(result.thread, { model: connection ? COSMOS_MODEL : result.model, modelProvider: connection ? COSMOS_PROVIDER : result.thread.modelProvider, mode });
        this.resumed.add(current.id);
      } else {
        current = await this.get(threadId);
        check(!current.busy, '该会话仍在执行，请等待完成或先停止任务。', 409);
        check(current.cwd === resolved, '继续会话请使用原工作目录；切换目录请新建对话。');
        if (!this.resumed.has(threadId)) {
          const result = await this.bridge.request('thread/resume', { threadId, ...overrides });
          current = await this.importHistory(result.thread, { model: connection ? COSMOS_MODEL : result.model, mode, goal: current.goal });
          check(!current.busy, '该会话仍在其他客户端执行，暂时无法发送。', 409);
          this.resumed.add(threadId);
        }
      }
      this.modelConnections?.bind(current.id, connection);
      if (goal !== undefined) {
        const result = await this.bridge.request('thread/goal/set', { threadId: current.id, objective: goal.objective, status: 'active', ...(goal.tokenBudget ? { tokenBudget: goal.tokenBudget } : {}) });
        current.goal = result.goal;
      }
      current.busy = true;
      current.mode = mode;
      current.plan = plan;
      current.effort = effort;
      current.error = null;
      if (model) current.model = model;
      // Show a compact provisional title while the asynchronous summary is generated.
      if (!current.name && !current.preview) this.updateTitle(current, { preview: text.trim().slice(0, 100) });
      current.items.push({ id: `pending-${randomUUID()}`, type: 'userMessage', text, attachments: files.map(file => this.context.public(file)), pending: true, timestamp: Date.now(), timestampSource: 'observed' });
      this.changed(current);
      submitted = true;
      const result = await this.bridge.request('turn/start', {
        threadId: current.id, input: [{ type: 'text', text, text_elements: [] }, ...attachmentInput(files), ...capabilityInput],
        approvalPolicy: permissions.approvalPolicy, approvalsReviewer: permissions.approvalsReviewer, sandboxPolicy,
        ...(model ? { model: connection?.model || model } : {}),
        ...(effort ? { effort } : {}),
        collaborationMode: { mode: plan ? 'plan' : 'default', settings: { model: connection?.model || model || current.model, reasoning_effort: effort || null, developer_instructions: null } },
      });
      // Completion may arrive before this response; never resurrect a finished turn.
      this.recordTurn(current, result.turn, 'response');
      if (current.busy) current.turnId = result.turn.id;
      this.changed(current);
      void this.ensureTitle(current);
      return { threadId: current.id };
    } catch (error) {
      if (current && submitted) {
        const uncertain = /超时/.test(error.message);
        current.busy = uncertain;
        current.error = error.message;
        current.items = current.items.filter(i => !i.pending);
        this.changed(current);
      }
      throw error;
    } finally { this.locks.delete(lock); }
  }

  notification({ method, params: p = {} }) {
    if (method === 'serverRequest/resolved') {
      for (const [key, request] of this.requests) if (request.rpcId === p.requestId) this.removeRequest(key);
      return;
    }
    const t = this.threads.get(p.threadId);
    if (!t) return;
    if (method === 'item/autoApprovalReview/started' || method === 'item/autoApprovalReview/completed') {
      const item = { id: `review-${p.reviewId}`, type: 'approvalReview', title: '助手自动审查', status: method.endsWith('/started') ? 'inProgress' : p.review?.status, text: p.review?.rationale || '正在评估操作风险与授权范围…' };
      const index = t.items.findIndex(i => i.id === item.id);
      if (index < 0) t.items.push(item); else t.items[index] = item;
    } else if (method === 'thread/name/updated') { this.updateTitle(t, { name: p.threadName ?? null }, true); return; }
    else if (method === 'thread/goal/updated') t.goal = p.goal;
    else if (method === 'thread/goal/cleared') t.goal = null;
    else if (method === 'turn/started') { this.recordTurn(t, p.turn, 'start'); t.busy = true; t.turnId = p.turn.id; t.latestTurnId = p.turn.id; t.completion = null; }
    else if (method === 'turn/completed') {
      this.recordTurn(t, p.turn, 'complete');
      t.busy = false; t.turnId = null;
      t.error = p.turn.error?.message || null;
      t.completion = p.turn.status;
      t.latestTurnId = p.turn.id;
      for (const request of [...t.requests]) this.removeRequest(request.key);
      if (p.turn.status !== 'completed') t.queuePaused = true;
      void this.refreshTitle(t).then(() => this.ensureTitle(t));
      const timer = setTimeout(() => this.drainQueue(t), 100); timer.unref();
    } else if (method === 'thread/tokenUsage/updated') {
      t.tokenUsage = p.tokenUsage;
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = visibleItem(p.item, this.context);
      if (!item) return;
      item.turnId = p.turnId || t.turnId || t.latestTurnId;
      const previous = t.items.find(i => i.id === item.id) || (item.type === 'userMessage' ? t.items.find(i => i.pending) : null);
      const nativeTime = milliseconds(p.startedAtMs) ?? milliseconds(p.completedAtMs);
      const keepPrevious = item.type === 'userMessage' && previous?.timestamp && method === 'item/completed';
      item.timestamp = keepPrevious ? previous.timestamp : nativeTime ?? previous?.timestamp ?? Date.now();
      item.timestampSource = keepPrevious ? previous.timestampSource : nativeTime ? 'native' : previous?.timestampSource || 'observed';
      if (item.type === 'userMessage') t.items = t.items.filter(i => !i.pending);
      const index = t.items.findIndex(i => i.id === item.id);
      if (index < 0) t.items.push(item); else t.items[index] = item;
    } else if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
      let item = t.items.find(i => i.id === p.itemId);
      if (!item) { item = { id: p.itemId, turnId: p.turnId || t.turnId || t.latestTurnId, type: method.includes('/plan/') ? 'plan' : 'agentMessage', text: '', timestamp: Date.now(), timestampSource: 'observed' }; t.items.push(item); }
      item.text += p.delta;
    } else if (method === 'item/commandExecution/outputDelta') {
      const item = t.items.find(i => i.id === p.itemId);
      if (item) item.text = (item.text + p.delta).slice(-100_000);
    } else if (method === 'error') t.error = p.error?.message || '执行出现错误。';
    else return;
    this.changed(t);
  }

  serverRequest(message) {
    const { method, id, params } = message;
    const thread = this.threads.get(params?.threadId);
    const unsupportedForm = method === 'mcpServer/elicitation/request' && !['form', 'url'].includes(params.mode);
    if (!thread || !supportedRequests.has(method) || unsupportedForm) {
      // Unsupported interactive flows must fail explicitly, never hang or auto-approve.
      if (method === 'mcpServer/elicitation/request') this.bridge.respond(id, { action: 'decline' });
      else this.bridge.unsupported(id);
      if (thread) { thread.error = `当前页面暂不支持此交互：${method}。可在 本机桌面客户端完成。`; this.changed(thread); }
      return;
    }
    const key = `${this.epoch}:${randomUUID()}`;
    const request = { key, method, params };
    this.requests.set(key, { ...request, rpcId: id });
    thread.requests.push(request);
    this.changed(thread);
  }

  removeRequest(key) {
    const request = this.requests.get(key);
    this.requests.delete(key);
    const thread = this.threads.get(request?.params.threadId);
    if (thread) { thread.requests = thread.requests.filter(r => r.key !== key); this.changed(thread); }
  }

  respond({ key, decision, answers, content }) {
    const request = this.requests.get(key);
    check(request, '该请求已结束，请刷新会话。', 409);
    let result;
    if (request.method === 'mcpServer/elicitation/request') {
      check(['accept', 'decline', 'cancel'].includes(decision), '授权回应无效。');
      if (decision === 'accept' && request.params.mode === 'form') validateElicitation(request.params.requestedSchema, content);
      result = { action: decision, ...(decision === 'accept' && request.params.mode === 'form' ? { content } : {}) };
    } else if (request.method === 'item/tool/requestUserInput') {
      check(answers && typeof answers === 'object', '请输入回答。');
      const mapped = {};
      for (const q of request.params.questions) {
        check(typeof answers[q.id] === 'string' && answers[q.id].trim() && answers[q.id].length <= 10000, '请回答所有问题。');
        mapped[q.id] = { answers: [answers[q.id]] };
      }
      result = { answers: mapped };
    } else {
      check(['accept', 'decline'].includes(decision), '无效的审批决定。');
      result = request.method === 'item/permissions/requestApproval'
        ? { permissions: decision === 'accept' ? Object.fromEntries(Object.entries(request.params.permissions).filter(([, value]) => value != null)) : {}, scope: 'turn' }
        : { decision };
    }
    this.bridge.respond(request.rpcId, result);
    this.removeRequest(key);
    return { ok: true };
  }

  async interrupt(id) {
    const thread = await this.get(id);
    thread.queuePaused = true;
    check(thread.busy && thread.turnId, '没有可停止的任务，或任务仍在提交中。', 409);
    if (thread.goal?.status === 'active') {
      thread.goal = (await this.bridge.request('thread/goal/set', { threadId: id, status: 'paused' })).goal;
      this.changed(thread);
    }
    if (!thread.busy || !thread.turnId) return { ok: true };
    await this.bridge.request('turn/interrupt', { threadId: id, turnId: thread.turnId });
    return { ok: true };
  }

  validateGoal(goal) {
    check(goal && typeof goal.objective === 'string' && goal.objective.trim() && goal.objective.length <= 4000, '目标不能为空，最多 4,000 个字符。');
    check(goal.tokenBudget == null || (Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0), 'Token 预算必须是正整数。');
  }

  async setGoal({ threadId, objective, tokenBudget, status, clear = false }) {
    this.validId(threadId);
    check(typeof clear === 'boolean', '目标操作无效。');
    if (!clear) {
      if (objective !== undefined) this.validateGoal({ objective, tokenBudget });
      check(status === undefined || ['active', 'paused', 'complete'].includes(status), '目标状态无效。');
      check(objective !== undefined || status !== undefined, '请设置目标内容或状态。');
    }
    check(!this.locks.has(threadId), '该会话正在提交，请稍候。', 409);
    this.locks.add(threadId);
    try {
      let thread = await this.get(threadId);
      if (!this.resumed.has(threadId)) {
        check(!thread.busy, '请勿修改其他客户端正在运行的会话目标。', 409);
        // Goal editing must never restore persisted full access implicitly.
        const { sandboxPolicy, ...safePermissions } = await this.permissions.resolve({ mode: 'read-only', cwd: thread.cwd, plan: false });
        const connection = await this.modelConnections?.forThread(threadId, thread.model);
        const result = await this.bridge.request('thread/resume', { threadId, ...safePermissions, ...connection });
        this.modelConnections?.bind(threadId, connection);
        thread = this.importThread(result.thread, { model: result.model, mode: 'read-only', goal: thread.goal, plan: thread.plan, effort: thread.effort });
        check(!thread.busy, '请勿修改其他客户端正在运行的会话目标。', 409);
        this.resumed.add(threadId);
      }
      if (clear) { await this.bridge.request('thread/goal/clear', { threadId }); thread.goal = null; }
      else {
        thread.goal = (await this.bridge.request('thread/goal/set', { threadId, ...(objective !== undefined ? { objective, tokenBudget: tokenBudget || null } : {}), ...(status ? { status } : {}) })).goal;
      }
      this.changed(thread);
      return { goal: thread.goal };
    } finally { this.locks.delete(threadId); }
  }
}
