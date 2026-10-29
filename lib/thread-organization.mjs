import { mkdir, lstat, open, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { check, directory } from './workspace.mjs';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const folderName = value => {
  check(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 60 && !/[\x00-\x1f\x7f]/.test(value), '文件夹名称需要 1–60 个字符。');
  return value.trim().normalize('NFC');
};
const empty = cwd => ({ version: 1, cwd, revision: 0, folders: [], threads: [] });

// Only organization metadata lives here. Native threads, working directories,
// permissions and conversation content remain owned by the Codex runtime.
export class ThreadOrganization {
  constructor(stateDir, { verifyThread } = {}) {
    this.root = path.join(stateDir, 'thread-organization');
    this.verifyThread = verifyThread;
    this.queues = new Map();
  }

  filename(cwd) { return path.join(this.root, createHash('sha256').update(cwd).digest('hex') + '.json'); }

  async read(cwd) {
    let handle;
    try {
      const parent = await lstat(this.root);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Invalid metadata directory');
      handle = await open(this.filename(cwd), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 2_000_000) throw new Error('Invalid metadata file');
      const value = JSON.parse(await handle.readFile('utf8'));
      if (value.version !== 1 || value.cwd !== cwd || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.folders) || value.folders.length > 100 || !Array.isArray(value.threads) || value.threads.length > 10000) throw new Error('Invalid metadata');
      const folders = new Set(), names = new Set(), threads = new Set();
      for (const item of value.folders) {
        const name = folderName(item.name).toLocaleLowerCase();
        if (!validId(item.id) || folders.has(item.id) || names.has(name)) throw new Error('Invalid folder');
        folders.add(item.id); names.add(name);
      }
      for (const item of value.threads) {
        if (!validId(item.id) || threads.has(item.id) || typeof item.pinned !== 'boolean' || !(item.folderId === null || folders.has(item.folderId))) throw new Error('Invalid thread metadata');
        threads.add(item.id);
      }
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return empty(cwd);
      throw Object.assign(new Error('会话分组信息读取失败，已保留原文件，请检查后重试。'), { status: 503, cause: error });
    } finally { await handle?.close(); }
  }

  async list(cwd) { return this.read(await directory(cwd)); }

  // Scheduler placement shares the per-project write queue and validates the
  // folder at commit time; unrelated edits must not lose the new assignment.
  async placeThread(payload) { return this.action({ ...payload, action: 'move' }, { requireRevision: false }); }

  async action(payload, { requireRevision = true } = {}) {
    const cwd = await directory(payload.cwd);
    const run = async () => {
      const value = await this.read(cwd);
      check(!requireRevision || Number.isSafeInteger(payload.revision) && payload.revision === value.revision, '会话分组已在其他页面更新，请刷新后再操作。', 409);
      const findFolder = id => {
        const folder = value.folders.find(item => item.id === id);
        check(folder, '文件夹已不存在，请刷新后再选择。', 409); return folder;
      };
      const name = except => {
        const result = folderName(payload.name);
        check(!value.folders.some(item => item.id !== except && item.name.toLocaleLowerCase() === result.toLocaleLowerCase()), '已有同名文件夹。'); return result;
      };
      const ensureThread = async id => {
        check(validId(id), '无效的会话。');
        check(await this.verifyThread?.(id, cwd), '会话不属于当前项目或已不可用。', 409);
        let entry = value.threads.find(item => item.id === id);
        if (!entry) { check(value.threads.length < 10000, '会话分组记录已达上限。'); entry = { id, folderId: null, pinned: false }; value.threads.push(entry); }
        return entry;
      };
      if (payload.action === 'create-folder') {
        check(value.folders.length < 100, '每个项目最多创建 100 个会话文件夹。');
        value.folders.push({ id: randomUUID(), name: name() });
      } else if (payload.action === 'rename-folder') {
        findFolder(payload.folderId).name = name(payload.folderId);
      } else if (payload.action === 'remove-folder') {
        findFolder(payload.folderId);
        value.folders = value.folders.filter(item => item.id !== payload.folderId);
        for (const item of value.threads) if (item.folderId === payload.folderId) item.folderId = null;
      } else if (payload.action === 'move' || payload.action === 'move-many') {
        check(payload.folderId === null || validId(payload.folderId), '请选择目标文件夹。');
        if (payload.folderId !== null) findFolder(payload.folderId);
        const ids = payload.action === 'move-many' ? payload.threadIds : [payload.threadId];
        check(Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && ids.every(validId) && new Set(ids).size === ids.length, '每次请选择 1–100 个不同的会话。');
        const entries = [];
        // Validate every member before committing one snapshot. A failed
        // membership check must never leave a partially moved batch on disk.
        for (const id of ids) entries.push(await ensureThread(id));
        for (const entry of entries) entry.folderId = payload.folderId;
      } else if (payload.action === 'pin') {
        check(typeof payload.pinned === 'boolean', '请选择置顶状态。');
        (await ensureThread(payload.threadId)).pinned = payload.pinned;
      } else if (payload.action === 'import-pins') {
        check(Array.isArray(payload.threadIds) && payload.threadIds.length <= 100 && payload.threadIds.every(validId), '旧置顶记录无效。');
        for (const id of new Set(payload.threadIds)) {
          // Explicit unpin/move records take precedence over old browser state.
          if (value.threads.some(item => item.id === id)) continue;
          (await ensureThread(id)).pinned = true;
        }
      } else check(false, '不支持的会话分组操作。');
      value.revision++;
      const temporary = path.join(this.root, `.${randomUUID()}.tmp`);
      try {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const parent = await lstat(this.root);
        check(parent.isDirectory() && !parent.isSymbolicLink(), '会话分组存储目录不可用。', 503);
        await writeFile(temporary, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, this.filename(cwd));
      } catch (error) {
        // Leave any failed temporary write in this ignored state directory;
        // never delete user files or replace the last valid snapshot on failure.
        throw Object.assign(new Error('会话分组保存失败，请重试。'), { status: 503, cause: error });
      }
      return value;
    };
    const pending = (this.queues.get(cwd) || Promise.resolve()).then(run, run);
    this.queues.set(cwd, pending);
    try { return await pending; }
    finally { if (this.queues.get(cwd) === pending) this.queues.delete(cwd); }
  }
}
