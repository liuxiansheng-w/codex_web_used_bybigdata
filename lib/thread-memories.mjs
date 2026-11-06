import { mkdir, lstat, open, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check } from './workspace.mjs';

// Only preferences live here. Native memory files and rollout bodies are never
// modified. Null means inherit the current global setting, not a cached default.
export class ThreadMemories {
  constructor(stateDir, memories) { this.root = path.join(stateDir, 'thread-memories'); this.memories = memories; this.locks = new Set(); }
  async read(id) {
    check(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id), '会话编号无效。');
    let handle;
    try {
      const parent = await lstat(this.root); check(parent.isDirectory() && !parent.isSymbolicLink(), '聊天记忆设置目录异常。', 503);
      handle = await open(path.join(this.root, id + '.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat(); check(info.isFile() && info.size < 4096, '聊天记忆设置文件异常。', 503);
      const value = JSON.parse(await handle.readFile('utf8'));
      check(value.id === id && Number.isSafeInteger(value.revision) && value.revision >= 0 && ['use', 'contribute'].every(key => value[key] === null || typeof value[key] === 'boolean'), '聊天记忆设置格式异常。', 503);
      return value;
    } catch (error) { if (error.code === 'ENOENT') return { id, revision: 0, use: null, contribute: null }; if (error.status) throw error; throw Object.assign(new Error('无法读取聊天记忆设置，原文件已保留。'), { status: 503 }); }
    finally { await handle?.close(); }
  }
  async status(id) {
    const [value, global] = await Promise.all([this.read(id), this.memories.snapshot()]);
    const enabled = global.settings.enabled;
    return { ...value, global: global.settings, effective: { use: enabled && global.settings.use && value.use !== false, contribute: enabled && global.settings.generate && value.contribute !== false }, scope: 'next-resume' };
  }
  async config(id) {
    if (!id) return {};
    const preference = await this.read(id);
    if (preference.use === null && preference.contribute === null) return {};
    const value = await this.status(id);
    return { 'memories.use_memories': value.effective.use, 'memories.generate_memories': value.effective.contribute };
  }
  async write(value) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root); check(info.isDirectory() && !info.isSymbolicLink(), '聊天记忆设置目录异常。', 503);
    const temp = path.join(this.root, `${value.id}.${randomUUID()}.tmp`); await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temp, path.join(this.root, value.id + '.json'));
  }
  async refreshContribution(id, apply) {
    const value = await this.read(id); if (value.contribute === null) return;
    const global = await this.memories.snapshot(), desired = global.settings.enabled && global.settings.generate && value.contribute;
    if (value.appliedContribute === desired) return;
    await apply(desired);
    // Only update a native mode when its configured policy changed. Repeated
    // turns must not re-enable a thread that native external-context rules excluded.
    await this.write({ ...value, revision: value.revision + 1, appliedContribute: desired });
  }
  async update(payload, apply) {
    const { threadId: id, revision, use, contribute } = payload;
    check(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id), '会话编号无效。');
    check([use, contribute].every(value => value === null || typeof value === 'boolean'), '请选择跟随全局、允许或关闭。');
    check(!this.locks.has(id), '聊天记忆设置正在保存。', 409); this.locks.add(id);
    try {
      const current = await this.read(id); check(current.revision === revision, '设置已在其他页面变化，请刷新后保存。', 409);
      const global = await this.memories.snapshot();
      await apply({ use: global.settings.enabled && global.settings.use && use !== false, contribute: global.settings.enabled && global.settings.generate && contribute !== false }, current);
      const value = { id, revision: current.revision + 1, use, contribute, appliedContribute: contribute === null && current.contribute === null ? null : global.settings.enabled && global.settings.generate && contribute !== false };
      await this.write(value);
      return this.status(id);
    } finally { this.locks.delete(id); }
  }
}
