import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, writeFile, readFile, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectFiles } from '../lib/project-files.mjs';
import { FileTools } from '../lib/file-tools.mjs';
import { Workspace } from '../lib/workspace.mjs';
import { Workbench } from '../lib/workbench.mjs';
import { languageTools } from '../lib/language-tools.mjs';
import { validateElicitation } from '../lib/mcp-forms.mjs';
import { createApplication } from '../server.mjs';
import { markdown } from '../public/markdown.js';
import { createDraftStore } from '../public/interactions.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

async function fixture() { const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-workbench-test-'))); const files = new ProjectFiles(); return { cwd, files, tools: new FileTools(files, { trash: path.join(cwd, 'test-trash') }) }; }
class Mock extends EventEmitter {
  ready = true; calls = []; replies = []; next = 0;
  async start() {} close() {}
  respond(id, value) { this.replies.push({ id, value }); }
  unsupported() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'configRequirements/read') return { requirements: null };
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [] };
    if (method === 'skills/list') return { data: [] };
    if (method === 'plugin/installed') return { marketplaces: [] };
    if (method === 'collaborationMode/list') return { data: [] };
    if (method === 'thread/list') return { data: [], nextCursor: null };
    if (method === 'thread/fork') return { thread: { id: 'fork', cwd: '/private/tmp', turns: [] } };
    if (['thread/start', 'thread/resume'].includes(method)) return { thread: { id: params.threadId || `thread-${++this.next}`, cwd: params.cwd || '/private/tmp', turns: [] }, model: 'test' };
    if (['turn/start', 'review/start'].includes(method)) return { turn: { id: 'turn-1' }, reviewThreadId: params.threadId };
    if (method === 'command/exec') return new Promise(resolve => { this.completeCommand = resolve; });
    if (method === 'mcpServerStatus/list') return { data: [{ name: 'test', authStatus: 'notLoggedIn', tools: { foo: {} } }], nextCursor: null };
    if (method === 'mcpServer/oauth/login') return { authorizationUrl: 'https://example.test/auth' };
    return {};
  }
}
function system(t, stateDir = '/private/tmp/nonexistent-codex-tests') { const bridge = new Mock(), space = new Workspace(bridge, '/private/tmp'), desk = new Workbench(space, new ProjectFiles(), stateDir); t.after(() => { desk.close(); bridge.ready = false; for (const timer of space.timers.values()) clearTimeout(timer); }); return { bridge, space, desk }; }

test('project search is bounded and excludes secrets, dependencies, ignored trees and symlinks', async () => {
  const { cwd, tools } = await fixture(); await mkdir(path.join(cwd, 'src')); await mkdir(path.join(cwd, 'AIdata')); await mkdir(path.join(cwd, 'node_modules'));
  for (const name of ['src/example.py', '.env', 'AIdata/secret.txt', 'node_modules/dependency.txt']) await writeFile(path.join(cwd, name), 'Needle\nneedle\n');
  await symlink(path.join(cwd, 'AIdata'), path.join(cwd, 'link'));
  const result = await tools.search({ cwd, query: 'needle' }); assert.deepEqual(result.results.map(r => r.path), ['src/example.py', 'src/example.py']);
  assert.equal((await tools.search({ cwd, query: 'Needle', caseSensitive: true })).results.length, 1);
  assert.equal((await tools.search({ cwd, query: 'example', filenames: true })).results.length, 1);
  await assert.rejects(tools.search({ cwd, query: '' }), /搜索/);
});

