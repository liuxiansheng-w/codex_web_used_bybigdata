import { lstat, opendir, realpath, open, rename, mkdtemp, chmod, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { check, directory } from './workspace.mjs';

// Repository exclusions from AGENTS.md. Never traverse these directories.
const excludedRoots = new Set(['祥誉-交接', 'zyhl_to_policyskilltask', '旧版工作流', '待删除', '业务流程', 'AIdata', 'openclaw']);
const excludedNames = new Set(['node_modules', '__pycache__']);
const hidden = (part, index) => part.startsWith('.') || excludedNames.has(part) || (index === 0 && excludedRoots.has(part));
const inside = (root, target) => target === root || (!path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target)));
const collator = new Intl.Collator('zh-CN', { numeric: true });
const pageSize = 200, scanLimit = 10000;
const maxTextBytes = 1024 * 1024;
const identity = info => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
const versionOf = (bytes, info) => createHash('sha256').update(identity(info)).update(bytes).digest('hex');

function decodeText(bytes) {
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw Object.assign(new Error('仅支持 UTF-8 文本文件；该文件可能是二进制或使用了其他编码。'), { status: 415 }); }
  check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content), '该文件包含二进制内容，不能作为文本编辑。', 415);
  const bom = content.startsWith('\uFEFF'); if (bom) content = content.slice(1);
  const crlf = content.includes('\r\n');
  const mixed = content.replaceAll('\r\n', '').includes('\n') && crlf;
  check(!content.replaceAll('\r\n', '').includes('\r') && !mixed, '文件包含混合或旧式换行，请在本机编辑器中编辑，避免改变原格式。', 415);
  return { content: content.replaceAll('\r\n', '\n'), bom, newline: crlf ? 'CRLF' : 'LF' };
}

export class ProjectFiles {
  saving = new Set();

  async snapshot(cwd, relative) {
    const resolved = await this.resolve(cwd, relative);
    check(resolved.info.isFile(), '请选择普通文本文件。');
    check(resolved.info.size <= maxTextBytes, '文件超过 1 MB，请使用本机编辑器。', 413);
    const handle = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      check(before.isFile() && before.dev === resolved.info.dev && before.ino === resolved.info.ino, '文件已发生变化，请重新打开。', 409);
      check(before.size <= maxTextBytes, '文件超过 1 MB，请使用本机编辑器。', 413);
      const buffer = Buffer.alloc(maxTextBytes + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      check(length <= maxTextBytes, '文件超过 1 MB，请使用本机编辑器。', 413);
      const after = await handle.stat();
      check(identity(before) === identity(after), '读取时文件被外部修改，请重新打开。', 409);
      const bytes = buffer.subarray(0, length), format = decodeText(bytes);
      return { ...resolved, info: after, ...format, version: versionOf(bytes, after) };
    } finally { await handle.close(); }
  }

  publicText(file) {
    const writable = !!(file.info.mode & 0o222) && !(file.info.mode & 0o7000) && file.info.nlink === 1;
    return { cwd: file.root, path: file.relative, content: file.content, version: file.version, newline: file.newline, bom: file.bom, writable, readOnlyReason: writable ? '' : '该文件为只读、有特殊权限或具有硬链接，请使用本机编辑器。' };
  }

  async read({ cwd, path: relative }) { return this.publicText(await this.snapshot(cwd, relative)); }

