import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, rename, mkdir } from 'node:fs/promises';
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
async function peer(f) {
  const cwd = path.join(f.root, 'peer');
  await exec('git', ['clone', '-b', 'main', f.remote, cwd]);
  const git = async (...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Peer fixture', '-c', 'user.email=peer@example.invalid', ...args], { cwd })).stdout.trim();
  return { cwd, git, async publish(name = 'one.txt', content = 'remote update\n') { await writeFile(path.join(cwd, name), content); await git('add', '-f', '--', name); await git('commit', '-m', 'remote fixture update'); await git('push', 'origin', 'main'); return git('rev-parse', 'HEAD'); } };
}

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

test('Git pull fetches the configured upstream and fast-forwards once, separately from the push URL', async t => {
  const f = await fixture(t), other = await peer(f);
  const remoteHead = await other.publish();
  await other.git('branch', 'unrelated'); await other.git('push', 'origin', 'unrelated');
  await f.git('remote', 'set-url', '--push', 'origin', path.join(f.root, 'different-push-destination.git'));
  const s = await f.service.snapshot({ cwd: f.cwd }); assert.equal(s.behind, 0, 'the cached count must not disable a fresh pull'); assert.equal(s.pullBlocked, ''); assert.notEqual(s.fetchUrl, s.remoteUrl);
  const calls = [], original = f.desk.git.bind(f.desk); f.desk.git = (cwd, args) => { calls.push(args); return original(cwd, args); };
  const body = request(s, { action: 'pull' }), result = await f.service.action(body);
  assert.equal(result.pulled, true); assert.equal(result.updated, true); assert.equal(result.head, remoteHead);
  assert.equal(await readFile(path.join(f.cwd, 'one.txt'), 'utf8'), 'remote update\n');
  assert.deepEqual(await f.service.action(body), result); assert.equal(calls.filter(args => args[0] === 'fetch').length, 1);
  assert.equal(await f.git('rev-parse', 'HEAD'), await f.git('rev-parse', 'origin/main'));
  assert.equal(await f.git('for-each-ref', '--format=%(refname)', 'refs/remotes/origin/unrelated'), '');
  const again = await f.service.action(request(await f.service.snapshot({ cwd: f.cwd }), { action: 'pull' })); assert.equal(again.pulled, true); assert.equal(again.updated, false);
});

test('Git pull preserves dirty, excluded and concurrently edited files without stashing them', async t => {
  const f = await fixture(t), other = await peer(f); await other.publish();
  const clean = await f.service.snapshot({ cwd: f.cwd }), before = clean.head;
  await writeFile(path.join(f.cwd, '.env'), 'fictional local setting\n');
  await assert.rejects(f.service.action(request(clean, { action: 'pull' })), /状态已变化/);
  const dirty = await f.service.snapshot({ cwd: f.cwd }); assert.equal(dirty.files.length, 0); assert.match(dirty.pullBlocked, /未提交/);
  await assert.rejects(f.service.action(request(dirty, { action: 'pull' })), /未提交/);
  await rename(path.join(f.cwd, '.env'), path.join(f.root, 'preserved-local-setting'));
  const fresh = await f.service.snapshot({ cwd: f.cwd }), original = f.desk.git.bind(f.desk);
  f.desk.git = async (cwd, args) => { const output = await original(cwd, args); if (args[0] === 'fetch') await writeFile(path.join(f.cwd, 'one.txt'), 'concurrent local edit\n'); return output; };
  const result = await f.service.action(request(fresh, { action: 'pull' })); assert.equal(result.pulled, false); assert.equal(result.fetched, true); assert.match(result.pullError, /下载期间/);
  assert.equal(await f.git('rev-parse', 'HEAD'), before); assert.equal(await readFile(path.join(f.cwd, 'one.txt'), 'utf8'), 'concurrent local edit\n'); assert.equal(await f.git('stash', 'list'), '');
});

test('Git pull refuses divergent history and never overwrites ignored local files', async t => {
  const f = await fixture(t), other = await peer(f); await other.publish();
  await writeFile(path.join(f.cwd, 'two.txt'), 'local committed work\n'); await f.git('add', 'two.txt'); await f.git('commit', '-m', 'local work');
  const localHead = await f.git('rev-parse', 'HEAD');
  const result = await f.service.action(request(await f.service.snapshot({ cwd: f.cwd }), { action: 'pull' }));
  assert.equal(result.pulled, false); assert.match(result.pullError, /分叉/); assert.equal(await f.git('rev-parse', 'HEAD'), localHead); assert.equal(await f.git('status', '--porcelain'), '');

  const g = await fixture(t); await writeFile(path.join(g.cwd, '.gitignore'), 'local-only.txt\n'); await g.git('add', '.gitignore'); await g.git('commit', '-m', 'ignore fixture'); await g.git('push');
  const second = await peer(g); await writeFile(path.join(g.cwd, 'local-only.txt'), 'keep this local content\n'); await second.publish('local-only.txt', 'remote tracked content\n');
  const initial = await g.service.snapshot({ cwd: g.cwd }); assert.equal(initial.pullBlocked, '');
  const blocked = await g.service.action(request(initial, { action: 'pull' })); assert.equal(blocked.pulled, false);
  assert.equal(await g.git('rev-parse', 'HEAD'), initial.head); assert.equal(await readFile(path.join(g.cwd, 'local-only.txt'), 'utf8'), 'keep this local content\n'); assert.equal(await g.git('stash', 'list'), '');
});