test('project replace previews are versioned, single-use and report partial failure without overwriting', async () => {
  const { cwd, files, tools } = await fixture(); for (const name of ['a.txt', 'b.txt']) await writeFile(path.join(cwd, name), 'old\r\n');
  const preview = await tools.previewReplace({ cwd, query: 'old', replacement: 'new', paths: ['a.txt', 'b.txt'] });
  await writeFile(path.join(cwd, 'b.txt'), 'external\n');
  let result = await tools.applyReplace({ id: preview.id, confirmed: true }); assert.deepEqual(result.saved, []); assert.match(result.error, /变化/); assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'old\r\n');
  const retry = await tools.previewReplace({ cwd, query: 'old', replacement: 'new', paths: ['a.txt'] });
  result = await tools.applyReplace({ id: retry.id, confirmed: true }); assert.deepEqual(result.saved, ['a.txt']); assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'new\r\n');
  await assert.rejects(tools.applyReplace({ id: retry.id, confirmed: true }), /过期/);
  await writeFile(path.join(cwd, 'b.txt'), 'new\n'); const partial = await tools.previewReplace({ cwd, query: 'new', replacement: 'next', paths: ['a.txt', 'b.txt'] });
  const original = files.save.bind(files); files.save = async file => { if (file.path === 'b.txt') throw new Error('simulated external edit'); return original(file); };
  result = await tools.applyReplace({ id: partial.id, confirmed: true }); assert.deepEqual(result.saved, ['a.txt']); assert.equal(result.partial, true);
});

test('file create/move/trash cannot traverse, overwrite, move roots or lose the recovery copy', async () => {
  const { cwd, files, tools } = await fixture();
  for (const relative of ['../escape', '.env', 'AIdata']) await assert.rejects(tools.mutate({ cwd, action: 'createFile', path: relative }));
  await tools.mutate({ cwd, action: 'createFolder', path: 'src' }); await tools.mutate({ cwd, action: 'createFile', path: 'src/a.py' });
  await assert.rejects(tools.mutate({ cwd, action: 'createFile', path: 'src/a.py' }), /已存在/);
  const file = await files.read({ cwd, path: 'src/a.py' });
  await assert.rejects(tools.mutate({ cwd, path: file.path, action: 'move', target: 'src/b.py', version: file.version }), /确认/);
  const moved = await tools.mutate({ cwd, path: file.path, action: 'move', target: 'src/b.py', version: file.version, confirmed: true });
  assert.equal(await readFile(moved.recovery, 'utf8'), ''); await assert.rejects(files.read({ cwd, path: 'src/a.py' }));
  const newFile = await files.read({ cwd, path: 'src/b.py' }); const trashed = await tools.mutate({ ...newFile, action: 'trash', confirmed: true }); assert.equal(await readFile(trashed.recovery, 'utf8'), '');
  await assert.rejects(tools.mutate({ cwd, path: '', action: 'trash', confirmed: true }), /根目录/);
});

test('thread management uses real RPC, readonly forks, title search and rejects busy mutations', async t => {
  const { bridge, space } = system(t); space.importThread({ id: 'one', cwd: '/private/tmp', turns: [] });
  await space.threadAction({ threadId: 'one', action: 'rename', name: 'Renamed' }); assert.equal(space.threads.get('one').title, 'Renamed');
  await space.list('/private/tmp', null, { search: 'needle', archived: true }); assert.equal(bridge.calls.at(-1).params.searchTerm, 'needle'); assert.equal(bridge.calls.at(-1).params.archived, true);
  await space.threadAction({ threadId: 'one', action: 'fork' }); const fork = bridge.calls.find(c => c.method === 'thread/fork'); assert.equal(fork.params.sandbox, 'read-only'); assert.equal(fork.params.deferGoalContinuation, true);
  await space.threadAction({ threadId: 'one', action: 'archive' }); assert.equal(space.threads.get('one').archived, true);
  await space.threadAction({ threadId: 'one', action: 'unarchive' }); assert.equal(space.threads.get('one').archived, false);
  space.threads.get('one').busy = true; await assert.rejects(space.threadAction({ threadId: 'one', action: 'rename', name: 'x' }), /停止/);
});

