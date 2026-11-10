import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { check, directory } from './workspace.mjs';
import { beijingDate, normalizeSchedule, nextScheduleAt } from '../public/schedule-time.js';
import { workdayStatus } from '../public/holiday-calendar.js';
import { HolidayCalendar } from './holiday-calendar.mjs';
import { ScheduleWorktrees } from './schedule-worktrees.mjs';
import { permissionSettings } from '../public/permission-presets.js';
const execute = promisify(execFile);

export class Workbench {
  constructor(workspace, files, stateDir, { threadOrganization, holidayCalendar, scheduleWorktrees, worktreeTrashDir } = {}) {
    this.workspace = workspace; this.bridge = workspace.bridge; this.files = files; this.stateDir = stateDir;
    this.threadOrganization = threadOrganization;
    this.holidayCalendar = holidayCalendar || new HolidayCalendar(stateDir);
    this.scheduleWorktrees = scheduleWorktrees || new ScheduleWorktrees(stateDir, (cwd, args) => this.git(cwd, args), worktreeTrashDir ? { trashDir: worktreeTrashDir } : {});
    this.processes = new Map(); this.jobs = []; this.ready = false; this.writing = Promise.resolve();
    this.timer = setInterval(() => this.tick().catch(() => {}), 15000); this.timer.unref();
    this.bridge.on('notification', ({ method, params: p }) => {
      if (method === 'turn/completed') { void this.scheduledTurnCompleted(p).catch(() => {}); return; }
      if (method !== 'command/exec/outputDelta') return;
      const process = this.processes.get(p.processId); if (!process) return;
      process.output = (process.output + process.decoder.write(Buffer.from(p.deltaBase64, 'base64'))).slice(-100000);
      process.truncated ||= p.capReached;
    });
    this.bridge.on('offline', () => { for (const process of this.processes.values()) if (process.running) { process.running = false; process.error = '连接断开，无法确认进程状态。'; } });
  }
  async git(cwd, args, { maxBuffer = 2 * 1024 * 1024 } = {}) {
    check(Number.isSafeInteger(maxBuffer) && maxBuffer > 0 && maxBuffer <= 16 * 1024 * 1024, 'Git 输出限制无效。');
    const root = await directory(cwd);
    try { return (await execute('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', ...args], { cwd: root, maxBuffer, timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })).stdout; }
    catch (error) { throw Object.assign(new Error((error.stderr || error.message).slice(0, 2000)), { status: 400 }); }
  }
  async gitStatus({ cwd }) {
    const root = await directory(cwd);
    const [status, unstaged, staged, branch, worktrees, rawFiles, prefix, stagedPaths] = await Promise.all([
      this.git(root, ['status', '--short', '--untracked-files=normal']),
      this.git(root, ['diff', '--relative', '--no-ext-diff', '--no-textconv', '--', '.']),
      this.git(root, ['diff', '--cached', '--relative', '--no-ext-diff', '--no-textconv', '--', '.']),
      this.git(root, ['branch', '--show-current']), this.git(root, ['worktree', 'list', '--porcelain']),
      this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']), this.git(root, ['rev-parse', '--show-prefix']),
      this.git(root, ['diff', '--cached', '--name-only', '-z']),
    ]);
    const files = [], entries = rawFiles.split('\0'), base = prefix.replace(/\r?\n$/, '');
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]; if (!entry) continue;
      const state = entry.slice(0, 2), name = entry.slice(3);
      if (/[RC]/.test(state)) index++; // Porcelain -z supplies the rename source separately.
      if (base && !name.startsWith(base)) continue;
      const relative = base ? name.slice(base.length) : name;
      if (!relative || relative.split('/').some(part => part.startsWith('.'))) continue;
      files.push({ path: relative, index: state[0], workingTree: state[1], deleted: state.includes('D'), untracked: state === '??' });
    }
    const stagedOutsideProject = !!base && stagedPaths.split('\0').some(name => name && !name.startsWith(base));
    return { cwd: root, status, unstaged, staged, files, stagedOutsideProject, branch: branch.trim(), worktrees, version: createHash('sha256').update(status + unstaged + staged + rawFiles + stagedPaths).digest('hex') };
  }
  async gitAction({ cwd, action, path: relative, version, message, confirmed, branch, destination }) {
    check(!this.gitLocked, '另一个 Git 写操作仍在执行。', 409); this.gitLocked = true;
    try { return await this.performGitAction({ cwd, action, path: relative, version, message, confirmed, branch, destination }); }
    finally { this.gitLocked = false; }
  }
  async performGitAction({ cwd, action, path: relative, version, message, confirmed, branch, destination }) {
    check(confirmed === true, '请明确确认 Git 操作。');
    const current = await this.gitStatus({ cwd }); check(current.version === version, 'Git 状态已变化，请刷新差异后重试。', 409);
    if (action === 'stage' || action === 'unstage') {
      const file = await this.files.resolve(current.cwd, relative); check(relative && file.info.isFile(), '请选择单个文件，不能批量操作目录。');
      await this.git(current.cwd, action === 'stage' ? ['--literal-pathspecs', 'add', '--', relative] : ['--literal-pathspecs', 'restore', '--staged', '--', relative]);
    } else if (action === 'commit') {
      check(!current.stagedOutsideProject, '还有所选项目之外的已暂存文件，请切换到仓库根目录核对完整变更后再提交。', 409);
      check(typeof message === 'string' && message.trim() && message.length <= 1000, '请输入提交说明。');
      check(current.staged.trim(), '没有已暂存修改。');
      await this.git(current.cwd, ['-c', 'commit.gpgsign=false', 'commit', '-m', message]);
    } else if (action === 'worktree') {
      check(typeof branch === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_/-]{0,99}$/.test(branch) && !branch.includes('..'), '请输入新的分支名称。');
      check(typeof destination === 'string' && path.isAbsolute(destination) && !path.basename(destination).startsWith('.'), '请输入新的工作树绝对路径。');
      const parent = await directory(path.dirname(destination));
      await this.git(current.cwd, ['worktree', 'add', '-b', branch, path.join(parent, path.basename(destination))]);
    } else check(false, '暂不支持此 Git 写操作。');
    return this.gitStatus({ cwd: current.cwd });
  }
  async terminal({ cwd, command, writable = false, confirmed }) {
    check(confirmed === true, '请确认手动执行命令。');
    check(typeof command === 'string' && command.trim() && command.length <= 10000, '命令不能为空或过长。');
    check(typeof writable === 'boolean', '写权限选项无效。');
    check([...this.processes.values()].filter(p => p.running).length < 4, '最多同时运行 4 个命令。');
    const root = await directory(cwd), mode = writable ? 'workspace-write' : 'read-only';
    const { sandboxPolicy } = await this.workspace.permissions.resolve({ mode, cwd: root });
    const id = randomUUID(), process = { id, cwd: root, command, mode, output: '', running: true, startedAt: Date.now(), decoder: new StringDecoder('utf8') };
    for (const [key, value] of this.processes) if (!value.running && this.processes.size >= 40) this.processes.delete(key);
    this.processes.set(id, process);
    // Explicit policy: no inherited full access, no network, bounded lifetime/output.
    this.bridge.request('command/exec', { command: ['/bin/zsh', '-f', '-c', command], cwd: root, processId: id, sandboxPolicy, streamStdin: true, streamStdoutStderr: true, timeoutMs: 300000, outputBytesCap: 100000 }, 320000)
      .then(result => { process.exitCode = result.exitCode; process.output += process.decoder.end() + (result.stdout || '') + (result.stderr || ''); })
      .catch(error => { process.error = error.message; })
      .finally(() => { process.running = false; });
    return { id };
  }
  terminalList() { return [...this.processes.values()].map(({ decoder, ...data }) => data); }
  async terminalAction({ id, action, text }) {
    const process = this.processes.get(id); check(process?.running, '命令已结束。');
    if (action === 'stop') await this.bridge.request('command/exec/terminate', { processId: id });
    else { check(action === 'input' && typeof text === 'string' && text.length <= 10000, '输入无效。'); await this.bridge.request('command/exec/write', { processId: id, deltaBase64: Buffer.from(text + '\n').toString('base64') }); }
    return { ok: true };
  }
  async connections({ threadId } = {}) {
    const servers = []; let cursor = null;
    do { const result = await this.bridge.request('mcpServerStatus/list', { cursor, limit: 100, detail: 'toolsAndAuthOnly', ...(threadId ? { threadId } : {}) }); servers.push(...result.data.map(s => ({ name: s.name, authStatus: s.authStatus, tools: Object.keys(s.tools || {}) }))); cursor = result.nextCursor; } while (cursor && servers.length < 500);
    return { servers };
  }
  async connectionAction({ action, name, threadId, confirmed }) {
    check(confirmed === true, '请确认连接操作。');
    if (action === 'reload') return this.bridge.request('config/mcpServer/reload', {});
    check(action === 'login' && typeof name === 'string' && name.length <= 200, '连接操作无效。');
    const status = await this.connections({ threadId }); check(status.servers.some(s => s.name === name), '插件连接不存在。');
    const result = await this.bridge.request('mcpServer/oauth/login', { name, ...(threadId ? { threadId } : {}), timeoutSecs: 180 });
    const url = new URL(result.authorizationUrl); check(['https:', 'http:'].includes(url.protocol), '授权 URL 无效。');
    return { authorizationUrl: url.href };
  }
  async artifact({ cwd, path: relative, stamp }) {
    const file = await this.files.resolve(cwd, relative, { allowExportPreview: true, allowHidden: true }); check(file.info.isFile() && file.info.size <= 10 * 1024 * 1024, '预览/下载仅支持不超过 10 MB 的普通文件。');
    const handle = await open(file.target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(); check(info.ino === file.info.ino && info.dev === file.info.dev, '文件已变化。', 409);
      const currentStamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (stamp === currentStamp) return { unchanged: true, stamp: currentStamp };
      const buffer = Buffer.alloc(10 * 1024 * 1024 + 1); let size = 0;
      while (size < buffer.length) { const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size); if (!bytesRead) break; size += bytesRead; }
      check(size <= 10 * 1024 * 1024, '文件超过 10 MB。');
      const after = await handle.stat();
      check(info.size === after.size && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs, '文件在读取时变化，请重新打开。', 409);
      return { cwd: file.root, path: file.relative, stamp: currentStamp, name: path.basename(relative), extension: path.extname(relative).toLowerCase(), base64: buffer.subarray(0, size).toString('base64'), version: createHash('sha256').update(buffer.subarray(0, size)).digest('hex'), richPreview: true };
    } finally { await handle.close(); }
  }
  async loadJobs() {
    if (this.ready) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const data = JSON.parse(await readFile(path.join(this.stateDir, 'schedules.json'), 'utf8')); check(Array.isArray(data) && data.length <= 100, '任务配置无效。');
        this.jobs = data.map(job => {
          const schedule = normalizeSchedule(job.schedule || { kind: 'interval', minutes: job.minutes });
          if (schedule.kind === 'interval' && schedule.anchorAt == null) schedule.anchorAt = Number.isFinite(job.nextAt) ? job.nextAt : Date.now() + schedule.minutes * 60000;
          const history = (job.history || []).map(record => {
            const result = { ...record };
            if (result.status === 'preparing') result.status = 'unknown';
            if (result.worktree && ['planned', 'recycling'].includes(result.worktree.state)) result.worktree = { ...result.worktree, state: 'unknown', reason: '服务在工作树准备或回收期间中断，请核对原目录及废纸篓。' };
            return result;
          });
          return { ...job, mode: job.mode || 'read-only', model: job.model || '', effort: job.effort || '', folderId: job.folderId || null, isolateWorktree: job.isolateWorktree === true, recycleWorktree: job.recycleWorktree === true, fullAccessConfirmed: job.fullAccessConfirmed === true, history, name: job.name || job.text?.trim().slice(0, 40) || '未命名任务', schedule, scheduleRuns: job.scheduleRuns || 0, version: job.version || randomUUID(), pauseReason: job.enabled ? 'restart' : job.pauseReason, enabled: false, running: false };
        });
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.holidayCalendar.load();
      this.ready = true;
    })();
    try { await this.loading; } finally { this.loading = null; }
  }
  async persistJobs() {
    const contents = JSON.stringify(this.jobs, null, 2);
    const write = async () => { await mkdir(this.stateDir, { recursive: true, mode: 0o700 }); const temporary = path.join(this.stateDir, `schedule-${randomUUID()}.tmp`); const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(contents); } finally { await handle.close(); } await rename(temporary, path.join(this.stateDir, 'schedules.json')); };
    this.writing = this.writing.catch(() => {}).then(write);
    try { await this.writing; this.scheduleError = ''; }
    catch (error) { this.scheduleError = '定时任务状态未能保存，请检查本机存储后刷新。'; throw error; }
  }
  async schedules() {
    await this.loadJobs();
    const folders = new Map();
    await Promise.all([...new Set(this.jobs.filter(job => job.folderId).map(job => job.cwd))].map(async cwd => {
      try { folders.set(cwd, (await this.threadOrganization.list(cwd)).folders); } catch { /* Keep task/history readable when organization metadata is unavailable. */ }
    }));
    const models = this.workspace.modelCatalog?.() || [];
    return { capabilities: { workdayCalendar: true, isolatedWorktrees: true }, calendar: this.holidayCalendar.snapshot(), error: this.scheduleError || null, jobs: this.jobs.map(job => ({ ...job, modelName: models.find(model => model.id === job.model)?.name || null, folderName: folders.get(job.cwd)?.find(folder => folder.id === job.folderId)?.name || null, running: job.running || !!this.workspace.threads.get(job.lastThreadId)?.busy, history: job.history.map(record => {
      const thread = this.workspace.threads.get(record.threadId);
      const matchesTurn = record.turnId && thread?.latestTurnId === record.turnId;
      return { ...record, status: record.status === 'submitted' && matchesTurn ? (thread.busy ? 'running' : ['completed', 'failed', 'interrupted'].includes(thread.completion) ? thread.completion : 'submitted') : record.status };
    }) })), connected: this.bridge.ready };
  }
  async scheduleOptions(cwd) {
    const root = await directory(cwd);
    await this.holidayCalendar.load();
    const [models, permissions, organization] = await Promise.all([this.workspace.readModels(), this.workspace.permissions.list(), this.threadOrganization.list(root)]);
    return { cwd: root, models, permissions, folders: organization.folders, capabilities: { workdayCalendar: true, isolatedWorktrees: true }, calendar: this.holidayCalendar.snapshot() };
  }
  async refreshHolidayCalendar() { return this.holidayCalendar.refresh({ force: true }); }
  async validateScheduleExecution(settings, cwd) {
    permissionSettings(settings.mode, cwd);
    check(typeof settings.model === 'string' && settings.model.length < 150, '无效的任务模型。');
    check(typeof settings.effort === 'string' && (!settings.effort || ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(settings.effort)), '无效的推理强度。');
    await this.workspace.permissions.resolve({ ...settings, cwd });
    if (settings.model || settings.effort) {
      const models = await this.workspace.readModels();
      const selected = settings.model ? models.find(model => model.id === settings.model) : models.find(model => model.isDefault);
      check(selected, '任务模型已不可用，请编辑任务重新选择。');
      check(!settings.effort || selected.efforts.some(option => option.reasoningEffort === settings.effort), '任务模型不支持所选推理强度，请重新选择。');
    }
    check(settings.folderId === null || typeof settings.folderId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(settings.folderId), '请选择有效的会话文件夹。');
    if (settings.folderId) {
      const organization = await this.threadOrganization.list(cwd);
      check(organization.folders.some(folder => folder.id === settings.folderId), '会话文件夹已不存在，请编辑任务重新选择。', 409);
    }
    if (settings.isolateWorktree) {
      check(!settings.folderId, '隔离工作树会话属于独立目录，请将会话文件夹设为未分组。');
      await this.scheduleWorktrees.plan(cwd, 'validate');
    }
  }
  async scheduleAction({ action, id, cwd, name, text, minutes, schedule, enabled, version, confirmed, mode, model, effort, folderId, fullAccessConfirmed, isolateWorktree, recycleWorktree, recordId }) {
    await this.loadJobs(); check(confirmed === true, '请确认定时任务操作。');
    check(!this.scheduleLocked && !this.ticking, '任务状态正在更新，请稍后重试。', 409);
    this.scheduleLocked = true;
    const previous = structuredClone(this.jobs);
    try {
      let job = this.jobs.find(j => j.id === id);
      if (action !== 'create') { check(job, '任务不存在。'); check(!version || version === job.version, '任务已在其他页面修改，请刷新列表后重新编辑。', 409); }
      if (action === 'create' || action === 'update') {
        check(typeof text === 'string' && text.trim() && text.length <= 10000, '请填写任务内容（最多 10,000 字符）。');
        check(name === undefined || typeof name === 'string' && name.trim() && name.length <= 80, '请填写任务名称（最多 80 字符）。');
        check(enabled === undefined || typeof enabled === 'boolean', '启用状态无效。');
        if (action === 'create') check(this.jobs.filter(j => !j.archived).length < 50 && this.jobs.length < 100, '最多保存 50 个任务和 100 条含归档的记录。');
        else check(!job.archived && !job.running && !this.workspace.threads.get(job.lastThreadId)?.busy, '请等待任务结束，或先恢复归档任务。', 409);
        const rule = normalizeSchedule(schedule || (action === 'update' && minutes === undefined ? job.schedule : { kind: 'interval', minutes }));
        if (rule.kind === 'interval' && rule.anchorAt == null) rule.anchorAt = job?.schedule.kind === 'interval' && job.schedule.minutes === rule.minutes ? job.schedule.anchorAt : Date.now() + rule.minutes * 60000;
        const changed = action === 'create' || JSON.stringify(normalizeSchedule(rule)) !== JSON.stringify(normalizeSchedule(job.schedule));
        const scheduleRuns = changed ? 0 : job.scheduleRuns || 0;
        const isEnabled = enabled ?? (action === 'create' ? true : job.enabled);
        let nextAt;
        try { nextAt = !changed && isEnabled === job.enabled ? job.nextAt : nextScheduleAt(rule, Date.now(), scheduleRuns, this.holidayCalendar.snapshot()); }
        catch (error) { if (isEnabled || error.code !== 'HOLIDAY_CALENDAR_UNAVAILABLE') throw error; nextAt = null; }
        const awaitingCalendar = !changed && isEnabled && job?.enabled && job.pauseReason === 'calendar' && nextAt == null;
        check(!isEnabled || nextAt != null || awaitingCalendar, '执行时间已过去或已达到结束条件，请调整执行计划。');
        const root = action === 'create' ? await directory(cwd) : job.cwd;
        check(isolateWorktree === undefined || typeof isolateWorktree === 'boolean', '隔离工作树设置无效。');
        check(recycleWorktree === undefined || typeof recycleWorktree === 'boolean', '工作树回收设置无效。');
        const execution = { mode: mode ?? job?.mode ?? 'auto-review', model: model ?? job?.model ?? '', effort: effort ?? job?.effort ?? '', folderId: folderId === undefined ? job?.folderId || null : folderId, isolateWorktree: isolateWorktree ?? job?.isolateWorktree ?? false, recycleWorktree: recycleWorktree ?? job?.recycleWorktree ?? false };
        check(execution.isolateWorktree || !execution.recycleWorktree, '请先启用隔离工作树。');
        execution.fullAccessConfirmed = execution.mode === 'danger-full-access' && (fullAccessConfirmed === true || fullAccessConfirmed === undefined && job?.mode === execution.mode && job?.fullAccessConfirmed === true);
        await this.validateScheduleExecution(execution, root);
        const data = { cwd: root, ...execution, name: name?.trim() || text.trim().slice(0, 40), text: text.trim(), schedule: rule, scheduleRuns, minutes: rule.kind === 'interval' ? rule.minutes : null, enabled: isEnabled, pauseReason: isEnabled ? awaitingCalendar ? 'calendar' : null : !changed && job?.enabled === isEnabled ? job.pauseReason : 'manual', nextAt, version: randomUUID() };
        if (action === 'create') { job = { id: randomUUID(), ...data, history: [] }; this.jobs.push(job); }
        else Object.assign(job, data);
      } else if (action === 'toggle' || action === 'setEnabled') {
        check(!job.archived, '请先恢复归档任务。');
        check(action === 'toggle' || typeof enabled === 'boolean', '启用状态无效。');
        const wanted = action === 'toggle' ? !job.enabled : enabled;
        if (wanted && !job.enabled && job.isolateWorktree) check(job.history.filter(item => item.worktree && item.worktree.state !== 'trashed').length < 100, '保留的隔离工作树已达 100 个，请先处理已有运行记录。', 409);
        const nextAt = wanted && !job.enabled ? nextScheduleAt(job.schedule, Date.now(), job.scheduleRuns || 0, this.holidayCalendar.snapshot()) : job.nextAt;
        check(!wanted || nextAt != null, '执行时间已过去或已达到结束条件，请编辑后重新启用。');
        Object.assign(job, { enabled: wanted, nextAt, pauseReason: wanted ? null : 'manual', version: randomUUID() });
      } else if (action === 'archive' || action === 'restore') {
        check(!job.running && !this.workspace.threads.get(job.lastThreadId)?.busy, '任务正在执行，请结束后再归档或恢复。', 409);
        if (action === 'restore') check(this.jobs.filter(j => !j.archived).length < 50, '未归档任务已达 50 个。');
        Object.assign(job, { archived: action === 'archive', enabled: false, pauseReason: 'manual', version: randomUUID() });
      } else if (action === 'recycle-worktree') {
        const record = job.history.find(item => item.id === recordId); check(record?.worktree, '工作树记录不存在。');
        check(!job.running && !this.workspace.threads.get(record.threadId)?.busy, '会话正在执行，请稍后回收工作树。', 409);
        await this.recycleScheduleWorktree(job, record);
      } else if (action === 'restore-worktree') {
        const record = job.history.find(item => item.id === recordId); check(record?.worktree, '工作树记录不存在。');
        check(!job.running && !this.workspace.threads.get(record.threadId)?.busy, '会话正在执行，请稍后恢复工作树。', 409);
        await this.scheduleWorktrees.restore(record.worktree); job.version = randomUUID();
      } else if (action === 'run') { check(!job.archived, '请先恢复归档任务。'); check(this.bridge.ready, '助手未连接，请连接后再运行。'); await this.runJob(job); }
      else check(false, '任务操作无效。');
      await this.persistJobs();
      return this.schedules();
    } catch (error) { if (!['run', 'recycle-worktree', 'restore-worktree'].includes(action)) this.jobs = previous; throw error; }
    finally { this.scheduleLocked = false; }
  }
  async runJob(job, automatic = false) {
    check(!job.running && !this.workspace.threads.get(job.lastThreadId)?.busy, '上次任务尚未完成。', 409);
    if (job.isolateWorktree) check(job.history.filter(item => item.worktree && item.worktree.state !== 'trashed').length < 100, '保留的隔离工作树已达 100 个，请先处理已有运行记录。', 409);
    job.running = true;
    if (automatic) {
      job.scheduleRuns = (job.scheduleRuns || 0) + 1;
      try { job.nextAt = nextScheduleAt(job.schedule, Date.now(), job.scheduleRuns, this.holidayCalendar.snapshot()); if (job.nextAt == null) { job.enabled = false; job.pauseReason = 'finished'; } }
      catch (error) { if (error.code !== 'HOLIDAY_CALENDAR_UNAVAILABLE') throw error; job.nextAt = null; job.pauseReason = 'calendar'; }
    }
    job.version = randomUUID();
    const record = { id: randomUUID(), at: Date.now(), automatic, status: 'preparing' };
    job.history.unshift(record);
    try {
      await this.validateScheduleExecution(job, job.cwd);
      let runCwd = job.cwd;
      if (job.isolateWorktree) {
        record.worktree = await this.scheduleWorktrees.plan(job.cwd, job.id);
        await this.persistJobs(); // Recovery metadata exists before Git writes anything.
        runCwd = await this.scheduleWorktrees.create(record.worktree);
        await this.persistJobs(); // Never start inference until the worktree is recorded.
      }
      const result = await this.workspace.send({ text: job.text, cwd: runCwd, mode: job.mode, model: job.model || undefined, effort: job.effort, fullAccessConfirmed: job.fullAccessConfirmed }, { onThreadReady: async thread => {
        job.lastThreadId = record.threadId = thread.id;
        if (job.folderId) await this.threadOrganization.placeThread({ cwd: job.cwd, threadId: thread.id, folderId: job.folderId });
        if (record.worktree) await this.persistJobs();
      } });
      job.lastThreadId = record.threadId = result.threadId;
      const thread = this.workspace.threads.get(result.threadId);
      record.turnId ||= thread?.latestTurnId || thread?.turnId || null;
      if (record.status === 'preparing') record.status = 'submitted';
    } catch (error) { record.status = 'failed'; record.error = error.message; }
    finally {
      job.running = false;
      job.history = job.history.filter((item, index) => index < 30 || item.worktree && item.worktree.state !== 'trashed');
      if (record.status === 'completed' && job.recycleWorktree) await this.recycleScheduleWorktree(job, record).catch(() => {});
    }
  }
  async scheduledTurnCompleted(params) {
    if (!this.ready || !params?.threadId || !params.turn?.id) return;
    for (const job of this.jobs) for (const record of job.history) {
      if (record.threadId !== params.threadId || record.turnId && record.turnId !== params.turn.id || !['preparing', 'submitted'].includes(record.status)) continue;
      record.turnId = params.turn.id;
      record.status = ['completed', 'failed', 'interrupted'].includes(params.turn.status) ? params.turn.status : 'submitted';
      if (params.turn.error?.message) record.error = params.turn.error.message;
      await this.persistJobs();
      if (!job.running && record.status === 'completed' && job.recycleWorktree && record.worktree) await this.recycleScheduleWorktree(job, record).catch(() => {});
    }
  }
  async recycleScheduleWorktree(job, record) {
    const tree = record.worktree, thread = record.threadId && this.workspace.threads.get(record.threadId);
    check(tree && ['active', 'retained'].includes(tree.state), '工作树不可回收，请先核对运行记录。', 409);
    check(!record.threadId && record.status === 'failed' || record.status === 'completed' && thread?.latestTurnId === record.turnId && thread?.completion === 'completed', '未确认原任务已完成，已保留工作树。', 409);
    check(!job.running && (!record.threadId || thread && !thread.busy && !thread.queue?.length && !thread.requests?.length), '会话状态不明确或仍有待处理内容，已保留工作树。', 409);
    const locks = this.workspace.locks;
    check(!record.threadId || !locks?.has(record.threadId), '会话正在操作，请稍后再试。', 409);
    if (record.threadId) locks?.add(record.threadId);
    try {
      tree.state = 'recycling'; tree.trashPath = path.join(this.scheduleWorktrees.trashDir, `lemon-schedule-${tree.id}`);
      await this.persistJobs(); // An interrupted move retains both possible locations.
      await this.scheduleWorktrees.moveToTrash(tree);
      job.version = randomUUID(); await this.persistJobs();
    } catch (error) { tree.state = 'unknown'; tree.reason = '回收未确认，请核对原目录和废纸篓。'; await this.persistJobs().catch(() => {}); throw error; }
    finally { if (record.threadId) locks?.delete(record.threadId); }
  }
  async tick() {
    if (!this.ready || !this.bridge.ready || this.ticking || this.scheduleLocked) return;
    this.ticking = true;
    try {
      if (this.jobs.some(job => job.enabled && !job.archived && job.schedule.kind === 'workday')) await this.holidayCalendar.refresh();
      for (const job of this.jobs) {
      if (job.archived || !job.enabled) continue;
      try {
      const expired = job.schedule.endDate && Date.now() >= Date.parse(`${job.schedule.endDate}T23:59:59.999+08:00`) + 1 || job.schedule.maxRuns && job.scheduleRuns >= job.schedule.maxRuns;
      if (expired) { Object.assign(job, { enabled: false, nextAt: null, pauseReason: 'finished', version: randomUUID() }); await this.persistJobs(); continue; }
      if (job.schedule.kind === 'workday') {
        try {
          const calendar = this.holidayCalendar.snapshot(), now = Date.now();
          if (!Number.isFinite(job.nextAt) || job.nextAt <= now && (!workdayStatus(beijingDate(job.nextAt), calendar) || !workdayStatus(beijingDate(now), calendar))) {
            job.nextAt = nextScheduleAt(job.schedule, now, job.scheduleRuns || 0, calendar);
            job.pauseReason = job.nextAt == null ? 'finished' : null;
            if (job.nextAt == null) job.enabled = false;
            job.version = randomUUID(); await this.persistJobs();
          }
        } catch (error) {
          if (error.code !== 'HOLIDAY_CALENDAR_UNAVAILABLE') throw error;
          if (job.pauseReason !== 'calendar' || job.nextAt !== null) { job.nextAt = null; job.pauseReason = 'calendar'; job.version = randomUUID(); await this.persistJobs(); }
          continue;
        }
      }
      if (Number.isFinite(job.nextAt) && job.nextAt <= Date.now() && !job.running && !this.workspace.threads.get(job.lastThreadId)?.busy) {
        if (job.isolateWorktree && job.history.filter(item => item.worktree && item.worktree.state !== 'trashed').length >= 100) {
          job.scheduleRuns = (job.scheduleRuns || 0) + 1;
          job.history.unshift({ id: randomUUID(), at: Date.now(), automatic: true, status: 'failed', error: '保留的隔离工作树已达 100 个，请先处理已有运行记录，再启用任务。' });
          Object.assign(job, { enabled: false, nextAt: null, pauseReason: 'worktree_limit', version: randomUUID() });
        } else await this.runJob(job, true);
        await this.persistJobs();
      }
      } catch (error) {
        // One task must not prevent later tasks from being considered. If its
        // outcome is unclear, pause it rather than retrying a possible action.
        const message = String(error?.message || '任务状态更新失败').slice(0, 1000);
        if (job.running) job.running = false;
        if (job.pauseReason !== 'worktree_limit') {
          job.history.unshift({ id: randomUUID(), at: Date.now(), automatic: true, status: 'unknown', error: `调度异常，执行状态待核对：${message}` });
          Object.assign(job, { enabled: false, nextAt: null, pauseReason: 'error', version: randomUUID() });
        }
        // A shared persistence failure makes later launches unsafe. Retain an
        // in-memory service warning and try again on the next explicit action.
        try { await this.persistJobs(); } catch { this.scheduleError = '定时任务状态未能保存，请检查本机存储后刷新。'; break; }
      }
    } }
    finally { this.ticking = false; }
  }
  close() { clearInterval(this.timer); }
}
