import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ThreadOrganization } from '../lib/thread-organization.mjs';
import { Workspace } from '../lib/workspace.mjs';
import { createApplication } from '../server.mjs';

async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-thread-folders-')));
  const stateDir = path.join(cwd, 'state');
  const verified = [];
  const store = new ThreadOrganization(stateDir, { verifyThread: async (id, project) => { verified.push({ id, project }); return id !== 'foreign' && project === cwd; } });
  return { cwd, stateDir, store, verified };
}

test('folders, moves and pins persist through service recreation and remain scoped to a project', async () => {
  const { cwd, stateDir, store, verified } = await fixture();
  let value = await store.list(cwd);
  value = await store.action({ cwd, revision: value.revision, action: 'create-folder', name: '  日常分析  ' });
  const first = value.folders[0].id;
  value = await store.action({ cwd, revision: value.revision, action: 'create-folder', name: '开发' });
  const second = value.folders[1].id;
  value = await store.action({ cwd, revision: value.revision, action: 'move', threadId: 't1', folderId: first });
  value = await store.action({ cwd, revision: value.revision, action: 'pin', threadId: 't1', pinned: true });
  value = await store.action({ cwd, revision: value.revision, action: 'move', threadId: 't1', folderId: second });
  assert.deepEqual(value.threads, [{ id: 't1', folderId: second, pinned: true }]);
  assert.equal(value.folders[0].name, '日常分析');
  assert.deepEqual(await new ThreadOrganization(stateDir).list(cwd), value);
  assert.equal((await stat(store.filename(cwd))).mode & 0o777, 0o600);
  const other = path.join(cwd, 'other'); await mkdir(other);
  assert.deepEqual((await store.list(other)).folders, []);
  value = await store.action({ cwd, revision: value.revision, action: 'remove-folder', folderId: second });
  assert.deepEqual(value.threads, [{ id: 't1', folderId: null, pinned: true }]);
  assert.equal(verified.length, 3, 'organizing only verifies membership, never resumes or mutates a native thread');
});