  async save({ cwd, path: relative, content, version }) {
    check(typeof content === 'string' && Buffer.byteLength(content, 'utf8') <= maxTextBytes, '内容超过 1 MB 或格式无效。', 413);
    check(typeof version === 'string' && /^[a-f0-9]{64}$/.test(version), '缺少有效文件版本，请重新打开文件。');
    const resolved = await this.resolve(cwd, relative);
    check(!this.saving.has(resolved.target), '文件正在保存，请稍后重试。', 409);
    this.saving.add(resolved.target);
    let temporary;
    try {
      const original = await this.snapshot(cwd, relative);
      check(original.version === version, '文件已被外部修改，未覆盖磁盘内容。请对照磁盘版本后重新载入。', 409);
      check(this.publicText(original).writable, '文件为只读、有特殊权限或具有硬链接，不能保存。', 403);
      try { await access(original.target, constants.W_OK); }
      catch { throw Object.assign(new Error('当前账户没有该文件的写入权限。'), { status: 403 }); }
      const normalized = content.replaceAll('\r\n', '\n');
      check(!normalized.includes('\r') && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized), '不能保存二进制控制字符或旧式换行。', 415);
      const text = (original.bom ? '\uFEFF' : '') + (original.newline === 'CRLF' ? normalized.replaceAll('\n', '\r\n') : normalized);
      const bytes = Buffer.from(text, 'utf8');
      check(bytes.toString('utf8') === text, '文本包含无法编码为 UTF-8 的字符。', 415);
      check(bytes.length <= maxTextBytes, '保存后的文件超过 1 MB。', 413);
      if (normalized === original.content) return this.publicText(original);
      // Keep the previous disk version before any write, including restores.
      await this.beforeSave?.(this.publicText(original));
      temporary = path.join(path.dirname(original.target), `.codex-edit-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.chmod(original.info.mode & 0o777); await handle.sync(); }
      finally { await handle.close(); }
      // Optimistic conflict detection, including another browser and external editors.
      const latest = await this.snapshot(cwd, relative);
      check(latest.version === version && latest.target === original.target, '保存前文件被外部修改，未覆盖磁盘内容。', 409);
      await rename(temporary, original.target); temporary = null;
      return await this.read({ cwd, path: relative });
    } finally {
      this.saving.delete(resolved.target);
      if (temporary) {
        // Keep failed staged writes recoverable instead of deleting user content.
        await chmod(temporary, 0o600).catch(() => {});
        try { const recovery = await mkdtemp(path.join(tmpdir(), 'codex-desk-unsaved-')); await rename(temporary, path.join(recovery, 'draft.txt')); } catch {}
      }
    }
  }

  async resolve(cwd, relative = '', { allowExportPreview = false } = {}) {
    const root = await directory(cwd);
    check(typeof relative === 'string' && relative.length < 4096 && !relative.includes('\\') && !relative.includes('\0') && !path.isAbsolute(relative), '项目路径无效。');
    const parts = relative ? relative.split('/') : [];
    check(parts.every(part => part && part !== '.' && part !== '..'), '不能访问项目之外的路径。', 403);
    // AIdata exports can be opened explicitly as spreadsheets. This exception
    // belongs only to read-only artifact preview, never browsing, search or edits.
    const exportPreview = allowExportPreview && parts[0] === 'AIdata' && /\.(xlsx|xls|xlsm)$/i.test(parts.at(-1) || '');
    check(!parts.some((part, index) => hidden(part, index) && !(exportPreview && index === 0)), '该路径属于隐藏、依赖、缓存或项目排除项。', 403);
    let target = root;
    try {
      // Do not follow even in-project symlinks: they can lead into excluded trees.
      for (const part of parts) {
        target = path.join(target, part);
        check(!(await lstat(target)).isSymbolicLink(), '文件树不跟随符号链接。', 403);
      }
      const resolved = await realpath(target);
      check(inside(root, resolved), '不能访问项目之外的路径。', 403);
      const info = await lstat(resolved);
      check(info.isDirectory() || info.isFile(), '只支持普通文件和文件夹。');
      return { root, relative, target: resolved, info };
    } catch (error) {
      if (error.status) throw error;
      throw Object.assign(new Error('文件或文件夹已移动、被删除，或没有访问权限。请刷新文件树。'), { status: 404 });
    }
  }

  async list({ cwd, path: relative = '', offset = 0 }) {
    check(Number.isInteger(offset) && offset >= 0 && offset < scanLimit, '分页参数无效。');
    const { root, target, info } = await this.resolve(cwd, relative);
    check(info.isDirectory(), '请选择文件夹。');
    const entries = []; let scanned = 0, limited = false;
    try {
      for await (const entry of await opendir(target)) {
        if (++scanned > scanLimit) { limited = true; break; }
        const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
        if (entryPath.split('/').some(hidden) || (!entry.isDirectory() && !entry.isFile())) continue;
        entries.push({ name: entry.name, path: entryPath, kind: entry.isDirectory() ? 'folder' : 'file' });
      }
    } catch { throw Object.assign(new Error('无法读取该目录，请检查访问权限后重试。'), { status: 403 }); }
    entries.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || collator.compare(a.name, b.name));
    return { cwd: root, path: relative, entries: entries.slice(offset, offset + pageSize), nextOffset: offset + pageSize < entries.length ? offset + pageSize : null, limited };
  }

  // Search streams directory entries without the browsing list's scan ceiling.
  // Keep only one directory handle open, and apply the same exclusions before
  // queueing directories. Re-resolve each folder before opening it.
  async *walk(cwd) {
    const root = (await this.resolve(cwd)).root, folders = [''];
    while (folders.length) {
      const relative = folders.pop();
      try {
        const { target, info } = await this.resolve(root, relative);
        check(info.isDirectory(), '请选择文件夹。');
        for await (const entry of await opendir(target)) {
          const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
          if (entryPath.split('/').some(hidden) || (!entry.isDirectory() && !entry.isFile())) { yield null; continue; }
          if (entry.isDirectory()) folders.push(entryPath);
          yield { name: entry.name, path: entryPath, kind: entry.isDirectory() ? 'folder' : 'file' };
        }
      } catch (error) {
        if (!relative) throw error;
        yield { unavailable: true };
      }
    }
  }

  async attach(context, { cwd, path: relative }) {
    check(typeof relative === 'string' && relative.length > 0, '请选择项目中的文件或子目录。');
    const { root, target, info } = await this.resolve(cwd, relative);
    return context.registerReference(target, info, { name: relative, projectRoot: root, projectPath: relative });
  }
}