test('steering pins active turn and queue preserves permissions, pauses on stop and forbids full access', async t => {
  const { bridge, space } = system(t); const { threadId } = await space.send({ cwd: '/private/tmp', text: 'first', mode: 'read-only' }); const thread = space.threads.get(threadId);
  await space.followup({ threadId, text: 'more', behavior: 'steer' }); assert.equal(bridge.calls.at(-1).method, 'turn/steer'); assert.equal(bridge.calls.at(-1).params.expectedTurnId, 'turn-1');
  await space.followup({ threadId, text: 'next', behavior: 'queue' }); assert.equal(thread.queue.length, 1);
  space.notification({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } }); await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(thread.queue.length, 0); assert.equal(bridge.calls.at(-1).method, 'turn/start'); assert.equal(bridge.calls.at(-1).params.sandboxPolicy.type, 'readOnly');
  thread.mode = 'danger-full-access'; await assert.rejects(space.followup({ threadId, text: 'unsafe', behavior: 'queue' }), /完全访问/);
  thread.mode = 'read-only'; await space.followup({ threadId, text: 'hold', behavior: 'queue' });
  space.notification({ method: 'turn/completed', params: { threadId, turn: { status: 'interrupted' } } }); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(thread.queue.length, 1); assert.equal(thread.queuePaused, true);
});

test('native reviews use review/start with readonly resume; usage and structured output render without reasoning', async t => {
  const { bridge, space } = system(t); const thread = space.importThread({ id: 'one', cwd: '/private/tmp', turns: [] });
  await space.review({ threadId: 'one', target: { type: 'baseBranch', branch: 'main' } });
  assert.equal(bridge.calls.at(-1).method, 'review/start'); assert.equal(bridge.calls.find(c => c.method === 'thread/resume').params.sandbox, 'read-only');
  space.notification({ method: 'thread/tokenUsage/updated', params: { threadId: 'one', tokenUsage: { total: { totalTokens: 100 } } } }); assert.equal(thread.tokenUsage.total.totalTokens, 100);
  space.notification({ method: 'item/completed', params: { threadId: 'one', item: { id: 'tool', type: 'mcpToolCall', result: { content: [{ type: 'text', text: '<script>inert</script>' }] } } } }); assert.match(thread.items.at(-1).text, /<script>/);
  space.notification({ method: 'item/completed', params: { threadId: 'one', item: { id: 'private', type: 'reasoning', text: 'not visible' } } }); assert.ok(!thread.items.some(item => item.id === 'private'));
});

test('MCP forms validate types/required/enums and never auto-authorize', t => {
  const { bridge, space } = system(t); const thread = space.importThread({ id: 'one', cwd: '/private/tmp', turns: [] });
  const schema = { type: 'object', required: ['color'], properties: { color: { type: 'string', enum: ['blue'] }, count: { type: 'integer', minimum: 1 } } };
  assert.throws(() => validateElicitation(schema, { color: 'red' }), /选项/); assert.throws(() => validateElicitation(schema, { color: 'blue', count: 1.2 }), /数值/);
  const multi = { type: 'object', properties: { items: { type: 'array', minItems: 1, items: { enum: ['a', 'b'] } }, date: { type: 'string', format: 'date' } } };
  validateElicitation(multi, { items: ['a', 'b'], date: '2026-09-17' });
  assert.throws(() => validateElicitation(multi, { items: ['a', 'a'] }), /多选/); assert.throws(() => validateElicitation(multi, { date: '2026-02-30' }), /日期/);
  space.serverRequest({ id: 1, method: 'mcpServer/elicitation/request', params: { threadId: 'one', serverName: 'test', mode: 'form', requestedSchema: schema } });
  assert.equal(bridge.replies.length, 0); const key = thread.requests[0].key;
  assert.throws(() => space.respond({ key, decision: 'accept', content: {} }), /填写/);
  space.respond({ key, decision: 'accept', content: { color: 'blue' } }); assert.deepEqual(bridge.replies[0].value, { action: 'accept', content: { color: 'blue' } });
  assert.throws(() => space.respond({ key, decision: 'accept', content: { color: 'blue' } }), /结束/);
});

