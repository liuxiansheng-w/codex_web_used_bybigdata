import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { check, directory } from './workspace.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const maxChanges = 20000, resolveBatchSize = 64;
const redact = value => String(value).replace(/(https?:\/\/)[^\s/@]+@/g, '$1[redacted]@');

// All mutations use the same lock as the existing manual Git controls.
export class GitSubmit {
  constructor(desk) { this.desk = desk; this.operations = new Map(); }
  git(cwd, args, options) { return this.desk.git(cwd, args, options); }
  async optional(cwd, args) { try { return (await this.git(cwd, args)).trim(); } catch { return ''; } }
  async snapshot({ cwd }) {
    cwd = await directory(cwd);
    const root = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    check(root === cwd, `当前项目不是 Git 仓库根目录，请在项目管理中打开：${root}`, 409);
    const [head, branch, raw, index, gitDir] = await Promise.all([
      this.optional(cwd, ['rev-parse', '--verify', 'HEAD']), this.optional(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.git(cwd, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { maxBuffer: 16 * 1024 * 1024 }),
      this.git(cwd, ['ls-files', '--stage', '-z'], { maxBuffer: 16 * 1024 * 1024 }),
      this.git(cwd, ['rev-parse', '--absolute-git-dir']),
    ]);
    const entries = raw.split('\0').filter(Boolean); check(entries.length <= maxChanges, `变更超过 ${maxChanges} 项，请先通过本机 Git 客户端分批整理。`);
    const files = []; let excluded = 0;
    // Bounded concurrency keeps large repositories responsive without relaxing path checks.
    for (let offset = 0; offset < entries.length; offset += resolveBatchSize) {
      const resolved = await Promise.all(entries.slice(offset, offset + resolveBatchSize).map(async entry => {
        const status = entry.slice(0, 2), name = entry.slice(3); let stamp = 'deleted';
        try {
          const file = await this.desk.files.resolve(cwd, name);
          if (!file.info.isFile() || file.info.nlink !== 1) return null;
          stamp = [file.info.dev, file.info.ino, file.info.size, file.info.mtimeMs, file.info.ctimeMs, file.info.mode];
        } catch (error) {
          // resolve validates every path component before reporting absence.
          if (error.status !== 404 || !status.includes('D')) return null;
        }
        return { path: name, status, stamp, untracked: status === '??', deleted: status.includes('D') };
      }));
      for (const item of resolved) { if (item) files.push(item); else excluded++; }
    }
    const upstream = branch ? await this.optional(cwd, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:short)%00%(upstream)', `refs/heads/${branch}`]) : '';
    const [remote = '', remoteRef = '', tracking = '', trackingRef = ''] = upstream.split('\0');
    const urls = remote && remote !== '.' ? (await this.optional(cwd, ['remote', 'get-url', '--push', '--all', remote])).split('\n').filter(Boolean) : [];
    const fetchUrls = remote && remote !== '.' ? (await this.optional(cwd, ['remote', 'get-url', '--all', remote])).split('\n').filter(Boolean) : [];
    const counts = tracking ? await this.optional(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']) : '';
    const [ahead, behind] = counts ? counts.split(/\s+/).map(Number) : [null, null];
    let blocked = !branch ? '当前为游离 HEAD，请先在本机切换分支。' : !head ? '请先通过本机 Git 客户端完成仓库的首次提交。' : '';
    if (entries.some(entry => /U/.test(entry.slice(0, 2)) || ['AA', 'DD'].includes(entry.slice(0, 2)))) blocked = '仓库存在冲突，请先在本机解决。';
    await Promise.all(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'].map(async marker => {
      try { await lstat(path.join(gitDir.trim(), marker)); blocked = '仓库正在合并、变基或其他 Git 操作中，请先在本机完成。'; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }));
    const pushBlocked = blocked || (!remote || remote === '.' || !remoteRef.startsWith('refs/heads/') ? '尚未配置可推送的上游分支，请先在本机设置 upstream。' : urls.length !== 1 ? '远程推送地址缺失或包含多个目标，请先在本机核对配置。' : behind > 0 ? '本地落后于已知上游，请先拉取远程更新。' : '');
    const pullBlocked = blocked || (!remote || remote === '.' || !remoteRef.startsWith('refs/heads/') || !trackingRef.startsWith('refs/remotes/') ? '尚未配置可拉取的远程上游分支，请先在本机设置 upstream。' : fetchUrls.length !== 1 ? '远程拉取地址缺失或包含多个目标，请先在本机核对配置。' : entries.length ? '有未提交修改或未跟踪文件，请先提交或在本机整理后再拉取。' : '');
    const localVersion = hash({ cwd, head, branch, raw, index, files, blocked });
    const sourceVersion = hash({ remote, remoteRef, trackingRef, fetchUrls });
    const version = hash({ localVersion, sourceVersion, urls, ahead, behind, tracking });
    return { cwd, head, branch, files: files.map(({ stamp, ...file }) => file), excluded, ahead, behind, tracking, trackingRef, remote, remoteRef, remoteUrl: redact(urls[0] || ''), fetchUrl: redact(fetchUrls[0] || ''), blocked, pushBlocked, pullBlocked, pullAvailable: true, remoteComparisonAvailable: true, version, localVersion, sourceVersion };
  }
  async remoteComparison({ cwd }) {
    const state = await this.snapshot({ cwd });
    const reason = !state.head ? '请先完成首次提交。' : !state.branch ? '当前为游离 HEAD，请先切换分支。' : !state.remote || state.remote === '.' || !state.remoteRef.startsWith('refs/heads/') || !state.trackingRef.startsWith('refs/remotes/') ? '当前分支未配置远程上游，请先在本机设置 upstream。' : '';
    if (reason) return { available: false, reason, tracking: state.tracking, files: [] };
    const target = await this.optional(state.cwd, ['rev-parse', '--verify', `${state.trackingRef}^{commit}`]);
    if (!/^[a-f0-9]{40,64}$/i.test(target)) return { available: false, reason: '本地还没有该远程分支的记录，请点击获取远程。', tracking: state.tracking, canFetch: true, version: state.version, files: [] };
    const raw = await this.git(state.cwd, ['diff', '--name-status', '-z', '--no-ext-diff', '--no-textconv', '--no-renames', target, '--'], { maxBuffer: 16 * 1024 * 1024 });
    const parts = raw.split('\0'); if (parts.at(-1) === '') parts.pop();
    check(parts.length % 2 === 0 && parts.length / 2 <= maxChanges, `远程比较超过 ${maxChanges} 项或 Git 返回了无法识别的结果，请使用本机 Git 客户端核对。`);
    const files = []; let excluded = 0;
    for (let offset = 0; offset < parts.length; offset += resolveBatchSize * 2) {
      const batch = [];
      for (let i = offset; i < Math.min(parts.length, offset + resolveBatchSize * 2); i += 2) batch.push({ status: parts[i], name: parts[i + 1] });
      const resolved = await Promise.all(batch.map(async ({ status, name }) => {
        let exists = false;
        try { const f = await this.desk.files.resolve(state.cwd, name); if (!f.info.isFile() || f.info.nlink !== 1) return null; exists = true; }
        catch (error) { if (error.status !== 404 || status !== 'D') return null; }
        // An untracked or ignored same-name disk file is not a Git deletion.
        return status === 'D' && exists ? { path: name, status: '?', sameNameUntracked: true } : { path: name, status };
      }));
      for (const item of resolved) { if (item) files.push(item); else excluded++; }
    }
    const byPath = new Map(files.map(file => [file.path, file]));
    for (const file of state.files.filter(item => item.untracked)) {
      const found = byPath.get(file.path);
      if (found) { found.status = '?'; found.sameNameUntracked = true; }
      else { const fresh = { path: file.path, status: '?', untracked: true }; files.push(fresh); byPath.set(file.path, fresh); }
    }
    check(files.length <= maxChanges, `远程比较超过 ${maxChanges} 项，请先通过本机 Git 客户端分批整理。`);
    const version = hash({ state: state.version, target, files });
    const latest = await this.snapshot({ cwd: state.cwd });
    const latestTarget = await this.optional(state.cwd, ['rev-parse', '--verify', `${state.trackingRef}^{commit}`]);
    check(state.version === latest.version && target === latestTarget, '读取远程比较时 Git 状态发生变化，请刷新。', 409);
    return { available: true, canFetch: true, cwd: state.cwd, version, stateVersion: state.version, target, tracking: state.tracking, ahead: state.ahead, behind: state.behind, files, excluded, excludedLocal: state.excluded };
  }
  async remoteDiff({ cwd, path: name, version }) {
    const state = await this.remoteComparison({ cwd });
    check(state.available && state.version === version, '比较状态已变化，请刷新后重新查看。', 409);
    const file = state.files.find(item => item.path === name); check(file, '文件不在可比较列表中。', 403);
    let diff;
    if (file.sameNameUntracked) diff = '本地存在与远程同名的未跟踪文件或忽略文件，Git 无法直接比较，请先在本机核对。';
    else if (file.untracked) {
      try {
        const content = (await this.desk.files.read({ cwd: state.cwd, path: name, maxBytes: 1024 * 1024 })).content;
        const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content ? content.split('\n') : [];
        diff = `@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => `+${line}`).join('\n');
      } catch (error) { if (![413, 415].includes(error.status)) throw error; diff = '二进制、非 UTF-8 或超过 1 MB：不展示文本预览，请在本机核对。'; }
    } else {
      const local = await this.desk.files.resolve(state.cwd, name).catch(error => { if (error.status === 404 && file.status === 'D') return null; throw error; });
      const remoteSize = await this.optional(state.cwd, ['cat-file', '-s', `${state.target}:${name}`]);
      if (local?.info.size > 1024 * 1024 || (remoteSize && Number(remoteSize) > 1024 * 1024)) diff = '文件超过 1 MB：不展示文本预览，请在本机核对。';
      else {
        const mode = (await this.git(state.cwd, ['--literal-pathspecs', 'ls-tree', '-z', state.target, '--', name])).split(' ')[0];
        if (mode && !['100644', '100755'].includes(mode)) diff = '远程版本为符号链接或特殊文件，请在本机核对。';
        else {
          diff = await this.git(state.cwd, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', state.target, '--', name]);
          if (diff.includes('\uFFFD')) diff = '文件不是有效的 UTF-8 文本：不展示文本预览，请在本机核对。';
        }
      }
    }
    const latest = await this.snapshot({ cwd: state.cwd });
    const latestTarget = await this.optional(state.cwd, ['rev-parse', '--verify', `${latest.trackingRef}^{commit}`]);
    check(latest.version === state.stateVersion && latestTarget === state.target, '读取差异时 Git 状态已变化，请刷新。', 409);
    return { path: name, diff: diff || '没有文本差异（可能仅文件权限变化）。', tracking: state.tracking };
  }
  async diff({ cwd, path: name, version }) {
    const state = await this.snapshot({ cwd }); check(state.version === version, 'Git 状态已变化，请刷新后重新查看。', 409);
    const file = state.files.find(file => file.path === name); check(file, '文件不在可操作变更列表中。', 403);
    let diff;
    if (file.untracked) {
      try { diff = (await this.desk.files.read({ cwd: state.cwd, path: name, maxBytes: 1024 * 1024 })).content.split('\n').map(line => `+${line}`).join('\n'); }
      catch (error) { if (![413, 415].includes(error.status)) throw error; diff = '二进制、非 UTF-8 或超过 1 MB：不展示文本预览，请在本机核对。'; }
    } else {
      diff = await this.git(state.cwd, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...(state.head ? [state.head] : ['--cached']), '--', name]);
    }
    check((await this.snapshot({ cwd })).version === version, '读取差异时 Git 状态已变化，请刷新。', 409);
    return { path: name, diff: diff || '没有文本差异（可能仅文件权限变化）。' };
  }
  async action(body) {
    check(body.confirmed === true, '请明确确认 Git 操作。');
    check(typeof body.operationId === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(body.operationId), '操作标识无效。');
    const signature = hash(body), prior = this.operations.get(body.operationId);
    if (prior) { check(prior.signature === signature, '操作标识已经用于其他请求。', 409); return prior.promise; }
    check(!this.desk.gitLocked, '另一个 Git 写操作仍在执行。', 409);
    this.desk.gitLocked = true;
    const promise = this.perform(body).finally(() => { this.desk.gitLocked = false; });
    this.operations.set(body.operationId, { signature, promise });
    if (this.operations.size > 100) this.operations.delete(this.operations.keys().next().value);
    return promise;
  }
  async perform({ cwd, version, action, paths, message, head }) {
    check(['commit', 'commit-push', 'push', 'pull', 'fetch'].includes(action), '不支持此 Git 操作。');
    const state = await this.snapshot({ cwd }); check(state.version === version, 'Git 状态已变化，请刷新差异后重试。', 409);
    if (action === 'fetch') return this.fetch(state);
    check(!state.blocked, state.blocked, 409);
    if (action === 'pull') {
      check(head === state.head && !!head, '当前提交已变化，请刷新并重新确认。', 409);
      check(!state.pullBlocked, state.pullBlocked, 409);
      return this.pull(state);
    }
    if (action !== 'commit') check(!state.pushBlocked, state.pushBlocked, 409);
    let committed = false, commit = state.head;
    if (action !== 'push') {
      check(typeof message === 'string' && message.trim() && message.length <= 1000 && !message.includes('\0'), '请输入不超过 1000 字的提交说明。');
      check(Array.isArray(paths) && paths.length > 0 && paths.length <= 200 && new Set(paths).size === paths.length, '请选择 1–200 个变更文件。');
      check(paths.every(name => typeof name === 'string' && state.files.some(file => file.path === name)), '选中文件不在刚查看的变更列表中。', 403);
      // --only excludes unrelated pre-existing staged changes. For the initial
      // commit Git cannot safely combine --only and an unborn HEAD.
      check(state.head, '请先通过本机 Git 客户端完成仓库的首次提交。', 409);
      const fresh = paths.filter(name => state.files.find(file => file.path === name).untracked);
      try {
        if (fresh.length) await this.git(state.cwd, ['--literal-pathspecs', 'add', '--', ...fresh]);
        await this.git(state.cwd, ['--literal-pathspecs', '-c', 'commit.gpgsign=false', 'commit', '--only', '-m', message.trim(), '--', ...paths]);
        committed = true; commit = (await this.git(state.cwd, ['rev-parse', 'HEAD'])).trim();
      } catch (error) { throw Object.assign(new Error(`提交未确认成功，请刷新核对 HEAD 与暂存区（新文件可能已暂存）。${redact(error.message)}`), { status: 409 }); }
    } else check(head === state.head && !!head, '待推送提交已变化，请刷新并重新确认。', 409);
    if (action === 'commit') return { committed, commit, pushed: false };
    try {
      const latest = await this.snapshot({ cwd });
      check(latest.head === commit && latest.branch === state.branch && latest.remote === state.remote && latest.remoteRef === state.remoteRef && latest.remoteUrl === state.remoteUrl && !latest.pushBlocked, '提交后分支或远程状态变化，请刷新后单独推送。', 409);
      await this.git(state.cwd, ['-c', 'push.followTags=false', 'push', '--porcelain', '--recurse-submodules=no', '--', state.remote, `${commit}:${state.remoteRef}`]);
      return { committed, commit, pushed: true };
    } catch (error) { return { committed, commit, pushed: false, pushError: `推送未确认成功，请核对远程后重试；不会自动强制推送。${redact(error.message)}` }; }
  }

  async fetch(state) {
    check(state.branch && state.head && state.remote && state.remote !== '.' && state.remoteRef.startsWith('refs/heads/') && state.trackingRef.startsWith('refs/remotes/'), '当前分支未配置远程上游，请先在本机设置 upstream。', 409);
    const urls = (await this.optional(state.cwd, ['remote', 'get-url', '--all', state.remote])).split('\n').filter(Boolean);
    check(urls.length === 1, '远程地址缺失或包含多个目标，请先在本机核对配置。', 409);
    try {
      await this.git(state.cwd, ['fetch', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--refmap=', '--', state.remote, `+${state.remoteRef}:${state.trackingRef}`]);
      const latest = await this.snapshot({ cwd: state.cwd });
      check(latest.sourceVersion === state.sourceVersion && latest.branch === state.branch, '获取期间分支或上游配置发生变化，请刷新后重新核对。', 409);
      const target = (await this.git(state.cwd, ['rev-parse', '--verify', `${latest.trackingRef}^{commit}`])).trim();
      return { fetched: true, tracking: latest.tracking, target };
    } catch (error) { return { fetched: false, fetchError: `获取远程未确认成功，请检查网络或认证；显示的仍是本地缓存。${redact(error.message)}` }; }
  }

  async pull(state) {
    let fetched = false;
    try {
      // Fetch only the selected upstream; do not prune, fetch tags or recurse.
      // A separate merge lets us recheck local edits and configuration afterwards.
      await this.git(state.cwd, ['fetch', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', '--refmap=', '--', state.remote, `${state.remoteRef}:${state.trackingRef}`]);
      fetched = true;
      const target = (await this.git(state.cwd, ['rev-parse', '--verify', `${state.trackingRef}^{commit}`])).trim();
      const latest = await this.snapshot({ cwd: state.cwd });
      check(latest.localVersion === state.localVersion && latest.sourceVersion === state.sourceVersion && !latest.pullBlocked, '下载期间本地文件、分支或上游配置已变化，未合入更新，请刷新后核对。', 409);
      check(!(latest.ahead > 0 && latest.behind > 0), '本地和远程分支已分叉，请先在本机合并或变基；快捷拉取不会自动处理分叉。', 409);
      await this.git(state.cwd, ['-c', 'submodule.recurse=false', 'merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', '--no-edit', '--no-stat', '--', target]);
      const after = await this.snapshot({ cwd: state.cwd });
      const expected = latest.behind === 0 ? state.head : target;
      check(after.head === expected && after.branch === state.branch && after.sourceVersion === state.sourceVersion, '拉取后状态又发生变化，请刷新核对当前分支。', 409);
      return { pulled: true, fetched, updated: after.head !== state.head, before: state.head, head: after.head, tracking: state.tracking };
    } catch (error) {
      return { pulled: false, fetched, pullError: `${fetched ? '已获取远程信息，合入未确认成功。' : '获取远程更新失败。'}${redact(error.message)} 请刷新核对；不会自动重试。` };
    }
  }
}