test('stale versions, invalid folders and foreign threads cannot overwrite organization', async () => {
  const { cwd, store } = await fixture();
  const created = await store.action({ cwd, revision: 0, action: 'create-folder', name: '分析' });
  for (const payload of [
    { revision: 0, action: 'create-folder', name: 'stale' },
    { revision: 1, action: 'create-folder', name: '分析' },
    { revision: 1, action: 'create-folder', name: ' \n ' },
    { revision: 1, action: 'move', threadId: 't1', folderId: 'missing' },
    { revision: 1, action: 'pin', threadId: 'foreign', pinned: true },
    { revision: 1, action: 'pin', threadId: '../escape', pinned: true },
  ]) await assert.rejects(store.action({ cwd, ...payload }));
  assert.deepEqual(await store.list(cwd), created);
  const raced = await Promise.allSettled(['一', '二'].map(name => store.action({ cwd, revision: 1, action: 'create-folder', name })));
  assert.equal(raced.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(raced.find(item => item.status === 'rejected').reason.status, 409);
  const value = await store.list(cwd);
  assert.equal(value.revision, 2); assert.equal(value.folders.length, 2);
  await store.action({ cwd, revision: 2, action: 'rename-folder', folderId: created.folders[0].id, name: '重命名' });
  assert.equal((await store.list(cwd)).folders[0].name, '重命名', 'a rejected operation must not poison the save queue');
});

test('legacy pins migrate once and cannot restore an explicitly removed pin', async () => {
  const { cwd, store } = await fixture();
  let value = await store.action({ cwd, revision: 0, action: 'import-pins', threadIds: ['t1', 't1', 't2'] });
  assert.deepEqual(value.threads.map(item => item.pinned), [true, true]);
  value = await store.action({ cwd, revision: value.revision, action: 'pin', threadId: 't1', pinned: false });
  value = await store.action({ cwd, revision: value.revision, action: 'import-pins', threadIds: ['t1'] });
  assert.equal(value.threads.find(item => item.id === 't1').pinned, false);
});

test('batch moves commit one revision, retain pins, and restore all members after restart', async () => {
  const { cwd, stateDir, store, verified } = await fixture();
  let value = await store.action({ cwd, revision: 0, action: 'create-folder', name: '汇总' });
  const folderId = value.folders[0].id;
  value = await store.action({ cwd, revision: value.revision, action: 'pin', threadId: 't1', pinned: true });
  const revision = value.revision;
  value = await store.action({ cwd, revision, action: 'move-many', threadIds: ['t1', 't2', 't3'], folderId });
  assert.equal(value.revision, revision + 1); assert.equal(value.threads.length, 3);
  assert.ok(value.threads.every(thread => thread.folderId === folderId)); assert.equal(value.threads.find(thread => thread.id === 't1').pinned, true);
  assert.deepEqual(await new ThreadOrganization(stateDir).list(cwd), value); assert.equal((await stat(store.filename(cwd))).mode & 0o777, 0o600);
  value = await store.action({ cwd, revision: value.revision, action: 'move-many', threadIds: ['t1', 't2'], folderId: null });
  assert.equal(value.threads.find(thread => thread.id === 't1').pinned, true); assert.equal(value.threads.find(thread => thread.id === 't3').folderId, folderId);
  assert.deepEqual(verified.slice(-2).map(item => item.id), ['t1', 't2']);
});

test('a stale, invalid, foreign or partly unavailable batch leaves every stored assignment untouched', async () => {
  const { cwd, store } = await fixture();
  const value = await store.action({ cwd, revision: 0, action: 'create-folder', name: '目标' }), folderId = value.folders[0].id;
  for (const payload of [
    { threadIds: [] }, { threadIds: ['t1', 't1'] }, { threadIds: ['t1', '../escape'] },
    { threadIds: ['t1', 'foreign', 't3'] }, { threadIds: ['t1'], folderId: 'gone' },
    { threadIds: Array.from({ length: 101 }, (_, index) => 't' + index) }, { threadIds: ['t1'], revision: 0 },
  ]) {
    await assert.rejects(store.action({ cwd, revision: value.revision, action: 'move-many', folderId, ...payload }));
    assert.deepEqual(await store.list(cwd), value);
  }
  const results = await Promise.allSettled([['t1', 't2'], ['t3', 't4']].map(threadIds => store.action({ cwd, revision: value.revision, action: 'move-many', folderId, threadIds })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await store.list(cwd)).threads.length, 2);
});

test('corrupted or symlinked metadata is preserved and never reset during an attempted edit', async () => {
  const { cwd, store } = await fixture();
  await mkdir(store.root, { recursive: true });
  await writeFile(store.filename(cwd), '{broken');
  await assert.rejects(store.action({ cwd, revision: 0, action: 'create-folder', name: '不能覆盖' }), /读取失败/);
  assert.equal(await readFile(store.filename(cwd), 'utf8'), '{broken');
  const second = await fixture();
  await mkdir(second.store.root, { recursive: true });
  await symlink(store.filename(cwd), second.store.filename(second.cwd));
  await assert.rejects(second.store.list(second.cwd), /读取失败/);
  assert.equal(await readFile(store.filename(cwd), 'utf8'), '{broken');
});

test('old organized conversations appear on the first page without loading turns or consuming normal pagination', async () => {
  const { cwd } = await fixture(), bridge = new EventEmitter(), calls = [];
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    assert.equal(method, 'thread/list');
    return params.cursor ? { data: [{ id: 'old', cwd, name: '较早的会话', updatedAt: 1 }, { id: 'other', cwd, name: '普通旧会话' }], nextCursor: null }
      : { data: [{ id: 'recent', cwd, name: '最近会话', updatedAt: 2 }], nextCursor: 'page-2' };
  };
  const workspace = new Workspace(bridge, cwd);
  const value = await workspace.list(cwd, null, { includeIds: ['old'] });
  assert.deepEqual(value.threads.map(item => item.id), ['recent', 'old']);
  assert.equal(value.nextCursor, 'page-2'); assert.equal(value.organizationPartial, false);
  assert.equal(calls.length, 2);
  const archived = await workspace.list(cwd, null, { archived: true, includeIds: ['old'] });
  assert.equal(archived.threads.every(item => item.archived), true);
  assert.equal(calls.slice(2).every(call => call.params.archived), true);
});

