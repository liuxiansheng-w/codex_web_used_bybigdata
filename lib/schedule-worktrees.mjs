import { lstat, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { check, directory } from './workspace.mjs';

// All moves use Git's worktree metadata and the user's Trash; no files are
// deleted and branch refs remain available for later inspection.
export class ScheduleWorktrees {
  constructor(stateDir, git, { trashDir = path.join(homedir(), '.Trash') } = {}) {
    this.root = path.resolve(stateDir, 'scheduled-worktrees'); this.trashDir = trashDir; this.git = git;
  }
  async plan(cwd, jobId) {
    const project = await directory(cwd);
    const top = await directory((await this.git(project, ['rev-parse', '--show-toplevel'])).trim());
    const relative = path.relative(top, project);
    check(!relative.startsWith('..') && !path.isAbsolute(relative), '项目目录不在 Git 仓库内。');
    const base = (await this.git(project, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    check(/^[a-f0-9]{40,64}$/.test(base), '仓库没有可用的已提交版本，无法创建隔离工作树。');
    const id = randomUUID(), branch = `codex/scheduled/${jobId}/${id}`;
    return { id, source: top, root: path.join(this.root, id), relative, branch, base, state: 'planned' };
  }
  async create(tree) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.root);
    check(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && await realpath(this.root) === this.root, '隔离工作树目录不可用或包含符号链接。');
    check(path.dirname(tree.root) === this.root && /^[0-9a-f-]{36}$/.test(tree.id), '隔离工作树路径无效。');
    await this.git(tree.source, ['worktree', 'add', '-b', tree.branch, tree.root, tree.base]);
    const cwd = await directory(path.join(tree.root, tree.relative));
    check(cwd === tree.root || cwd.startsWith(tree.root + path.sep), '隔离工作目录无效。');
    tree.cwd = cwd; tree.state = 'active';
    return cwd;
  }
  async moveToTrash(tree) {
    check(['active', 'retained', 'recycling'].includes(tree.state), '该工作树不在原位置。');
    check(path.dirname(tree.root) === this.root && path.basename(tree.root) === tree.id, '工作树记录无效。');
    const root = await directory(tree.root), trash = await directory(this.trashDir);
    check(root === tree.root, '工作树位置已变化，请手动核对。', 409);
    const branch = (await this.git(root, ['branch', '--show-current'])).trim();
    check(branch === tree.branch, '工作树分支已变化，请手动核对。', 409);
    const status = await this.git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching']);
    if (status.trim()) { tree.state = 'retained'; tree.reason = '包含未提交、未跟踪或忽略的文件，已保留工作树。'; return false; }
    const destination = path.join(trash, `lemon-schedule-${tree.id}`);
    await this.git(tree.source, ['worktree', 'move', tree.root, destination]);
    tree.trashPath = destination; tree.state = 'trashed'; tree.reason = '';
    return true;
  }
  async restore(tree) {
    check(tree.state === 'trashed' && typeof tree.trashPath === 'string', '该工作树不在废纸篓中。');
    const trash = await directory(this.trashDir), source = await directory(tree.trashPath);
    check(source === tree.trashPath && path.dirname(source) === trash && path.basename(source) === `lemon-schedule-${tree.id}` && path.dirname(tree.root) === this.root && path.basename(tree.root) === tree.id, '工作树位置已变化，请手动核对。', 409);
    await this.git(tree.source, ['worktree', 'move', source, tree.root]);
    tree.cwd = await directory(path.join(tree.root, tree.relative));
    tree.state = 'active'; tree.trashPath = null; tree.reason = '';
    return tree.cwd;
  }
}