test('terminal uses explicit bounded sandbox, streams output, accepts stdin and terminates only owned processes', async t => {
  const { desk, bridge } = system(t); await assert.rejects(desk.terminal({ cwd: '/private/tmp', command: 'not actually run' }), /确认/);
  const { id } = await desk.terminal({ cwd: '/private/tmp', command: 'test-only-command', confirmed: true }); const call = bridge.calls.at(-1); assert.equal(call.params.sandboxPolicy.type, 'readOnly'); assert.equal(call.params.timeoutMs, 300000);
  bridge.emit('notification', { method: 'command/exec/outputDelta', params: { processId: id, deltaBase64: Buffer.from('output').toString('base64') } }); assert.equal(desk.terminalList()[0].output, 'output'); assert.ok(!JSON.stringify(desk.terminalList()).includes('decoder'));
  await desk.terminalAction({ id, action: 'input', text: 'test' }); assert.equal(bridge.calls.at(-1).method, 'command/exec/write');
  await desk.terminalAction({ id, action: 'stop' }); assert.equal(bridge.calls.at(-1).method, 'command/exec/terminate');
  await assert.rejects(desk.terminalAction({ id: 'external', action: 'stop' }), /结束/); bridge.completeCommand({ exitCode: 0 }); await new Promise(setImmediate); assert.equal(desk.terminalList()[0].running, false);
});

test('scheduled tasks require consent, stay readonly, persist safely and restart paused', async t => {
  const { cwd } = await fixture(), stateDir = path.join(cwd, 'state'); const { desk, bridge } = system(t, stateDir);
  await assert.rejects(desk.scheduleAction({ action: 'create', cwd, text: 'test', minutes: 60 }), /确认/);
  await desk.scheduleAction({ action: 'create', cwd, text: 'Inspect only', minutes: 15, confirmed: true }); assert.equal(bridge.calls.length, 0);
  const job = desk.jobs[0]; await desk.scheduleAction({ action: 'run', id: job.id, confirmed: true }); assert.equal(bridge.calls.at(-1).params.sandboxPolicy.type, 'readOnly'); assert.equal(job.history.length, 1);
  assert.equal((await stat(path.join(stateDir, 'schedules.json'))).mode & 0o777, 0o600);
  const restarted = new Workbench(desk.workspace, new ProjectFiles(), stateDir); t.after(() => restarted.close()); assert.equal((await restarted.schedules()).jobs[0].enabled, false);
});

test('Git diff/stage/unstage/commit/worktree actions are confirmed and confined to an independent test repository', async t => {
  const { cwd } = await fixture(); const { desk } = system(t, path.join(cwd, 'state'));
  await exec('git', ['init', '-b', 'main'], { cwd });
  await exec('git', ['config', 'user.email', 'codex-test@example.invalid'], { cwd }); await exec('git', ['config', 'user.name', 'Codex Test'], { cwd });
  await writeFile(path.join(cwd, 'file.txt'), 'first\n');
  let status = await desk.gitStatus({ cwd });
  await assert.rejects(desk.gitAction({ cwd, action: 'stage', path: 'file.txt', version: status.version }), /确认/);
  await desk.gitAction({ cwd, action: 'stage', path: 'file.txt', version: status.version, confirmed: true }); status = await desk.gitStatus({ cwd }); assert.match(status.staged, /first/);
  await desk.gitAction({ cwd, action: 'commit', message: 'Test fixture only', version: status.version, confirmed: true });
  await writeFile(path.join(cwd, 'file.txt'), 'second\n'); status = await desk.gitStatus({ cwd }); assert.match(status.unstaged, /second/);
  await assert.rejects(desk.gitAction({ cwd, action: 'stage', path: 'file.txt', version: 'stale', confirmed: true }), /变化/);
  await desk.gitAction({ cwd, action: 'stage', path: 'file.txt', version: status.version, confirmed: true }); status = await desk.gitStatus({ cwd });
  await desk.gitAction({ cwd, action: 'unstage', path: 'file.txt', version: status.version, confirmed: true }); status = await desk.gitStatus({ cwd }); assert.equal(status.staged, '');
  const destination = path.join(cwd, 'isolated-test');
  await desk.gitAction({ cwd, action: 'worktree', branch: 'test-isolated', destination, version: status.version, confirmed: true });
  assert.equal(await readFile(path.join(destination, 'file.txt'), 'utf8'), 'first\n');
  assert.equal(await readFile(path.join(cwd, 'file.txt'), 'utf8'), 'second\n');
});