test('content search retains bounded native pagination even when many older threads are organized', async () => {
  const { cwd } = await fixture(), bridge = new EventEmitter(), calls = [];
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') return { data: [{ id: 'recent', cwd, name: '最近会话' }], nextCursor: 'next' };
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd, turns: [{ items: [{ type: 'agentMessage', text: '找到关键字' }] }] } };
    throw new Error(method);
  };
  const workspace = new Workspace(bridge, cwd);
  const value = await workspace.list(cwd, null, { includeIds: ['old-1', 'old-2'], scope: 'content', search: '关键字' });
  assert.deepEqual(value.threads.map(item => item.id), ['recent']); assert.equal(value.nextCursor, 'next');
  assert.equal(calls.filter(call => call.method === 'thread/list').length, 1);
  assert.equal(calls.filter(call => call.method === 'thread/read').length, 1);
});

test('organization HTTP routes require authentication and CSRF, verify membership without changing native threads', async t => {
  const { cwd, stateDir } = await fixture();
  const bridge = new EventEmitter(); bridge.ready = true; bridge.start = async () => {}; bridge.close = () => {};
  const calls = [];
  bridge.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: params.threadId === 'foreign' ? '/private/tmp' : cwd } };
    throw new Error('Unexpected runtime operation: ' + method);
  };
  const app = createApplication({ cwd, stateDir, bridge });
  app.workspace.bootstrap = async () => ({ connected: true, cwd, models: [] });
  await app.start(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(base); await response.text();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const { csrf, threadOrganizationBatch } = await (await fetch(base + '/api/bootstrap', { headers: { cookie } })).json(); assert.equal(threadOrganizationBatch, true);
  const route = base + '/api/thread-organization';
  assert.equal((await fetch(route + '?cwd=' + encodeURIComponent(cwd))).status, 401);
  assert.equal((await fetch(route, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, revision: 0, action: 'create-folder', name: '测试' }) })).status, 403);
  const post = async body => { const response = await fetch(route, { method: 'POST', headers: { cookie, Origin: base, 'Content-Type': 'application/json', 'X-Codex-CSRF': csrf }, body: JSON.stringify({ cwd, ...body }) }); return { status: response.status, data: await response.json() }; };
  const created = await post({ revision: 0, action: 'create-folder', name: '测试' }); assert.equal(created.status, 200); assert.equal(calls.length, 0);
  const moved = await post({ revision: 1, action: 'move', threadId: 'fictional-thread', folderId: created.data.folders[0].id }); assert.equal(moved.status, 200);
  const foreign = await post({ revision: 2, action: 'pin', threadId: 'foreign', pinned: true }); assert.equal(foreign.status, 409);
  assert.equal((await fetch(route, { method: 'POST', headers: { cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, revision: 2, action: 'move-many', threadIds: ['fictional-thread', 'second'], folderId: null }) })).status, 403);
  const rejectedBatch = await post({ revision: 2, action: 'move-many', threadIds: ['fictional-thread', 'foreign'], folderId: null }); assert.equal(rejectedBatch.status, 409);
  const batch = await post({ revision: 2, action: 'move-many', threadIds: ['fictional-thread', 'second'], folderId: null }); assert.equal(batch.status, 200); assert.equal(batch.data.revision, 3); assert.equal(batch.data.threads.length, 2);
  assert.ok(calls.every(call => call.method === 'thread/read' && call.params.includeTurns === false));
  assert.equal((await fetch(base + '/thread-organization.js')).status, 200);
});
