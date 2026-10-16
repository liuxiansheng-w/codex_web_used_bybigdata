import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const fields = { enabled: 'features.memories', generate: 'memories.generate_memories', use: 'memories.use_memories', allowExternal: 'memories.disable_on_external_context' };
const files = [
  { id: 'summary', filename: 'memory_summary.md', label: '记忆摘要' },
  { id: 'durable', filename: 'MEMORY.md', label: '长期记忆' },
  { id: 'recent', filename: 'raw_memories.md', label: '最近整理的记忆' },
];
const maxPreview = 256 * 1024;

// Native Codex owns both configuration and memory generation. This adapter only
// writes named memory settings through its versioned API and previews known files.
export class Memories {
  constructor(bridge, { codeHome = process.env.CODEX_HOME || path.join(homedir(), '.codex') } = {}) {
    this.bridge = bridge; this.codeHome = path.resolve(codeHome); this.writing = false;
  }

  async snapshot() {
    const [result, policy] = await Promise.all([
      this.bridge.request('config/read', { includeLayers: true }, 15000),
      this.bridge.request('configRequirements/read', {}, 15000),
    ]);
    const config = result.config || {}, memory = config.memories || {};
    const settings = { enabled: config.features?.memories === true, generate: memory.generate_memories !== false, use: memory.use_memories !== false, allowExternal: !(memory.disable_on_external_context ?? memory.no_memories_if_mcp_or_web_search ?? false) };
    const layer = result.layers?.find(layer => layer.name?.type === 'user' && !layer.name.profile && !layer.disabledReason);
    const managed = policy.requirements?.featureRequirements?.memories;
    const managedEnabled = typeof managed === 'boolean' ? managed : null;
    const version = typeof layer?.version === 'string' ? layer.version : null;
    return { settings, managedEnabled, version, revision: hash(JSON.stringify({ settings, managedEnabled, version })) };
  }

  async memoryRoot() {
    const root = path.join(this.codeHome, 'memories');
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) fail('记忆目录类型或所有者异常，无法读取。', 409);
      const actualHome = await realpath(this.codeHome);
      if (await realpath(root) !== path.join(actualHome, 'memories')) fail('记忆目录位置已变化，请在官方客户端检查。', 409);
      return root;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.status) throw error;
      fail('系统未允许读取本机记忆目录。', 503);
    }
  }

  async listFiles() {
    const root = await this.memoryRoot(); if (!root) return [];
    const result = [];
    for (const file of files) {
      try {
        const info = await lstat(path.join(root, file.filename));
        if (!info.isFile() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) fail('记忆文件类型或所有者异常，无法读取。', 409);
        result.push({ id: file.id, label: file.label, bytes: info.size, modifiedAt: info.mtimeMs });
      } catch (error) { if (error.code !== 'ENOENT') { if (error.status) throw error; fail('记忆文件暂时无法读取。', 503); } }
    }
    return result;
  }

  async status() {
    const record = await this.snapshot();
    let fileList = [], filesError = '', consolidation = null, runtimeEnabled = null;
    await Promise.all([
      this.listFiles().then(value => { fileList = value; }, error => { filesError = error.message; }),
      this.bridge.request('memory/status', {}, 10000).then(value => { consolidation = { threads: value.v2ConsolidatedThreads, ready: value.v2Ready }; }, () => {}),
      this.bridge.request('experimentalFeature/list', { limit: 250 }, 10000).then(value => { const feature = value.data?.find(item => item.name === 'memories'); runtimeEnabled = typeof feature?.enabled === 'boolean' ? feature.enabled : null; }, () => {}),
    ]);
    return { settings: record.settings, runtimeEnabled, managedEnabled: record.managedEnabled, revision: record.revision, writable: !!record.version, files: fileList, filesError, consolidation };
  }

  async update({ settings, revision }) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || !Object.keys(settings).length || !Object.entries(settings).every(([key, value]) => Object.hasOwn(fields, key) && typeof value === 'boolean')) fail('记忆设置格式无效。');
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) fail('请刷新记忆设置后再保存。', 409);
    if (this.writing) fail('记忆设置正在保存，请稍后。', 409);
    this.writing = true;
    try {
      const record = await this.snapshot();
      if (record.revision !== revision || !record.version) fail('记忆配置已变化，请刷新后再保存。', 409);
      if (record.managedEnabled !== null && settings.enabled !== undefined && settings.enabled !== record.managedEnabled) fail('组织策略固定了记忆开关，无法更改。', 403);
      const edits = Object.entries(settings).filter(([key, value]) => record.settings[key] !== value).map(([key, value]) => ({ keyPath: fields[key], value: key === 'allowExternal' ? !value : value, mergeStrategy: 'replace' }));
      if (edits.length) {
        let result;
        try { result = await this.bridge.request('config/batchWrite', { edits, expectedVersion: record.version, reloadUserConfig: true }, 20000); }
        catch (error) { fail(/version|conflict|changed/i.test(error.message) ? '记忆配置已变化，请刷新后再保存。' : '未能保存记忆设置，请刷新后核对。', /version|conflict|changed/i.test(error.message) ? 409 : 503); }
        if (result.overriddenMetadata) fail('设置已保存，但被更高优先级配置覆盖，请刷新查看实际状态。', 409);
      }
      let updated = await this.status();
      if (Object.entries(settings).some(([key, value]) => updated.settings[key] !== value)) fail('配置返回的实际状态与保存值不同，请刷新核对。', 409);
      if (updated.runtimeEnabled !== null && updated.runtimeEnabled !== updated.settings.enabled) {
        try { await this.bridge.request('experimentalFeature/enablement/set', { enablement: { memories: updated.settings.enabled } }, 10000); }
        catch { fail('记忆设置已保存，但当前运行时未能加载，请重新连接后核对。', 503); }
        updated = await this.status();
        if (updated.runtimeEnabled !== updated.settings.enabled) fail('当前运行时尚未采用新的记忆开关，请重新连接后核对。', 503);
      }
      return updated;
    } finally { this.writing = false; }
  }

  async read({ id }) {
    const file = files.find(file => file.id === id); if (!file) fail('记忆条目不存在。', 404);
    const root = await this.memoryRoot(); if (!root) fail('尚未生成本机记忆。', 404);
    let handle;
    try {
      handle = await open(path.join(root, file.filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      if (!info.isFile() || process.getuid && info.uid !== process.getuid()) fail('记忆文件类型或所有者异常，无法读取。', 409);
      const bytes = Buffer.alloc(Math.min(info.size, maxPreview) + 1); let size = 0;
      while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
      const truncated = info.size > maxPreview || size > maxPreview;
      const visible = bytes.subarray(0, Math.min(size, maxPreview));
      const content = new TextDecoder().decode(visible, { stream: truncated });
      return { id, label: file.label, content, truncated, bytes: info.size, modifiedAt: info.mtimeMs };
    } catch (error) {
      if (error.status) throw error;
      fail(error.code === 'ENOENT' ? '该记忆尚未生成，请刷新列表。' : '记忆文件暂时无法读取。', error.code === 'ENOENT' ? 404 : 503);
    } finally { await handle?.close(); }
  }
}
