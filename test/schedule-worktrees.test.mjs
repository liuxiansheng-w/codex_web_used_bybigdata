import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workbench } from '../lib/workbench.mjs';

async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-schedule-trees-')));
  const cwd = path.join(base, 'project'), stateDir = path.join(base, 'state'), trash = path.join(base, 'trash');
  await Promise.all([mkdir(cwd), mkdir(stateDir), mkdir(trash)]);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
  git('init', '-q');
  await writeFile(path.join(cwd, 'data.txt'), 'committed version\n');
  await writeFile(path.join(cwd, '.gitignore'), 'private.tmp\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'initial');
  await writeFile(path.join(cwd, 'data.txt'), 'uncommitted version\n');
  await writeFile(path.join(cwd, 'untracked.txt'), 'not committed\n');
  await writeFile(path.join(cwd, 'private.tmp'), 'ignored\n');
  const bridge = Object.assign(new EventEmitter(), { ready: true }); let count = 0;
  const workspace = { bridge, threads: new Map(), locks: new Set(), permissions: { resolve: async () => ({}) }, modelCatalog: () => [], readModels: async () => [],
    async send(body, hooks) {
      const thread = { id: `thread-${++count}`, cwd: body.cwd, busy: true, latestTurnId: `turn-${count}`, requests: [], queue: [] };
      workspace.threads.set(thread.id, thread); await hooks.onThreadReady(thread);
      await workspace.onSend?.(body, thread); return { threadId: thread.id };
    } };
  const organization = { list: async () => ({ folders: [{ id: 'folder', name: '原项目文件夹' }] }) };
  const desk = new Workbench(workspace, {}, stateDir, { threadOrganization: organization, worktreeTrashDir: trash });
  t.after(() => desk.close());
  const action = body => desk.scheduleAction({ confirmed: true, ...body });
  return { cwd, stateDir, trash, git, workspace, desk, action };
}

