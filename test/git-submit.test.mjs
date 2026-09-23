import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../lib/workbench.mjs';
import { ProjectFiles } from '../lib/project-files.mjs';
import { GitSubmit } from '../lib/git-submit.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-git-submit-'))), cwd = path.join(root, 'repo'), remote = path.join(root, 'remote.git');
  await mkdir(cwd);
  const git = async (...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd })).stdout.trim();
  await git('init', '-b', 'main'); await git('config', 'user.email', 'test@example.invalid'); await git('config', 'user.name', 'Fixture');
  for (const name of ['one.txt', 'two.txt', 'remove.txt']) await writeFile(path.join(cwd, name), 'before\n');
  await git('add', '.'); await git('commit', '-m', 'fixture baseline');
  await git('init', '--bare', remote); await git('remote', 'add', 'origin', remote); await git('push', '-u', 'origin', 'main');
  const desk = new Workbench({ bridge: new EventEmitter() }, new ProjectFiles(), root); t.after(() => clearInterval(desk.timer));
  return { root, cwd, remote, git, desk, service: new GitSubmit(desk) };
}
const request = (s, extras = {}) => ({ cwd: s.cwd, version: s.version, head: s.head, action: 'commit', paths: ['one.txt'], message: 'selected change', confirmed: true, operationId: randomUUID(), ...extras });

test('Git submit previews changes, commits only selected files and preserves unrelated staging; retries are idempotent', async t => {
  const { cwd, git, service } = await fixture(t);
  await writeFile(path.join(cwd, 'one.txt'), 'selected\n'); await writeFile(path.join(cwd, 'two.txt'), 'unrelated staged\n'); await git('add', 'two.txt');
  await writeFile(path.join(cwd, '新 文件 [1].txt'), '<script>not executable</script>\n');
  const s = await service.snapshot({ cwd }); assert.equal(s.ahead, 0); assert.equal(s.pushBlocked, '');
  assert.match((await service.diff({ cwd, path: 'one.txt', version: s.version })).diff, /\+selected/);
  assert.match((await service.diff({ cwd, path: '新 文件 [1].txt', version: s.version })).diff, /<script>/);
  const body = request(s, { paths: ['one.txt', '新 文件 [1].txt'], action: 'commit-push' });
  const first = await service.action(body); assert.equal(first.committed, true); assert.equal(first.pushed, true);
  assert.deepEqual(await service.action(body), first);
  assert.equal(await git('show', 'HEAD:two.txt'), 'before'); assert.equal(await git('diff', '--cached', '--name-only'), 'two.txt');
  assert.equal(await git('rev-list', '--count', 'HEAD'), '2'); assert.equal(await git('rev-parse', 'HEAD'), await git('rev-parse', 'origin/main'));
});

test('Git submit rejects stale previews, unchecked confirmation, hidden paths, conflicts, locks and nested projects', async t => {
  const { cwd, git, desk, service } = await fixture(t);
  await writeFile(path.join(cwd, 'one.txt'), 'first\n'); const s = await service.snapshot({ cwd });
  await writeFile(path.join(cwd, 'one.txt'), 'external change\n');
  await assert.rejects(service.action(request(s)), /状态已变化/);
  const current = await service.snapshot({ cwd });
  await assert.rejects(service.action(request(current, { confirmed: false })), /确认/);
  await assert.rejects(service.action(request(current, { paths: ['../outside'] })), /变更列表/);
  await writeFile(path.join(cwd, '.env'), 'test secret'); const filtered = await service.snapshot({ cwd }); assert.ok(!filtered.files.some(f => f.path === '.env')); assert.equal(filtered.excluded, 1);
  desk.gitLocked = true; await assert.rejects(service.action(request(filtered)), /另一个 Git/); desk.gitLocked = false;
  await mkdir(path.join(cwd, 'nested')); await assert.rejects(service.snapshot({ cwd: path.join(cwd, 'nested') }), /根目录/);
  await writeFile(path.join(cwd, '.git', 'MERGE_HEAD'), (await git('rev-parse', 'HEAD')) + '\n');
  const merging = await service.snapshot({ cwd }); assert.match(merging.blocked, /合并/); await assert.rejects(service.action(request(merging)), /合并/);
});

test('Git submit supports deletion and reports partial push failures without making a second commit', async t => {
  const { cwd, root, git, desk, service } = await fixture(t);
  await rename(path.join(cwd, 'remove.txt'), path.join(root, 'recoverable-remove.txt'));
  const s = await service.snapshot({ cwd }); assert.ok(s.files.find(f => f.path === 'remove.txt').deleted);
  assert.match((await service.diff({ cwd, path: 'remove.txt', version: s.version })).diff, /deleted file/);
  const original = desk.git.bind(desk); desk.git = async (cwd, args) => { if (args.includes('push')) throw new Error('simulated remote failure'); return original(cwd, args); };
  const result = await service.action(request(s, { paths: ['remove.txt'], action: 'commit-push' }));
  assert.equal(result.committed, true); assert.equal(result.pushed, false); assert.match(result.pushError, /simulated remote failure/);
  desk.git = original;
  const retry = await service.snapshot({ cwd }); assert.equal(retry.ahead, 1);
  const pushed = await service.action(request(retry, { action: 'push', paths: [], head: result.commit })); assert.equal(pushed.pushed, true); assert.equal(pushed.committed, false);
  assert.equal(await git('rev-list', '--count', 'HEAD'), '2');
});
