import { mkdir, lstat, open, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { check, directory } from './workspace.mjs';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0;

// Store only read markers. Conversation bodies and native session files remain
// owned by the runtime. The first snapshot treats existing history as read.
export class ThreadReads {
  constructor(stateDir, { verifyThread } = {}) {
    this.root = path.join(stateDir, 'thread-reads');
    this.filename = path.join(this.root, 'state.json');
    this.verifyThread = verifyThread;
    this.queue = Promise.resolve();
    this.initialized = null;
  }
  async initialize() {
    if (!this.initialized) this.initialized = (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const info = await lstat(this.root);
      check(info.isDirectory() && !info.isSymbolicLink(), '未读状态目录不可用。', 503);
      const initial = { version: 1, revision: 0, baseline: Date.now(), globalReadAt: 0, projects: [], threads: [] };
      try { await writeFile(this.filename, JSON.stringify(initial) + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    })().catch(error => { this.initialized = null; throw error; });
    return this.initialized;
  }
  async read() {
    await this.initialize(); let file;
    try {
      file = await open(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.size > 3_000_000) throw new Error('Invalid read state');
      const value = JSON.parse(await file.readFile('utf8'));
      if (value.version !== 1 || !validTime(value.revision) || !validTime(value.baseline) || !validTime(value.globalReadAt) || !Array.isArray(value.projects) || value.projects.length > 10000 || !Array.isArray(value.threads) || value.threads.length > 10000) throw new Error('Invalid read state');
      const projects = new Set(), ids = new Set();
      for (const item of value.projects) {
        if (typeof item.cwd !== 'string' || !path.isAbsolute(item.cwd) || projects.has(item.cwd) || !validTime(item.readAt)) throw new Error('Invalid project state');
        projects.add(item.cwd);
      }
      for (const item of value.threads) {
        if (!validId(item.id) || ids.has(item.id) || typeof item.cwd !== 'string' || !path.isAbsolute(item.cwd) || !validTime(item.readAt) || !validTime(item.forcedAt)) throw new Error('Invalid thread state');
        ids.add(item.id);
      }
      return value;
    } catch (error) {
      throw Object.assign(new Error('未读状态读取失败，原记录已保留。'), { status: 503, cause: error });
    } finally { await file?.close(); }
  }
  async list() { return { ...await this.read(), now: Date.now() }; }
  async action(payload) {
    const run = async () => {
      const value = await this.read();
      check(Number.isSafeInteger(payload.revision) && payload.revision === value.revision, '未读状态已变化，请刷新后重试。', 409);
      const now = Date.now();
      if (payload.action === 'read' || payload.action === 'unread') {
        const cwd = await directory(payload.cwd);
        check(validId(payload.threadId) && await this.verifyThread?.(payload.threadId, cwd), '会话不属于所选项目或已不可用。', 409);
        let entry = value.threads.find(item => item.id === payload.threadId);
        if (!entry) { check(value.threads.length < 10000, '未读状态记录已达上限。', 409); entry = { id: payload.threadId, cwd, readAt: 0, forcedAt: 0 }; value.threads.push(entry); }
        check(entry.cwd === cwd, '会话项目已变化，请刷新后重试。', 409);
        if (payload.action === 'unread') entry.forcedAt = now;
        else {
          check(validTime(payload.seenAt), '已读时间无效。');
          entry.readAt = Math.max(entry.readAt, Math.min(payload.seenAt, now)); entry.forcedAt = 0;
        }
      } else if (payload.action === 'all-read') {
        check(validTime(payload.seenAt), '已读时间无效。');
        const at = Math.min(payload.seenAt, now), cwd = payload.allProjects === true ? null : await directory(payload.cwd);
        if (cwd === null) value.globalReadAt = Math.max(value.globalReadAt, at);
        else {
          let project = value.projects.find(item => item.cwd === cwd);
          if (!project) { check(value.projects.length < 10000, '项目状态记录已达上限。', 409); project = { cwd, readAt: 0 }; value.projects.push(project); }
          project.readAt = Math.max(project.readAt, at);
        }
        for (const item of value.threads) if ((cwd === null || item.cwd === cwd) && item.forcedAt <= at) item.forcedAt = 0;
      } else check(false, '不支持的未读操作。');
      value.revision++;
      const temp = path.join(this.root, `.${randomUUID()}.tmp`);
      try { await writeFile(temp, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temp, this.filename); }
      catch (error) { throw Object.assign(new Error('未读状态保存失败，原记录已保留。'), { status: 503, cause: error }); }
      return { ...value, now: Date.now() };
    };
    const next = this.queue.then(run, run); this.queue = next.catch(() => {}); return next;
  }
}
