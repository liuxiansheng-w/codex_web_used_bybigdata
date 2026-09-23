import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { applyPatch, parsePatch, reversePatch, createTwoFilesPatch } from 'diff';
import { check, directory } from './workspace.mjs';
import { projectPath } from '../public/task-results.js';

export class FileHistory {
  constructor(files, tools, workspace, stateDir) {
    Object.assign(this, { files, tools, workspace });
    this.location = path.join(stateDir, 'file-history.json'); this.queue = Promise.resolve(); this.previews = new Map();
    files.beforeSave = file => this.record(file);
  }
  async read() {
    try { const rows = JSON.parse(await readFile(this.location, 'utf8')); check(Array.isArray(rows), '文件历史格式异常。'); return rows; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  record(file) {
    const operation = this.queue.then(async () => {
      const rows = await this.read(), previous = rows.find(row => row.cwd === file.cwd && row.path === file.path);
      if (previous?.content === file.content) return;
      rows.unshift({ id: randomUUID(), cwd: file.cwd, path: file.path, content: file.content, at: Date.now() });
      let bytes = 0; const counts = new Map(), kept = rows.filter(row => {
        const key = JSON.stringify([row.cwd, row.path]), count = (counts.get(key) || 0) + 1; counts.set(key, count);
        bytes += Buffer.byteLength(row.content || ''); return count <= 20 && bytes <= 24 * 1024 * 1024;
      }).slice(0, 100);
      await mkdir(path.dirname(this.location), { recursive: true, mode: 0o700 });
      const staged = `${this.location}.tmp`;
      await writeFile(staged, JSON.stringify(kept), { mode: 0o600 }); await rename(staged, this.location);
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  async current(cwd, relative) {
    try { return await this.files.read({ cwd, path: relative }); }
    catch (error) { if (error.status !== 404) throw error; await this.tools.destination(cwd, relative); return { cwd: (await this.files.resolve(cwd)).root, path: relative, content: '', version: null, writable: true }; }
  }
  async list({ cwd, path: relative }) {
    const file = await this.current(cwd, relative); await this.queue;
    return { cwd: file.cwd, path: relative, versions: (await this.read()).filter(row => row.cwd === file.cwd && row.path === relative).map(({ id, at, content }) => ({ id, at, bytes: Buffer.byteLength(content) })) };
  }
  async idle(cwd) {
    for (const thread of this.workspace.threads.values()) if (thread.busy || thread.requests?.length) {
      const root = await directory(thread.cwd).catch(() => thread.cwd);
      if (root === cwd) {
        const current = thread.parentThreadId ? await this.workspace.get(thread.id) : thread;
        check(!current.busy && !current.requests?.length, '当前项目仍有 AI 任务或审批，请等任务结束再恢复文件。', 409);
      }
    }
  }
  async preview({ cwd, path: relative, source, revisionId, threadId, itemId }) {
    const current = await this.current(cwd, relative); await this.idle(current.cwd);
    check(current.writable, '此文件为只读，无法恢复。', 403);
    let content, remove = false, label;
    if (source === 'history') {
      await this.queue;
      const revision = (await this.read()).find(row => row.id === revisionId && row.cwd === current.cwd && row.path === relative);
      check(revision, '这份文件历史已过期，请刷新列表。', 404);
      content = revision.content; label = `恢复到 ${new Date(revision.at).toLocaleString('zh-CN')}`;
    } else {
      check(source === 'ai', '恢复来源无效。');
      const thread = await this.workspace.get(threadId);
      check(await directory(thread.cwd) === current.cwd, '修改记录与项目不匹配。', 403);
      const item = thread.items.find(i => i.id === itemId && i.type === 'fileChange' && i.status === 'completed');
      const change = item?.changes.find(c => projectPath(c.path, current.cwd) === relative);
      check(change && !change.movePath, '没有可恢复的修改记录；重命名请在文件管理中处理。');
      check(change.diff?.length && change.diff.length <= 1024 * 1024, '差异记录不完整或过大，无法安全恢复。');
      let patches;
      try { patches = parsePatch(change.diff); } catch { check(false, '无法解析这份差异记录，请使用保存历史恢复。'); }
      check(patches.length === 1 && patches[0].hunks?.length, '差异记录缺少完整行号，无法安全恢复；请使用保存历史。');
      const inverse = reversePatch(patches[0]);
      // Require exact recorded positions and context. Never guess a nearby match.
      const lines = current.content.split('\n');
      for (const hunk of inverse.hunks) {
        const expected = hunk.lines.filter(line => /^[ -]/.test(line)).map(line => line.slice(1));
        check(expected.every((line, index) => lines[Math.max(0, hunk.oldStart - 1) + index] === line), '文件与这次修改记录不再匹配，未做任何更改。请查看较新的记录或保存历史。', 409);
      }
      content = applyPatch(current.content, inverse, { fuzzFactor: 0, autoConvertLineEndings: false });
      check(typeof content === 'string', '当前文件与差异不匹配，不能安全回退。', 409);
      remove = change.kind === 'add';
      check(!remove || content === '', '新文件后来又有修改，不能直接移入废纸篓。', 409);
      check(change.kind !== 'delete' || current.version === null, '已删除的文件路径被重新使用，未覆盖。', 409);
      label = remove ? '撤销新建：移到系统废纸篓' : change.kind === 'delete' ? '恢复已删除的文件' : '撤销这次 AI 修改';
    }
    check(remove || current.content !== content || current.version === null, '文件内容已经与目标版本相同。');
    check(Buffer.byteLength(content) <= 1024 * 1024, '恢复内容超过 1 MB。');
    for (const [key, value] of this.previews) if (value.expires < Date.now()) this.previews.delete(key);
    check(this.previews.size < 8, '恢复预览过多，请稍后再试。', 429);
    const id = randomUUID(); this.previews.set(id, { ...current, content, remove, expires: Date.now() + 300000 });
    const diff = createTwoFilesPatch('current', 'restored', current.content, content, '', '', { context: 3, timeout: 200, maxEditLength: 10000 });
    return { id, cwd: current.cwd, path: relative, label, remove, diff: diff || '', before: current.content, after: content };
  }
  async apply({ id, confirmed }) {
    check(confirmed === true, '请先检查恢复预览并确认。');
    const entry = this.previews.get(id); check(entry && entry.expires > Date.now(), '预览已过期，请重新预览。', 409);
    check(!this.locked, '另一个恢复操作仍在执行。', 409); this.locked = true;
    try {
      await this.idle(entry.cwd);
      const current = await this.current(entry.cwd, entry.path);
      check(current.version === entry.version, '预览后文件已变化，未覆盖；请重新预览。', 409);
      let recovery;
      if (entry.remove) {
        await this.record(current);
        ({ recovery } = await this.tools.mutate({ ...entry, action: 'trash', confirmed: true }));
      } else if (entry.version === null) {
        // Exclusive creation, then reuse the versioned editor writer.
        await this.tools.mutate({ ...entry, action: 'createFile' });
        const empty = await this.files.read(entry); await this.files.save({ ...empty, content: entry.content });
      } else await this.files.save(entry);
      this.previews.delete(id); return { cwd: entry.cwd, path: entry.path, removed: entry.remove, recovery };
    } finally { this.locked = false; }
  }
}
