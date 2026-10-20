import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { check, directory } from './workspace.mjs';
import { normalizeSchedule, nextScheduleAt } from '../public/schedule-time.js';
const execute = promisify(execFile);

export class Workbench {
  constructor(workspace, files, stateDir) {
    this.workspace = workspace; this.bridge = workspace.bridge; this.files = files; this.stateDir = stateDir;
    this.processes = new Map(); this.jobs = []; this.ready = false; this.writing = Promise.resolve();
    this.timer = setInterval(() => this.tick().catch(() => {}), 15000); this.timer.unref();
    this.bridge.on('notification', ({ method, params: p }) => {
      if (method !== 'command/exec/outputDelta') return;
      const process = this.processes.get(p.processId); if (!process) return;
      process.output = (process.output + process.decoder.write(Buffer.from(p.deltaBase64, 'base64'))).slice(-100000);
      process.truncated ||= p.capReached;
    });
    this.bridge.on('offline', () => { for (const process of this.processes.values()) if (process.running) { process.running = false; process.error = '连接断开，无法确认进程状态。'; } });
  }
  async git(cwd, args) {
    const root = await directory(cwd);
    try { return (await execute('git', ['--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', ...args], { cwd: root, maxBuffer: 2 * 1024 * 1024, timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })).stdout; }
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
          return { ...job, name: job.name || job.text?.trim().slice(0, 40) || '未命名任务', schedule, scheduleRuns: job.scheduleRuns || 0, version: job.version || randomUUID(), pauseReason: job.enabled ? 'restart' : job.pauseReason, enabled: false, running: false };
        });
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.ready = true;
    })();
    try { await this.loading; } finally { this.loading = null; }
  }
  async persistJobs() {
    const contents = JSON.stringify(this.jobs, null, 2);
    const write = async () => { await mkdir(this.stateDir, { recursive: true, mode: 0o700 }); const temporary = path.join(this.stateDir, `schedule-${randomUUID()}.tmp`); const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(contents); } finally { await handle.close(); } await rename(temporary, path.join(this.stateDir, 'schedules.json')); };
    this.writing = this.writing.catch(() => {}).then(write); return this.writing;
  }
  async schedules() {
    await this.loadJobs();
    return { jobs: this.jobs.map(job => ({ ...job, running: job.running || !!this.workspace.threads.get(job.lastThreadId)?.busy, history: job.history.map(record => {
      const thread = this.workspace.threads.get(record.threadId);
      const matchesTurn = record.turnId && thread?.latestTurnId === record.turnId;
      return { ...record, status: record.status === 'submitted' && matchesTurn ? (thread.busy ? 'running' : ['completed', 'failed', 'interrupted'].includes(thread.completion) ? thread.completion : 'submitted') : record.status };
    }) })), connected: this.bridge.ready };
  }
  async scheduleAction({ action, id, cwd, name, text, minutes, schedule, enabled, version, confirmed }) {
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
        const nextAt = !changed && isEnabled === job.enabled ? job.nextAt : nextScheduleAt(rule, Date.now(), scheduleRuns);
        check(!isEnabled || nextAt != null, '执行时间已过去或已达到结束条件，请调整执行计划。');
        const root = action === 'create' ? await directory(cwd) : job.cwd;
        const data = { cwd: root, name: name?.trim() || text.trim().slice(0, 40), text: text.trim(), schedule: rule, scheduleRuns, minutes: rule.kind === 'interval' ? rule.minutes : null, enabled: isEnabled, pauseReason: isEnabled ? null : !changed && job?.enabled === isEnabled ? job.pauseReason : 'manual', nextAt, version: randomUUID() };
        if (action === 'create') { job = { id: randomUUID(), ...data, history: [] }; this.jobs.push(job); }
        else Object.assign(job, data);
      } else if (action === 'toggle' || action === 'setEnabled') {
        check(!job.archived, '请先恢复归档任务。');
        check(action === 'toggle' || typeof enabled === 'boolean', '启用状态无效。');
        const wanted = action === 'toggle' ? !job.enabled : enabled;
        const nextAt = wanted && !job.enabled ? nextScheduleAt(job.schedule, Date.now(), job.scheduleRuns || 0) : job.nextAt;
        check(!wanted || nextAt != null, '执行时间已过去或已达到结束条件，请编辑后重新启用。');
        Object.assign(job, { enabled: wanted, nextAt, pauseReason: wanted ? null : 'manual', version: randomUUID() });
      } else if (action === 'archive' || action === 'restore') {
        check(!job.running && !this.workspace.threads.get(job.lastThreadId)?.busy, '任务正在执行，请结束后再归档或恢复。', 409);
        if (action === 'restore') check(this.jobs.filter(j => !j.archived).length < 50, '未归档任务已达 50 个。');
        Object.assign(job, { archived: action === 'archive', enabled: false, pauseReason: 'manual', version: randomUUID() });
      } else if (action === 'run') { check(!job.archived, '请先恢复归档任务。'); check(this.bridge.ready, '助手未连接，请连接后再运行。'); await this.runJob(job); }
      else check(false, '任务操作无效。');
      await this.persistJobs();
      return this.schedules();
    } catch (error) { if (action !== 'run') this.jobs = previous; throw error; }
    finally { this.scheduleLocked = false; }
  }
  async runJob(job, automatic = false) {
    check(!job.running && !this.workspace.threads.get(job.lastThreadId)?.busy, '上次任务尚未完成。', 409);
    job.running = true;
    if (automatic) { job.scheduleRuns = (job.scheduleRuns || 0) + 1; job.nextAt = nextScheduleAt(job.schedule, Date.now(), job.scheduleRuns); if (job.nextAt == null) { job.enabled = false; job.pauseReason = 'finished'; } }
    job.version = randomUUID();
    try {
      const result = await this.workspace.send({ text: job.text, cwd: job.cwd, mode: 'read-only' });
      job.lastThreadId = result.threadId; job.history.unshift({ at: Date.now(), automatic, threadId: result.threadId, turnId: this.workspace.threads.get(result.threadId)?.latestTurnId || null, status: 'submitted' });
    } catch (error) { job.history.unshift({ at: Date.now(), automatic, status: 'failed', error: error.message }); }
    finally { job.running = false; job.history = job.history.slice(0, 30); }
  }
  async tick() {
    if (!this.ready || !this.bridge.ready || this.ticking || this.scheduleLocked) return;
    this.ticking = true;
    try { for (const job of this.jobs) {
      if (job.archived || !job.enabled) continue;
      const expired = job.schedule.endDate && Date.now() >= Date.parse(`${job.schedule.endDate}T23:59:59.999+08:00`) + 1 || job.schedule.maxRuns && job.scheduleRuns >= job.schedule.maxRuns;
      if (expired) { Object.assign(job, { enabled: false, nextAt: null, pauseReason: 'finished', version: randomUUID() }); await this.persistJobs(); continue; }
      if (Number.isFinite(job.nextAt) && job.nextAt <= Date.now() && !job.running && !this.workspace.threads.get(job.lastThreadId)?.busy) { await this.runJob(job, true); await this.persistJobs(); }
    } }
    finally { this.ticking = false; }
  }
  close() { clearInterval(this.timer); }
}
