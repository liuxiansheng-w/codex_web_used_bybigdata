import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { check, directory } from './workspace.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const redact = value => String(value).replace(/(https?:\/\/)[^\s/@]+@/g, '$1[redacted]@');

// All mutations use the same lock as the existing manual Git controls.
export class GitSubmit {
  constructor(desk) { this.desk = desk; this.operations = new Map(); }
  git(cwd, args) { return this.desk.git(cwd, args); }
  async optional(cwd, args) { try { return (await this.git(cwd, args)).trim(); } catch { return ''; } }
  async snapshot({ cwd }) {
    cwd = await directory(cwd);
    const root = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    check(root === cwd, `当前项目不是 Git 仓库根目录，请在项目管理中打开：${root}`, 409);
    const [head, branch, raw, index, gitDir] = await Promise.all([
      this.optional(cwd, ['rev-parse', '--verify', 'HEAD']), this.optional(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.git(cwd, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']),
      this.git(cwd, ['ls-files', '--stage', '-z']),
      this.git(cwd, ['rev-parse', '--absolute-git-dir']),
    ]);
    const entries = raw.split('\0').filter(Boolean); check(entries.length <= 2000, '变更超过 2000 项，请先通过本机 Git 客户端分批整理。');
    const files = []; let excluded = 0;
    for (const entry of entries) {
      const status = entry.slice(0, 2), name = entry.slice(3); let stamp = 'deleted';
      try {
        const file = await this.desk.files.resolve(cwd, name);
        if (!file.info.isFile() || file.info.nlink !== 1) { excluded++; continue; }
        stamp = [file.info.dev, file.info.ino, file.info.size, file.info.mtimeMs, file.info.ctimeMs, file.info.mode];
      } catch (error) {
        // resolve validates every path component before reporting absence.
        if (error.status !== 404 || !status.includes('D')) { excluded++; continue; }
      }
      files.push({ path: name, status, stamp, untracked: status === '??', deleted: status.includes('D') });
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
    return { cwd, head, branch, files: files.map(({ stamp, ...file }) => file), excluded, ahead, behind, tracking, trackingRef, remote, remoteRef, remoteUrl: redact(urls[0] || ''), fetchUrl: redact(fetchUrls[0] || ''), blocked, pushBlocked, pullBlocked, pullAvailable: true, version, localVersion, sourceVersion };
  }
  async diff({ cwd, path: name, version }) {
    const state = await this.snapshot({ cwd }); check(state.version === version, 'Git 状态已变化，请刷新后重新查看。', 409);
    const file = state.files.find(file => file.path === name); check(file, '文件不在可操作变更列表中。', 403);
    let diff;
    if (file.untracked) {
      try { diff = (await this.desk.files.read({ cwd: state.cwd, path: name })).content.split('\n').map(line => `+${line}`).join('\n'); }
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
    check(['commit', 'commit-push', 'push', 'pull'].includes(action), '不支持此 Git 操作。');
    const state = await this.snapshot({ cwd }); check(state.version === version, 'Git 状态已变化，请刷新差异后重试。', 409);
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
