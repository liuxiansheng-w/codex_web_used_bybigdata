import { open, rename, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const limit = 256 * 1024;
const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const names = { 'com.google.Chrome': 'Google Chrome', 'com.microsoft.edgemac': 'Microsoft Edge', 'com.operasoftware.Opera': 'Opera', 'com.apple.Safari': 'Safari', 'com.apple.finder': '访达', 'com.apple.Terminal': '终端', 'com.apple.systempreferences': '系统设置' };
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Matches the installed official macOS Computer Use settings adapter. This
// service can only list/revoke existing permanent grants; it never creates one.
export class AppApprovals {
  constructor({ home = homedir(), platformName = process.platform, filePath, beforeCommit } = {}) {
    this.platformName = platformName;
    this.filePath = filePath || path.join(home, 'Library', 'Group Containers', '2DC432GLL2.com.openai.sky.CUAService', 'Library', 'Application Support', 'Software', 'ComputerUseAppApprovals.json');
    this.trashDirectory = path.join(home, '.Trash');
    this.beforeCommit = beforeCommit;
    this.writing = false;
  }

  async read() {
    if (this.platformName !== 'darwin') fail('当前仅支持管理本机 macOS 应用授权。', 501);
    let handle;
    try {
      handle = await open(this.filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit || process.getuid && stat.uid !== process.getuid()) fail('应用授权记录格式或所有者不符合预期，请在官方客户端检查。', 409);
      const buffer = Buffer.alloc(limit + 1); let size = 0;
      while (size < buffer.length) { const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size); if (!bytesRead) break; size += bytesRead; }
      if (size > limit) fail('应用授权记录过大，请在官方客户端检查。', 409);
      const bytes = buffer.subarray(0, size); let data;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { fail('应用授权记录无法解析，请在官方客户端检查。', 409); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.approvedBundleIdentifiers) || data.approvedBundleIdentifiers.length > 1000 || !data.approvedBundleIdentifiers.every(id => typeof id === 'string' && appIdPattern.test(id))) fail('应用授权记录格式已变化，请在官方客户端检查。', 409);
      return { data, revision: hash(bytes), mode: stat.mode & 0o777 };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.status) throw error;
      fail(['EPERM', 'EACCES'].includes(error.code) ? '系统未允许读取应用授权记录，请在官方客户端管理。' : '应用授权记录暂时不可用，请在官方客户端检查。', 503);
    } finally { await handle?.close(); }
  }

  present(record) {
    return { available: true, initialized: !!record, revision: record?.revision || null,
      apps: [...new Set(record?.data.approvedBundleIdentifiers || [])].map(appId => ({ appId, name: names[appId] || appId, scope: 'always' })) };
  }

  async list() {
    try { return this.present(await this.read()); }
    catch (error) { return { available: false, initialized: false, revision: null, apps: [], error: error.message }; }
  }

  async revoke({ appId, revision, confirmed } = {}) {
    if (confirmed !== true) fail('请确认撤销此应用的“始终允许”。');
    if (typeof appId !== 'string' || !appIdPattern.test(appId) || typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)) fail('应用授权请求无效，请刷新列表。');
    if (this.writing) fail('正在更新应用授权，请稍后刷新。', 409);
    this.writing = true; let temporary;
    try {
      const current = await this.read();
      if (!current || current.revision !== revision || !current.data.approvedBundleIdentifiers.includes(appId)) fail('授权列表已经变化，请刷新后重新确认。', 409);
      const data = { ...current.data, approvedBundleIdentifiers: current.data.approvedBundleIdentifiers.filter(id => id !== appId) };
      temporary = path.join(path.dirname(this.filePath), `.app-approvals-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(data, null, 2) + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await this.beforeCommit?.();
      const latest = await this.read();
      if (!latest || latest.revision !== revision) fail('授权列表已经变化，请刷新后重新确认。', 409);
      await rename(temporary, this.filePath); temporary = null;
      const updated = await this.read();
      if (!updated || updated.data.approvedBundleIdentifiers.includes(appId)) fail('授权状态再次变化，请刷新列表核对。', 409);
      return { ...this.present(updated), revokedAppId: appId };
    } catch (error) {
      if (error.status) throw error;
      fail('未能撤销应用授权，请刷新核对或在官方客户端操作。', 503);
    } finally {
      if (temporary) {
        // Follow the project convention for abandoned temporary files.
        try { await mkdir(this.trashDirectory, { recursive: true, mode: 0o700 }); await rename(temporary, path.join(this.trashDirectory, `app-approvals-${randomUUID()}.tmp`)); } catch { /* Do not mask the original update failure. */ }
      }
      this.writing = false;
    }
  }
}