test('Git file lists keep Unicode and spaces and nested projects cannot commit outside staged changes', async t => {
  const { cwd } = await fixture(); const { desk } = system(t, path.join(cwd, 'state'));
  await exec('git', ['init', '-b', 'main'], { cwd });
  await mkdir(path.join(cwd, 'sub'));
  await writeFile(path.join(cwd, 'outside.txt'), 'outside');
  await writeFile(path.join(cwd, 'sub', '中文 file.txt'), 'inside');
  await exec('git', ['add', '--', 'outside.txt', 'sub/中文 file.txt'], { cwd });
  const nested = path.join(cwd, 'sub'), status = await desk.gitStatus({ cwd: nested });
  assert.deepEqual(status.files.map(file => file.path), ['中文 file.txt']);
  assert.equal(status.stagedOutsideProject, true); assert.match(status.staged, /inside/); assert.doesNotMatch(status.staged, /outside/);
  await assert.rejects(desk.gitAction({ cwd: nested, action: 'commit', message: 'must not commit', version: status.version, confirmed: true }), /项目之外/);
  await writeFile(path.join(cwd, 'sub', 'literal[1].txt'), 'literal');
  await writeFile(path.join(cwd, 'sub', 'literal1.txt'), 'do not stage');
  const next = await desk.gitStatus({ cwd: nested });
  await desk.gitAction({ cwd: nested, action: 'stage', path: 'literal[1].txt', version: next.version, confirmed: true });
  const after = await desk.gitStatus({ cwd: nested });
  assert.equal(after.files.find(file => file.path === 'literal1.txt').untracked, true);
  assert.equal(after.files.find(file => file.path === 'literal[1].txt').index, 'A');
});

test('SQL/Python formatting and diagnostics are static and never execute source', async () => {
  const py = await languageTools({ content: 'x=1\n', language: 'python', action: 'format' }); assert.equal(py.content, 'x = 1\n');
  const diagnostics = await languageTools({ content: 'x = missing_name\n', language: 'python', action: 'check' }); assert.ok(diagnostics.diagnostics.some(d => d.code === 'F821'));
  // This is parser input, not database execution.
  const sql = await languageTools({ content: 'select a from example_table where a=1', language: 'sql', action: 'format' }); assert.match(sql.content, /\n/);
  await assert.rejects(languageTools({ content: 'def broken(', language: 'python', action: 'format' }));
  await assert.rejects(languageTools({ content: 'x'.repeat(200001), language: 'python', action: 'check' }), /20 万/);
});

test('opt-in drafts persist only text/model, never attachments or permissions; markdown highlights safely', () => {
  const map = new Map(), storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  let drafts = createDraftStore({ storage }); drafts.save('/p', 't', { text: 'private', context: { files: [{ secret: true }] } }); assert.equal(map.size, 0);
  storage.setItem('codex-desk:persistDrafts', 'true'); drafts.save('/p', 't', { text: 'saved', model: 'test', context: { files: [{ secret: true }] } }); assert.ok(!storage.getItem('codex-desk:promptDrafts').includes('secret'));
  drafts = createDraftStore({ storage }); assert.equal(drafts.read('/p', 't').text, 'saved'); drafts.clearSaved(); assert.ok(!map.has('codex-desk:promptDrafts'));
  const rendered = markdown('```python\ndef foo():\n  return "<script>"\n```\n[file](src/test.py:8)\n[x](javascript:bad.py)'); assert.match(rendered, /syntax-keyword/); assert.match(rendered, /data-file-link="src\/test.py:8"/); assert.ok(!rendered.includes('data-file-link="javascript:'));
});

