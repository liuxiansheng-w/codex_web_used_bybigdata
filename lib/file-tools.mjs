import { open, mkdir, lstat, rename, copyFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from './workspace.mjs';

// All traversal and reads reuse the editor's exclusions and symlink boundary.
export class FileTools {
  constructor(files, { trash = path.join(homedir(), '.Trash') } = {}) {
    this.files = files; this.trash = trash; this.previews = new Map(); this.locked = false; this.searches = new Map();
    this.searchTimer = setInterval(() => { for (const session of this.searches.values()) if (!session.busy && session.expires < Date.now()) void this.closeSearch(session); }, 30000);
    this.searchTimer.unref();
  }
  async closeSearch(session) { this.searches.delete(session.id); await session.iterator.return().catch(() => {}); }
  async close() { clearInterval(this.searchTimer); await Promise.allSettled([...this.searches.values()].map(session => this.closeSearch(session))); }
  async searchNames({ cwd, query, caseSensitive, cursor, signal }) {
    const root = (await this.files.resolve(cwd)).root;
    let session;
    if (cursor) {
      check(typeof cursor === 'string' && cursor.length < 100, '搜索分页参数无效。');
      session = this.searches.get(cursor.split(':')[0]);
      check(session && session.expires > Date.now(), '搜索进度已过期，请重新搜索。', 409);
      check(session.root === root && session.query === query && session.caseSensitive === caseSensitive, '搜索条件已变化，请重新搜索。', 409);
      if (session.lastCursor === cursor) return session.lastResult;
      if (session.busy && session.pendingCursor === cursor) return session.busy;
      check(cursor === `${session.id}:${session.page}`, '搜索页已变化，请重新搜索。', 409);
    } else {
      for (const old of this.searches.values()) if (!old.busy && old.expires < Date.now()) await this.closeSearch(old);
      if (this.searches.size >= 12) {
        const oldest = [...this.searches.values()].filter(item => !item.busy).sort((a, b) => a.expires - b.expires)[0];
        check(oldest, '搜索请求较多，请稍后重试。', 429); await this.closeSearch(oldest);
      }
      session = { id: randomUUID(), root, query, caseSensitive, iterator: this.files.walk(root), page: 0, scanned: 0, skipped: 0, matches: 0 };
      this.searches.set(session.id, session); cursor = `${session.id}:0`;
    }
    session.expires = Date.now() + 300000; session.pendingCursor = cursor;
    session.busy = (async () => {
      const results = [], deadline = Date.now() + 300, needle = caseSensitive ? query : query.toLowerCase(); let done = false, steps = 0;
      try {
        // These are per-response work budgets, never a project scan limit.
        while (steps < 2000 && results.length < 200 && (steps === 0 || Date.now() < deadline)) {
          signal?.throwIfAborted();
          const next = await session.iterator.next(); signal?.throwIfAborted();
          if (next.done) { done = true; break; }
          steps++; session.scanned++;
          const entry = next.value;
          if (entry?.unavailable) { session.skipped++; continue; }
          if (entry?.kind !== 'file') continue;
          if ((caseSensitive ? entry.path : entry.path.toLowerCase()).includes(needle)) { results.push({ path: entry.path, line: 1, text: entry.path }); session.matches++; }
        }
        session.page++;
        const result = { cwd: root, results, scanned: session.scanned, matched: session.matches, skipped: session.skipped, limited: false, complete: done, nextCursor: done ? null : `${session.id}:${session.page}` };
        session.lastCursor = cursor; session.lastResult = result; session.expires = Date.now() + 300000;
        return result;
      } catch (error) { await this.closeSearch(session); throw error; }
    })();
    try { return await session.busy; } finally { session.busy = null; }
  }
  async search({ cwd, query, filenames = false, caseSensitive = false, cursor, signal }) {
    check(typeof query === 'string' && query.length > 0 && query.length <= 500, '搜索内容须为 1–500 个字符。');
    if (filenames) return this.searchNames({ cwd, query, caseSensitive, cursor, signal });
    const root = (await this.files.resolve(cwd)).root, queue = [''], results = [];
    let scanned = 0, bytes = 0, limited = false; const deadline = Date.now() + 6000;
    const needle = caseSensitive ? query : query.toLowerCase();
    const includes = text => (caseSensitive ? text : text.toLowerCase()).includes(needle);
    while (queue.length && !limited) {
      const folder = queue.shift(); let offset = 0;
      do {
        const page = await this.files.list({ cwd: root, path: folder, offset });
        limited ||= page.limited;
        for (const entry of page.entries) {
          if (++scanned > 4000 || bytes > 24 * 1024 * 1024 || results.length >= 500 || Date.now() > deadline) { limited = true; break; }
          if (entry.kind === 'folder') { queue.push(entry.path); continue; }
          try {
            const file = await this.files.read({ cwd: root, path: entry.path }); bytes += Buffer.byteLength(file.content);
            for (const [i, line] of file.content.split('\n').entries()) if (includes(line)) {
              results.push({ path: file.path, line: i + 1, text: line.slice(0, 600), version: file.version });
              if (results.length >= 500) { limited = true; break; }
            }
          } catch (error) { if (![403, 404, 409, 413, 415].includes(error.status)) throw error; }
        }
        offset = page.nextOffset;
      } while (offset != null && !limited);
    }
    return { cwd: root, results, scanned, limited };
  }
  async previewReplace({ cwd, query, replacement, paths }) {
    check(typeof query === 'string' && query.length > 0 && query.length <= 500, '请输入替换目标。');
    check(typeof replacement === 'string' && replacement.length <= 10000, '替换文本过长。');
    check(Array.isArray(paths) && paths.length > 0 && paths.length <= 100, '一次最多替换 100 个文件。');
    const files = [];
    for (const relative of new Set(paths)) {
      const file = await this.files.read({ cwd, path: relative });
      const count = file.content.split(query).length - 1;
      if (count) { const content = file.content.replaceAll(query, replacement); check(Buffer.byteLength(content) <= 1024 * 1024, '替换后的文件超过 1 MB。'); files.push({ ...file, content, count, before: file.content }); check(files.reduce((n, f) => n + f.content.length + f.before.length, 0) <= 8_000_000, '预览过大，请减少选择的文件。'); }
    }
    for (const [key, value] of this.previews) if (value.expires < Date.now()) this.previews.delete(key);
    check(this.previews.size < 8, '替换预览过多，请等待旧预览过期。', 429);
    check(files.reduce((n, f) => n + f.content.length + f.before.length, 0) <= 8_000_000, '预览过大，请减少选择的文件。');
    const id = randomUUID(); this.previews.set(id, { files, expires: Date.now() + 300000 });
    return { id, files: files.map(({ path, count, before, content }) => ({ path, count, before, after: content })) };
  }
  async applyReplace({ id, confirmed }) {
    check(confirmed === true, '请确认替换预览。');
    const preview = this.previews.get(id); check(preview && preview.expires > Date.now(), '预览已过期，请重新搜索。', 409);
    check(!this.locked, '文件操作正在执行。', 409); this.locked = true;
    const saved = [];
    try {
      // Preflight every file before writing any. External edits during the batch
      // still cause a partial result; never claim a multi-file atomic transaction.
      for (const file of preview.files) check((await this.files.read(file)).version === file.version, `${file.path} 已变化，请重新预览。`, 409);
      for (const file of preview.files) { await this.files.save(file); saved.push(file.path); }
      this.previews.delete(id); return { saved };
    } catch (error) { return { saved, error: error.message, partial: saved.length > 0 }; }
    finally { this.locked = false; }
  }
  async destination(cwd, relative) {
    check(typeof relative === 'string' && relative.length < 4096 && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.includes('\0'), '目标路径无效。');
    const parts = relative.split('/'), name = parts.pop();
    check(name && !name.startsWith('.') && !['node_modules', '__pycache__'].includes(name), '不能创建隐藏或依赖项。');
    const parent = await this.files.resolve(cwd, parts.join('/')); check(parent.info.isDirectory(), '目标父目录不是文件夹。');
    // Validate root exclusions through the same resolver, even for missing names.
    try { await this.files.resolve(cwd, relative); throw Object.assign(new Error('目标已存在，未覆盖。'), { status: 409 }); }
    catch (error) { if (error.status !== 404) throw error; }
    return path.join(parent.target, name);
  }
  async mutate({ cwd, action, path: relative, target, version, confirmed }) {
    check(!this.locked, '文件操作正在执行。', 409); this.locked = true;
    try {
      if (action === 'createFile' || action === 'createFolder') {
        const destination = await this.destination(cwd, relative);
        if (action === 'createFolder') await mkdir(destination);
        else { const handle = await open(destination, 'wx', 0o600); await handle.close(); }
        return { path: relative };
      }
      check(['move', 'trash'].includes(action) && confirmed === true, '请明确确认移动或移入废纸篓。');
      check(relative && relative !== '.', '不能操作项目根目录。');
      const file = await this.files.snapshot(cwd, relative);
      check(file.version === version, '文件版本已变化，请重新打开后操作。', 409);
      check(file.info.nlink === 1, '不支持移动硬链接文件。');
      const destination = action === 'move' ? await this.destination(cwd, target) : null;
      await mkdir(this.trash, { recursive: true, mode: 0o700 });
      check(!(await lstat(this.trash)).isSymbolicLink(), '废纸篓不能是符号链接。');
      const recovery = path.join(await realpath(this.trash), `codex-${randomUUID()}-${path.basename(relative)}`);
      if (destination) await copyFile(file.target, destination, constants.COPYFILE_EXCL);
      const latest = await this.files.snapshot(cwd, relative);
      check(latest.version === version, '源文件已变化，未移除源文件；新建的副本可能仍在目标目录。', 409);
      await rename(file.target, recovery);
      return { path: target || relative, recovery, message: action === 'move' ? '文件已移动，原文件备份在废纸篓。' : '文件已移入废纸篓，可从 Finder 恢复。' };
    } finally { this.locked = false; }
  }
}