test('each isolated run records a unique committed checkout before inference and preserves source changes', async t => {
  const { cwd, stateDir, workspace, desk, action } = await fixture(t);
  await action({ action: 'create', cwd, text: '虚构任务', minutes: 60, isolateWorktree: true });
  workspace.onSend = async body => {
    const saved = JSON.parse(await readFile(path.join(stateDir, 'schedules.json'), 'utf8'));
    assert.equal(saved[0].history[0].worktree.cwd, body.cwd);
    assert.equal(saved[0].history[0].worktree.state, 'active');
  };
  const job = desk.jobs[0]; await action({ action: 'run', id: job.id });
  const first = job.history[0].worktree;
  assert.notEqual(first.cwd, cwd); assert.match(first.branch, /^codex\/scheduled\//);
  assert.equal(await readFile(path.join(first.cwd, 'data.txt'), 'utf8'), 'committed version\n');
  await assert.rejects(stat(path.join(first.cwd, 'untracked.txt')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(first.cwd, 'private.tmp')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(cwd, 'data.txt'), 'utf8'), 'uncommitted version\n');
  workspace.threads.get(job.lastThreadId).busy = false;
  await action({ action: 'run', id: job.id });
  assert.notEqual(job.history[0].worktree.cwd, first.cwd);
  assert.notEqual(job.history[0].worktree.branch, first.branch);
});

test('clean completed worktrees move to Trash and restore for the original conversation', async t => {
  const { cwd, workspace, desk, action, trash, git } = await fixture(t);
  await action({ action: 'create', cwd, text: '虚构任务', minutes: 60, isolateWorktree: true, recycleWorktree: true });
  const job = desk.jobs[0]; await action({ action: 'run', id: job.id });
  const record = job.history[0], tree = record.worktree, thread = workspace.threads.get(record.threadId);
  thread.busy = false; thread.completion = 'completed';
  await desk.scheduledTurnCompleted({ threadId: thread.id, turn: { id: record.turnId, status: 'completed' } });
  assert.equal(tree.state, 'trashed'); assert.equal(path.dirname(tree.trashPath), trash);
  await assert.rejects(stat(tree.root), { code: 'ENOENT' }); assert.ok((await stat(tree.trashPath)).isDirectory());
  assert.ok(git('show-ref', '--verify', `refs/heads/${tree.branch}`));
  await action({ action: 'restore-worktree', id: job.id, recordId: record.id });
  assert.equal(tree.state, 'active'); assert.ok((await stat(tree.root)).isDirectory());
  assert.equal(await readFile(path.join(tree.cwd, 'data.txt'), 'utf8'), 'committed version\n');
});

test('worktrees with modified or ignored files are retained, and isolation requires a Git project and no original folder', async t => {
  const { cwd, workspace, desk, action } = await fixture(t);
  await assert.rejects(action({ action: 'create', cwd, text: '任务', minutes: 60, isolateWorktree: true, folderId: 'folder' }), /未分组/);
  const notGit = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-not-git-')));
  await assert.rejects(action({ action: 'create', cwd: notGit, text: '任务', minutes: 60, isolateWorktree: true }), /git|repository|仓库/i);
  await action({ action: 'create', cwd, text: '虚构任务', minutes: 60, isolateWorktree: true, recycleWorktree: true });
  const job = desk.jobs[0]; await action({ action: 'run', id: job.id });
  const record = job.history[0], tree = record.worktree, thread = workspace.threads.get(record.threadId);
  await writeFile(path.join(tree.cwd, 'private.tmp'), 'important ignored result');
  thread.busy = false; thread.completion = 'completed'; await desk.scheduledTurnCompleted({ threadId: thread.id, turn: { id: record.turnId, status: 'completed' } });
  assert.equal(tree.state, 'retained'); assert.match(tree.reason, /保留/);
  assert.equal(await readFile(path.join(tree.cwd, 'private.tmp'), 'utf8'), 'important ignored result');
});

test('a disconnected or later conversation never qualifies an unconfirmed run for recycling', async t => {
  const { cwd, workspace, desk, action } = await fixture(t);
  await action({ action: 'create', cwd, text: '虚构任务', minutes: 60, isolateWorktree: true, recycleWorktree: true });
  const job = desk.jobs[0]; await action({ action: 'run', id: job.id });
  const record = job.history[0], thread = workspace.threads.get(record.threadId);
  thread.busy = false; thread.completion = null;
  await assert.rejects(action({ action: 'recycle-worktree', id: job.id, recordId: record.id }), /未确认/);
  assert.equal(record.worktree.state, 'active'); assert.ok((await stat(record.worktree.root)).isDirectory());
  record.status = 'completed'; thread.latestTurnId = 'a-later-turn'; thread.completion = 'completed';
  await assert.rejects(action({ action: 'recycle-worktree', id: job.id, recordId: record.id }), /未确认/);
  assert.equal(record.worktree.state, 'active');
});

test('a service restart marks interrupted worktree preparation or recycling as needing inspection', async t => {
  const { cwd, stateDir, trash, workspace, desk, action } = await fixture(t);
  await action({ action: 'create', cwd, text: '虚构任务', minutes: 60, isolateWorktree: true });
  const job = desk.jobs[0]; await action({ action: 'run', id: job.id });
  const record = job.history[0]; record.status = 'preparing'; record.worktree.state = 'recycling';
  record.worktree.trashPath = path.join(trash, `lemon-schedule-${record.worktree.id}`);
  await desk.persistJobs();
  const restarted = new Workbench(workspace, {}, stateDir, { threadOrganization: desk.threadOrganization, worktreeTrashDir: trash }); t.after(() => restarted.close());
  const saved = (await restarted.schedules()).jobs[0].history[0];
  assert.equal(saved.status, 'unknown'); assert.equal(saved.worktree.state, 'unknown');
  assert.match(saved.worktree.reason, /核对/); assert.equal(saved.worktree.root, record.worktree.root); assert.equal(saved.worktree.trashPath, record.worktree.trashPath);
});