test('new HTTP routes keep session/CSRF checks and operate only in a temporary project', async t => {
  const { cwd } = await fixture(); await writeFile(path.join(cwd, 'sample.py'), 'x=1\n'); const app = createApplication({ bridge: new Mock(), cwd, stateDir: path.join(cwd, 'state') }); await app.start(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`, page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  const { csrf } = await (await fetch(base + '/api/bootstrap', { headers: { cookie } })).json(); const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-codex-csrf': csrf };
  for (const asset of ['/markdown-preview.js', '/markdown-renderer.js', '/vendor/markdown/document.js', '/vendor/markdown/mermaid.js']) assert.equal((await fetch(base + asset, { headers: { cookie } })).status, 200);
  const frame = await fetch(base + '/markdown-renderer.html'); assert.equal(frame.headers.get('x-frame-options'), 'SAMEORIGIN'); assert.match(frame.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.match(page.headers.get('content-security-policy'), /style-src 'self';/); assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
  assert.equal((await fetch(base + '/vendor/markdown/document.js')).status, 401);
  assert.notEqual((await fetch(base + '/vendor/markdown/package.json', { headers: { cookie } })).status, 200);
  for (const asset of ['/workbench.js', '/editor-tools.js', '/project-list.js', '/task-results.js', '/message-timing.js']) assert.equal((await fetch(base + asset)).status, 200);
  for (const route of ['/api/project/mutate', '/api/project/replace-apply', '/api/git/action', '/api/review', '/api/terminal/start', '/api/schedules/action', '/api/connections/action', '/api/threads/action']) assert.equal((await fetch(base + route, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const search = await (await fetch(`${base}/api/project/search?cwd=${encodeURIComponent(cwd)}&query=x`, { headers: { cookie } })).json(); assert.equal(search.results[0].path, 'sample.py');
  const created = await fetch(base + '/api/project/mutate', { method: 'POST', headers, body: JSON.stringify({ cwd, path: 'new.txt', action: 'createFile' }) }); assert.equal(created.status, 200);
  const artifact = await (await fetch(`${base}/api/project/artifact?cwd=${encodeURIComponent(cwd)}&path=sample.py`, { headers: { cookie } })).json(); assert.equal(Buffer.from(artifact.base64, 'base64').toString(), 'x=1\n');
  const artifactUrl = `${base}/api/project/artifact?cwd=${encodeURIComponent(cwd)}&path=sample.py&stamp=${encodeURIComponent(artifact.stamp)}`;
  const unchanged = await (await fetch(artifactUrl, { headers: { cookie } })).json(); assert.equal(unchanged.unchanged, true); assert.equal(unchanged.base64, undefined);
  await writeFile(path.join(cwd, 'sample.py'), 'x=22\n');
  const refreshed = await (await fetch(artifactUrl, { headers: { cookie } })).json(); assert.notEqual(refreshed.version, artifact.version); assert.notEqual(refreshed.stamp, artifact.stamp); assert.equal(Buffer.from(refreshed.base64, 'base64').toString(), 'x=22\n');
  await writeFile(path.join(cwd, 'preview.html'), '<style>h1{color:red}</style><h1>Test</h1><script>throw Error("must not run")</script>');
  const previewRoute = `${base}/api/project/preview?cwd=${encodeURIComponent(cwd)}&path=preview.html`;
  assert.equal((await fetch(previewRoute)).status, 401);
  const previewResponse = await fetch(previewRoute, { headers: { cookie } }); assert.equal(previewResponse.status, 200); assert.match(previewResponse.headers.get('content-security-policy'), /sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'/); assert.equal(previewResponse.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal((await fetch(`${base}/api/project/artifact?cwd=${encodeURIComponent(cwd)}&path=../secret`, { headers: { cookie } })).status, 403);
});
