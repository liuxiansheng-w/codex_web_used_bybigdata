import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Workbench } from '../lib/workbench.mjs';
import { ProjectFiles } from '../lib/project-files.mjs';
import { GitSubmit } from '../lib/git-submit.mjs';
const run = promisify(execFile);

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-compare-'))), cwd = path.join(root, 'local'), remote = path.join(root, 'remote.git'), peer = path.join(root, 'peer');
  await mkdir(cwd);
  const command = dir => async (...args) => (await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: dir })).stdout.trim();
  const git = command(cwd); await git('init', '-b', 'main');
  await writeFile(path.join(cwd, 'shared.txt'), 'base\n'); await writeFile(path.join(cwd, 'local.txt'), 'base\n');
  await git('add', '.'); await git('commit', '-m', 'base'); await git('init', '--bare', remote); await git('remote', 'add', 'origin', remote); await git('push', '-u', 'origin', 'main');
  await run('git', ['clone', '-b', 'main', remote, peer]); const peerGit = command(peer);
  const desk = new Workbench({ bridge: new EventEmitter() }, new ProjectFiles(), root); t.after(() => clearInterval(desk.timer));
  return { root, cwd, peer, git, peerGit, desk, service: new GitSubmit(desk) };
}
const fetchBody = state => ({ cwd: state.cwd, version: state.version, action: 'fetch', confirmed: true, operationId: randomUUID() });

test('compare cached upstream, fetch explicitly, and show disk, committed and remote changes without changing HEAD, index or files', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.peer, 'shared.txt'), 'remote version\n'); await writeFile(path.join(f.peer, 'remote-only.txt'), 'only upstream\n'); await writeFile(path.join(f.peer, '.env'), 'FAKE_SECRET\n');
  await f.peerGit('add', '-f', 'shared.txt', 'remote-only.txt', '.env'); await f.peerGit('commit', '-m', 'remote update'); await f.peerGit('push', 'origin', 'main');
  await writeFile(path.join(f.cwd, 'local.txt'), 'committed locally\n'); await f.git('add', 'local.txt'); await f.git('commit', '-m', 'local update');
  await writeFile(path.join(f.cwd, 'shared.txt'), 'staged version\n'); await f.git('add', 'shared.txt'); await writeFile(path.join(f.cwd, 'shared.txt'), 'disk version\n');
  await writeFile(path.join(f.cwd, 'untracked.txt'), 'new disk file\n');
  const head = await f.git('rev-parse', 'HEAD'), cachedHead = await f.git('rev-parse', 'origin/main'), index = await f.git('diff', '--cached'), local = await f.git('status', '--porcelain');
  let state = await f.service.snapshot({ cwd: f.cwd }); assert.equal(state.remoteComparisonAvailable, true);
  let comparison = await f.service.remoteComparison({ cwd: f.cwd }); assert.equal(comparison.target, cachedHead); assert.equal(comparison.ahead, 1); assert.equal(comparison.behind, 0);
  assert.equal(await f.git('rev-parse', 'origin/main'), cachedHead, 'comparison must not fetch');
  const fetched = await f.service.action(fetchBody(state)); assert.equal(fetched.fetched, true); assert.notEqual(fetched.target, cachedHead);
  assert.equal(await f.git('rev-parse', 'HEAD'), head); assert.equal(await f.git('diff', '--cached'), index); assert.equal(await f.git('status', '--porcelain'), local); assert.equal(await readFile(path.join(f.cwd, 'shared.txt'), 'utf8'), 'disk version\n');
  comparison = await f.service.remoteComparison({ cwd: f.cwd }); assert.equal(comparison.target, fetched.target); assert.equal(comparison.ahead, 1); assert.equal(comparison.behind, 1);
  assert.deepEqual(new Set(comparison.files.map(f => f.path)), new Set(['shared.txt', 'local.txt', 'remote-only.txt', 'untracked.txt'])); assert.equal(comparison.excluded, 1);
  const shared = await f.service.remoteDiff({ cwd: f.cwd, path: 'shared.txt', version: comparison.version }); assert.match(shared.diff, /-remote version/); assert.match(shared.diff, /\+disk version/); assert.doesNotMatch(shared.diff, /staged version/);
  const onlyRemote = await f.service.remoteDiff({ cwd: f.cwd, path: 'remote-only.txt', version: comparison.version }); assert.match(onlyRemote.diff, /-only upstream/);
  const untracked = await f.service.remoteDiff({ cwd: f.cwd, path: 'untracked.txt', version: comparison.version }); assert.match(untracked.diff, /\+new disk file/);
  await assert.rejects(f.service.remoteDiff({ cwd: f.cwd, path: '.env', version: comparison.version }), /可比较列表/);
  await writeFile(path.join(f.cwd, 'shared.txt'), 'changed after listing\n'); await assert.rejects(f.service.remoteDiff({ cwd: f.cwd, path: 'shared.txt', version: comparison.version }), /状态已变化/);
});

test('fetch failure keeps the prior remote ref and missing upstream is explicit', async t => {
  const f = await fixture(t), before = await f.git('rev-parse', 'origin/main'), state = await f.service.snapshot({ cwd: f.cwd });
  const original = f.desk.git.bind(f.desk); f.desk.git = async (cwd, args) => { if (args[0] === 'fetch') throw new Error('offline https://user:FAKE_TOKEN@example.invalid/repo'); return original(cwd, args); };
  const result = await f.service.action(fetchBody(state)); assert.equal(result.fetched, false); assert.match(result.fetchError, /本地缓存/); assert.doesNotMatch(result.fetchError, /FAKE_TOKEN/); assert.equal(await f.git('rev-parse', 'origin/main'), before);
  f.desk.git = original; await f.git('branch', '--unset-upstream'); const comparison = await f.service.remoteComparison({ cwd: f.cwd }); assert.equal(comparison.available, false); assert.match(comparison.reason, /未配置远程上游/);
});

test('untracked same-name remote file is not misrepresented as a deletion', async t => {
  const f = await fixture(t); await f.peerGit('rm', 'shared.txt'); await f.peerGit('commit', '-m', 'remove upstream'); await f.peerGit('push', 'origin', 'main');
  await f.git('rm', 'shared.txt'); await f.git('commit', '-m', 'remove locally'); await writeFile(path.join(f.cwd, 'shared.txt'), 'untracked local version\n');
  const comparison = await f.service.remoteComparison({ cwd: f.cwd }); const file = comparison.files.find(f => f.path === 'shared.txt'); assert.equal(file.sameNameUntracked, true);
  const diff = await f.service.remoteDiff({ cwd: f.cwd, path: 'shared.txt', version: comparison.version }); assert.match(diff.diff, /同名的未跟踪文件/);
});

test('large projects compare more than 2000 changes without dropping later files', async t => {
  const f = await fixture(t), folder = path.join(f.cwd, 'many-files'); await mkdir(folder);
  for (let offset = 0; offset < 2101; offset += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 2101 - offset) }, (_, index) => writeFile(path.join(folder, `file-${String(offset + index).padStart(4, '0')}.txt`), 'fixture\n')));
  }
  const state = await f.service.snapshot({ cwd: f.cwd }); assert.equal(state.files.length, 2101);
  const comparison = await f.service.remoteComparison({ cwd: f.cwd }); assert.equal(comparison.files.length, 2101);
  const last = comparison.files.find(file => file.path === 'many-files/file-2100.txt'); assert.equal(last.untracked, true);
  const diff = await f.service.remoteDiff({ cwd: f.cwd, path: last.path, version: comparison.version }); assert.match(diff.diff, /\+fixture/);
});
