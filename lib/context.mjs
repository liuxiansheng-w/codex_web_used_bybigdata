import { mkdtemp, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImagePreviews } from './image-previews.mjs';

function ensure(ok, message) { if (!ok) throw Object.assign(new Error(message), { status: 400 }); }
const isImage = filename => /\.(png|jpe?g|webp|gif)$/i.test(filename);

export class ContextStore {
  files = new Map();
  bytes = 0;
  pending = 0;
  root = null;
  images = new ImagePreviews();

  async upload({ name, base64 }) {
    ensure(typeof name === 'string' && name.length > 0 && name.length < 1024, '附件名称无效。');
    ensure(typeof base64 === 'string' && base64.length <= 14_000_000 && base64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(base64), '附件内容无效或超过 10 MB。');
    const bytes = Buffer.from(base64, 'base64');
    ensure(bytes.length <= 10 * 1024 * 1024, '单个附件不能超过 10 MB。');
    ensure(this.bytes + bytes.length <= 100 * 1024 * 1024 && this.files.size + this.pending < 200, '本次服务已达到附件容量限制，请重启服务后重新添加附件。');
    const filename = path.basename(name.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '_');
    ensure(filename && filename !== '.' && filename !== '..', '附件名称无效。');
    const extension = path.extname(filename).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 16);
    // Reserve before yielding so parallel uploads cannot exceed the quota.
    this.bytes += bytes.length;
    this.pending++;
    try {
      if (!this.root) this.root = mkdtemp(path.join(tmpdir(), 'codex-desk-attachments-'));
      const root = await this.root;
      const id = randomUUID();
      const fullPath = path.join(root, `${id}${extension}`);
      await writeFile(fullPath, bytes, { flag: 'wx', mode: 0o600 });
      const file = { id, name, path: fullPath, size: bytes.length, kind: isImage(filename) ? 'image' : 'file' };
      this.files.set(id, file);
      return this.public(file);
    } catch (error) { this.bytes -= bytes.length; throw error; }
    finally { this.pending--; }
  }

  async reference({ path: value }) {
    ensure(typeof value === 'string' && path.isAbsolute(value) && value.length < 4096, '请输入文件或文件夹的绝对路径。');
    let resolved, info;
    try { resolved = await realpath(value); info = await stat(resolved); }
    catch { throw Object.assign(new Error('该文件或文件夹不存在，或无法访问。'), { status: 400 }); }
    ensure(info.isFile() || info.isDirectory(), '请选择普通文件或文件夹。');
    return this.registerReference(resolved, info);
  }

  registerReference(resolved, info, metadata = {}) {
    if (metadata.projectRoot) {
      const existing = [...this.files.values()].find(file => file.path === resolved && file.projectRoot === metadata.projectRoot && file.projectPath === metadata.projectPath);
      if (existing) return this.public(existing);
    }
    ensure(this.files.size + this.pending < 200, '附件数量已达到上限。');
    const file = { id: randomUUID(), name: path.basename(resolved), path: resolved, size: info.size, kind: info.isDirectory() ? 'folder' : isImage(resolved) ? 'image' : 'file', ...metadata };
    this.files.set(file.id, file);
    return this.public(file);
  }

  public(file) { return { id: file.id, name: file.name, size: file.size, kind: file.kind, ...(file.kind === 'image' ? this.images.describe({ type: 'localImage', path: file.path }, file.name) : {}), ...(file.projectRoot ? { projectRoot: file.projectRoot, projectPath: file.projectPath } : {}) }; }
  resolve(ids) {
    ensure(Array.isArray(ids) && ids.length <= 30, '每条消息最多添加 30 个文件或文件夹。');
    return ids.map(id => { const file = this.files.get(id); ensure(file, '附件已过期，请重新添加。'); return file; });
  }
}

export function attachmentInput(files) {
  const input = [];
  for (const file of files) {
    input.push({ type: 'text', text: `用户附加的${file.kind === 'folder' ? '文件夹' : '文件'}：${JSON.stringify(file.name)}\n本机路径：${JSON.stringify(file.path)}`, text_elements: [] });
    if (file.kind === 'image') input.push({ type: 'localImage', path: file.path });
  }
  return input;
}

export class CapabilityCatalog {
  constructor(bridge) { this.bridge = bridge; this.cache = new Map(); }

  async get(cwd, refresh = false) {
    const old = this.cache.get(cwd);
    if (!refresh && old && Date.now() - old.at < 60_000) return old.value;
    const results = await Promise.allSettled([
      this.bridge.request('skills/list', { cwds: [cwd], forceReload: refresh }, 30_000),
      this.bridge.request('plugin/installed', { cwds: [cwd] }, 30_000),
      this.bridge.request('collaborationMode/list', {}, 15_000),
    ]);
    const skills = results[0].status === 'fulfilled'
      ? results[0].value.data.flatMap(entry => entry.skills).filter(s => s.enabled).map(s => ({ key: `skill:${s.path}`, kind: 'skill', name: s.name, title: s.interface?.displayName || s.name, description: s.interface?.shortDescription || s.shortDescription || s.description, path: s.path })) : [];
    const plugins = results[1].status === 'fulfilled'
      ? results[1].value.marketplaces.flatMap(m => m.plugins).filter(p => p.installed && p.enabled && p.interface?.displayName).map(p => ({ key: p.id, kind: 'plugin', name: p.name, title: p.interface.displayName, description: p.interface.shortDescription || '', path: `plugin://${p.id}` })) : [];
    const value = {
      skills, plugins,
      planSupported: results[2].status === 'fulfilled' && results[2].value.data.some(m => m.mode === 'plan'),
      recordingSupported: false,
      recordingReason: '原生屏幕操作录制需要官方客户端；当前 App Server 没有提供录制技能接口。',
      warnings: results.filter(r => r.status === 'rejected').map(r => r.reason.message),
    };
    this.cache.set(cwd, { at: Date.now(), value });
    return value;
  }

  async input(cwd, keys) {
    ensure(Array.isArray(keys) && keys.length <= 20, '每条消息最多选择 20 个插件或技能。');
    if (!keys.length) return [];
    const catalog = await this.get(cwd);
    const all = [...catalog.plugins, ...catalog.skills];
    return [...new Set(keys)].map(key => {
      const item = all.find(entry => entry.key === key);
      ensure(item, '所选插件或技能已不可用，请重新选择。');
      return { type: item.kind === 'skill' ? 'skill' : 'mention', name: item.kind === 'skill' ? item.name : item.title, path: item.path };
    });
  }
}
