import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApplication, defaultWorkspace } from '../server.mjs';
import { Workspace } from '../lib/workspace.mjs';
import { markdown } from '../public/markdown.js';
import { ContextStore, attachmentInput } from '../lib/context.mjs';
import { readFile, mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';

test('moving the app into a nested repository preserves the outer default workspace and explicit overrides', async () => {
  const outer = await realpath(await mkdtemp(path.join(tmpdir(), 'ningmeng-workspace-')));
  const nested = path.join(outer, '临时任务', 'data_request');
  const appRoot = path.join(nested, '刘正阳任务', 'AI', 'codex-web-shell');
  await mkdir(path.join(outer, '.git'));
  await mkdir(path.join(nested, '.git'), { recursive: true });
  await mkdir(appRoot, { recursive: true });
  assert.equal(defaultWorkspace(appRoot, ''), outer);
  assert.equal(defaultWorkspace(appRoot, nested), nested);
});

class FakeCodex extends EventEmitter {
  ready = false;
  calls = [];
  replies = [];
  goals = new Map();
  async start() { this.ready = true; }
  close() {}
  respond(id, result) { this.replies.push({ id, result }); }
  unsupported(id) { this.replies.push({ id, error: true }); }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'configRequirements/read') return { requirements: null };
    if (method === 'account/read') return { account: { type: 'chatgpt', email: 'private@example.test', accessToken: 'never-expose' }, requiresOpenaiAuth: true };
    if (method === 'model/list') return { data: [{ model: 'test-model', displayName: 'Test', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }], inputModalities: ['text', 'image'] }] };
    if (method === 'skills/list') return { data: [{ skills: [{ name: 'sample-skill', path: '/private/tmp/sample/SKILL.md', enabled: true }, { name: 'disabled', path: '/private/tmp/disabled/SKILL.md', enabled: false }] }] };
    if (method === 'plugin/installed') return { marketplaces: [{ plugins: [{ id: 'pdf@example', name: 'pdf', installed: true, enabled: true, interface: { displayName: 'PDF', shortDescription: 'PDF tools' } }, { id: 'disabled@example', name: 'disabled', installed: true, enabled: false, interface: { displayName: 'Disabled' } }] }] };
    if (method === 'collaborationMode/list') return { data: [{ mode: 'plan' }, { mode: 'default' }] };
    if (method === 'thread/goal/get') return { goal: this.goals.get(params.threadId) || null };
    if (method === 'thread/goal/clear') { this.goals.delete(params.threadId); return { cleared: true }; }
    if (method === 'thread/goal/set') {
      const goal = { status: 'active', tokenBudget: null, tokensUsed: 0, ...this.goals.get(params.threadId), ...params };
      this.goals.set(params.threadId, goal); return { goal };
    }
    if (method === 'thread/list') return { data: [], nextCursor: null };
    if (method === 'thread/start' || method === 'thread/read' || method === 'thread/resume') return { thread: { id: params.threadId || 'thread-1', cwd: '/private/tmp', turns: [] }, model: 'test-model' };
    if (method === 'turn/start') {
      this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'turn-1' } } });
      this.emit('notification', { method: 'item/started', params: { threadId: params.threadId, item: { id: 'user-1', type: 'userMessage', content: params.input } } });
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'turn/interrupt') {
      this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-1', status: 'interrupted' } } });
      return {};
    }
    throw new Error(`Unexpected method ${method}`);
  }
}

function workspace(t) {
  const bridge = new FakeCodex(); const space = new Workspace(bridge, '/private/tmp');
  t.after(() => { for (const timer of space.timers.values()) clearTimeout(timer); });
  return { bridge, space };
}
const prompt = { text: 'Test', cwd: '/private/tmp', mode: 'workspace-write' };

test('HTTP boundary rejects cross-site, missing session/CSRF, and arbitrary file paths', async t => {
  const app = createApplication({ bridge: new FakeCodex(), cwd: '/private/tmp' });
  await app.start(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const page = await fetch(base); const cookie = page.headers.get('set-cookie').split(';')[0];
  assert.equal(page.status, 200);
  for (const asset of ['/app.js', '/composer.js', '/permissions.js', '/permission-presets.js', '/interactions.js', '/file-tree.js', '/file-editor.js', '/editor-window.js', '/code-highlight.js', '/markdown.js', '/style.css', '/favicon.svg']) assert.equal((await fetch(`${base}${asset}`)).status, 200, asset);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
  assert.equal((await fetch(`${base}/git-submit.js`)).status, 200);
  for (const route of ['/api/git/submit', '/api/git/submit/diff']) assert.equal((await fetch(base + route)).status, 401);
  const boot = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  assert.equal(boot.auth.loggedIn, true);
  assert.ok(!JSON.stringify(boot).includes('private@example'));
  assert.ok(!JSON.stringify(boot).includes('never-expose'));
  assert.equal((await fetch(`${base}/api/send`, { method: 'POST', headers: { cookie, origin: 'https://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/send`, { method: 'POST', headers: { cookie, origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/lib/bridge.mjs`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/api/project/files`)).status, 401);
  assert.equal((await fetch(`${base}/api/project/files?path=../`, { headers: { cookie } })).status, 403);
  assert.equal((await fetch(`${base}/api/project/attach`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const headers = { cookie, origin: base, 'Content-Type': 'application/json', 'x-codex-csrf': boot.csrf };
  assert.equal((await fetch(`${base}/api/git/submit`, { method: 'POST', headers: { cookie, origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/git/submit`, { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/git/submit`, { method: 'POST', headers, body: '{}' })).status, 400);
  const projectCwd = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
  const tree = await fetch(`${base}/api/project/files?cwd=${encodeURIComponent(projectCwd)}`, { headers: { cookie } });
  assert.equal(tree.status, 200); assert.ok((await tree.json()).entries.some(entry => entry.path === 'package.json'));
  const projectAttachment = await fetch(`${base}/api/project/attach`, { method: 'POST', headers, body: JSON.stringify({ cwd: projectCwd, path: 'package.json' }) });
  assert.equal(projectAttachment.status, 200); assert.equal((await projectAttachment.json()).projectPath, 'package.json');
  const catalog = await (await fetch(`${base}/api/capabilities`, { headers: { cookie } })).json();
  assert.deepEqual(catalog.plugins.map(p => p.key), ['pdf@example']);
  const upload = await fetch(`${base}/api/attachments/upload`, { method: 'POST', headers, body: JSON.stringify({ name: 'note.txt', base64: Buffer.from('hello').toString('base64') }) });
  assert.equal(upload.status, 200);
  assert.equal((await upload.json()).kind, 'file');
  const noCsrf = await fetch(`${base}/api/attachments/reference`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ path: '/private/tmp' }) });
  assert.equal(noCsrf.status, 403);
  const sent = await fetch(`${base}/api/send`, { method: 'POST', headers, body: JSON.stringify(prompt) });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).threadId, 'thread-1');
  const duplicate = await fetch(`${base}/api/send`, { method: 'POST', headers, body: JSON.stringify({ ...prompt, threadId: 'thread-1' }) });
  assert.equal(duplicate.status, 409);
  const controller = new AbortController();
  app.workspace.threads.get('thread-1').items.push({ id: 'large-history', type: 'agentMessage', text: 'x'.repeat(160_000) });
  const events = await fetch(`${base}/api/events`, { headers: { cookie }, signal: controller.signal });
  const reader = events.body.getReader(); const decoder = new TextDecoder(); let text = '';
  while (!text.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done, false); text += decoder.decode(chunk.value, { stream: true }); }
  assert.match(text, /event: snapshot/); assert.match(text, /"busy":true/);
  assert.match(text, /large-history/); assert.ok(text.length > 160_000);
  controller.abort();
  const stopped = await fetch(`${base}/api/interrupt`, { method: 'POST', headers, body: JSON.stringify({ threadId: 'thread-1' }) });
  assert.equal(stopped.status, 200);
  assert.equal(app.workspace.threads.get('thread-1').busy, false);
});

test('sending to a 16 MB conversation keeps SSE open and emits a small versioned update', { timeout: 15_000 }, async t => {
  const app = createApplication({ bridge: new FakeCodex(), cwd: '/private/tmp' });
  await app.start(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  const boot = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, origin: base, 'Content-Type': 'application/json', 'x-codex-csrf': boot.csrf };
  await fetch(`${base}/api/send`, { method: 'POST', headers, body: JSON.stringify(prompt) });
  await fetch(`${base}/api/interrupt`, { method: 'POST', headers, body: JSON.stringify({ threadId: 'thread-1' }) });
  const thread = app.workspace.threads.get('thread-1');
  thread.items.push({ id: 'large', type: 'commandExecution', text: 'x'.repeat(16 * 1024 * 1024) });
  const response = await fetch(`${base}/api/events?version=2`, { headers: { cookie } });
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  t.after(() => reader.cancel().catch(() => {}));
  async function frame() {
    while (!buffer.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done, false); buffer += decoder.decode(chunk.value, { stream: true }); }
    const end = buffer.indexOf('\n\n'), text = buffer.slice(0, end); buffer = buffer.slice(end + 2);
    return { event: text.split('\n')[0].slice(7), data: JSON.parse(text.split('\n')[1].slice(6)), bytes: Buffer.byteLength(text) };
  }
  const snapshot = await frame(); assert.ok(snapshot.bytes > 16 * 1024 * 1024);
  const sent = await fetch(`${base}/api/send`, { method: 'POST', headers, body: JSON.stringify({ ...prompt, threadId: thread.id, text: 'Second message' }) });
  assert.equal(sent.status, 200);
  let update;
  do { update = await frame(); } while (!update.data.thread.busy);
  assert.equal(update.event, 'thread-patch'); assert.ok(update.bytes < 10_000);
  assert.equal(update.data.thread.id, thread.id);
  assert.equal(update.data.items.some(item => item.id === 'large'), false);
  app.bridge.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: thread.id, itemId: 'answer', delta: 'Still connected' } });
  const reply = await frame(); assert.equal(reply.event, 'thread-patch');
  assert.equal(reply.data.items.some(item => item.text === 'Still connected'), true);
  assert.equal((await fetch(`${base}/interactions.js`)).status, 200);
});

test('file editing HTTP routes enforce authentication, CSRF, project boundaries and versioned save', async t => {
  const { mkdtemp, writeFile, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-editor-http-test-')));
  await writeFile(path.join(cwd, 'example.txt'), 'before\n');
  const app = createApplication({ bridge: new FakeCodex(), cwd });
  await app.start(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  const boot = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const route = `/api/project/file?cwd=${encodeURIComponent(cwd)}&path=example.txt`;
  assert.equal((await fetch(`${base}${route}`)).status, 401);
  const loaded = await (await fetch(`${base}${route}`, { headers: { cookie } })).json();
  assert.equal(loaded.content, 'before\n');
  const unchanged = await (await fetch(`${base}${route}&version=${loaded.version}`, { headers: { cookie } })).json();
  assert.deepEqual(unchanged, { unchanged: true, version: loaded.version });
  const body = JSON.stringify({ cwd, path: 'example.txt', version: loaded.version, content: 'after\n' });
  const headers = { cookie, origin: base, 'Content-Type': 'application/json', 'X-Codex-CSRF': boot.csrf };
  assert.equal((await fetch(`${base}/api/project/save`, { method: 'POST', headers: { cookie, origin: base, 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(`${base}/api/project/save`, { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body })).status, 403);
  assert.equal((await fetch(`${base}/api/project/file?cwd=${encodeURIComponent(cwd)}&path=../example.txt`, { headers: { cookie } })).status, 403);
  const saved = await fetch(`${base}/api/project/save`, { method: 'POST', headers, body });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).content, 'after\n');
  assert.equal(await readFile(path.join(cwd, 'example.txt'), 'utf8'), 'after\n');
  assert.equal((await fetch(`${base}/api/project/save`, { method: 'POST', headers, body })).status, 409);
  assert.equal(app.bridge.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('streamed events reconcile user echo, deltas and final content', async t => {
  const { bridge, space } = workspace(t); await space.send(prompt);
  const thread = space.threads.get('thread-1');
  assert.equal(thread.items.filter(i => i.type === 'userMessage').length, 1);
  bridge.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: thread.id, itemId: 'answer', delta: 'Hello ' } });
  bridge.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: thread.id, itemId: 'answer', delta: 'world' } });
  bridge.emit('notification', { method: 'item/completed', params: { threadId: thread.id, item: { id: 'answer', type: 'agentMessage', text: 'Hello world!' } } });
  assert.equal(thread.items.at(-1).text, 'Hello world!');
  assert.equal(thread.items.filter(i => i.id === 'answer').length, 1);
  await space.interrupt(thread.id); assert.equal(thread.busy, false);
});

test('approval, denial and user input are explicit; stale requests cannot be replayed', async t => {
  const { bridge, space } = workspace(t); await space.send(prompt);
  bridge.emit('request', { id: 9, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'test-command' } });
  assert.equal(bridge.replies.length, 0);
  const key = space.threads.get('thread-1').requests[0].key;
  assert.throws(() => space.respond({ key, decision: 'acceptForSession' }), /无效/);
  space.respond({ key, decision: 'decline' });
  assert.deepEqual(bridge.replies[0], { id: 9, result: { decision: 'decline' } });
  assert.throws(() => space.respond({ key, decision: 'accept' }), /已结束/);
  bridge.emit('request', { id: 10, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [{ id: 'choice', question: 'Choose' }] } });
  const inputKey = space.threads.get('thread-1').requests[0].key;
  assert.throws(() => space.respond({ key: inputKey, answers: {} }), /所有问题/);
  space.respond({ key: inputKey, answers: { choice: 'A' } });
  assert.deepEqual(bridge.replies[1].result, { answers: { choice: { answers: ['A'] } } });
  bridge.emit('request', { id: 11, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1' } });
  const stale = space.threads.get('thread-1').requests[0].key;
  bridge.emit('offline', 'closed');
  assert.throws(() => space.respond({ key: stale, decision: 'accept' }), /已结束/);
});

test('read-only explicitly disables writes and escalation on every turn', async t => {
  const { bridge, space } = workspace(t); await space.send({ ...prompt, mode: 'read-only' });
  const turn = bridge.calls.find(c => c.method === 'turn/start').params;
  assert.equal(turn.approvalPolicy, 'never');
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.deepEqual(turn.input[0].text_elements, []);
});

test('completion before turn/start response never restores busy status', async t => {
  const { bridge, space } = workspace(t);
  const original = bridge.request.bind(bridge);
  bridge.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'turn/start') bridge.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'turn-1', status: 'completed' } } });
    return result;
  };
  await space.send(prompt);
  assert.equal(space.threads.get('thread-1').busy, false);
  assert.equal(space.threads.get('thread-1').turnId, null);
});

test('permission grant does not include absent fields; unknown tools fail closed', async t => {
  const { bridge, space } = workspace(t); await space.send(prompt);
  bridge.emit('request', { id: 20, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', permissions: { network: { enabled: true }, fileSystem: null } } });
  space.respond({ key: space.threads.get('thread-1').requests[0].key, decision: 'accept' });
  assert.deepEqual(bridge.replies[0].result, { permissions: { network: { enabled: true } }, scope: 'turn' });
  bridge.emit('request', { id: 21, method: 'item/tool/call', params: { threadId: 'thread-1' } });
  assert.equal(bridge.replies[1].error, true);
});

test('Markdown renders code/tables and keeps HTML, scripts and unsafe links inert', () => {
  const output = markdown('# Heading\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n[x](https://example.com/\"onclick=\"bad)\n\n```html\n<img onerror=bad>\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('<img'));
  assert.ok(!output.includes('href="javascript:'));
  assert.match(output, /<pre><code>&lt;img/);
  assert.match(output, /<table>/);
  assert.match(output, /&quot;onclick/);
});

test('composer uses real capabilities, selected effort, image input and native read-only plan mode', async t => {
  const { bridge, space } = workspace(t); await space.bootstrap();
  const upload = await space.context.upload({ name: 'sketch.png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' });
  const catalog = await space.catalog.get('/private/tmp');
  assert.deepEqual(catalog.skills.map(s => s.name), ['sample-skill']);
  await space.send({ ...prompt, model: 'test-model', plan: true, effort: 'xhigh', attachments: [upload.id], capabilities: ['pdf@example', catalog.skills[0].key] });
  const start = bridge.calls.find(c => c.method === 'thread/start').params;
  const turn = bridge.calls.find(c => c.method === 'turn/start').params;
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(turn.effort, 'xhigh');
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.deepEqual(turn.collaborationMode, { mode: 'plan', settings: { model: 'test-model', reasoning_effort: 'xhigh', developer_instructions: null } });
  assert.ok(turn.input.some(i => i.type === 'localImage' && i.path.endsWith('.png')));
  assert.deepEqual(turn.input.find(i => i.type === 'mention'), { type: 'mention', name: 'PDF', path: 'plugin://pdf@example' });
  assert.deepEqual(turn.input.find(i => i.type === 'skill'), { type: 'skill', name: 'sample-skill', path: '/private/tmp/sample/SKILL.md' });
  await space.interrupt('thread-1');
  await space.send({ ...prompt, threadId: 'thread-1', plan: false });
  assert.equal(bridge.calls.filter(c => c.method === 'turn/start').at(-1).params.collaborationMode.mode, 'default');
});

test('invalid attachments, disabled capabilities, efforts and goals fail before creating any conversation', async t => {
  const { bridge, space } = workspace(t); await space.bootstrap();
  await assert.rejects(space.send({ ...prompt, attachments: ['unknown'] }), /已过期/);
  await assert.rejects(space.send({ ...prompt, capabilities: ['disabled@example'] }), /不可用/);
  await assert.rejects(space.send({ ...prompt, effort: 'ultra' }), /不支持/);
  await assert.rejects(space.send({ ...prompt, goal: { objective: 'test', tokenBudget: -1 } }), /正整数/);
  assert.ok(!bridge.calls.some(c => c.method === 'thread/start'));
});

test('native goals survive resume, expose updates, pause on stop, and clear explicitly', async t => {
  const { bridge, space } = workspace(t);
  await space.setGoal({ threadId: 'saved-thread', objective: 'Finish test', tokenBudget: 1000, status: 'paused' });
  assert.equal(space.threads.get('saved-thread').model, 'test-model');
  await space.send({ ...prompt, threadId: 'saved-thread' });
  const thread = space.threads.get('saved-thread');
  assert.equal(thread.goal.objective, 'Finish test');
  await space.setGoal({ threadId: thread.id, status: 'active' });
  bridge.emit('notification', { method: 'thread/goal/updated', params: { threadId: thread.id, goal: { ...thread.goal, tokensUsed: 42 } } });
  assert.equal(thread.goal.tokensUsed, 42);
  const beforeInterrupt = bridge.calls.length;
  await space.interrupt(thread.id);
  assert.equal(thread.goal.status, 'paused');
  assert.equal(thread.busy, false);
  const stopCalls = bridge.calls.slice(beforeInterrupt);
  assert.deepEqual(stopCalls.slice(0, 2).map(call => call.method), ['thread/goal/set', 'turn/interrupt']);
  assert.equal(stopCalls[0].params.status, 'paused');
  assert.deepEqual(stopCalls[2], { method: 'thread/read', params: { threadId: thread.id, includeTurns: false } });
  await space.setGoal({ threadId: thread.id, clear: true });
  assert.equal(thread.goal, null);
  await assert.rejects(space.setGoal({ threadId: thread.id, objective: '' }), /不能为空/);
});

test('attachments keep bytes private, sanitize destination paths, validate size and reference directories', async () => {
  const store = new ContextStore();
  const item = await store.upload({ name: '../../note.txt', base64: Buffer.from('test contents').toString('base64') });
  assert.equal(item.path, undefined);
  const [internal] = store.resolve([item.id]);
  assert.equal(await readFile(internal.path, 'utf8'), 'test contents');
  assert.match(internal.path, /codex-desk-attachments-[^/]+\/[a-f0-9-]+\.txt$/);
  await assert.rejects(store.upload({ name: 'bad.txt', base64: 'not valid base64!' }), /无效/);
  await assert.rejects(store.upload({ name: 'big.txt', base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }), /10 MB/);
  await assert.rejects(store.reference({ path: 'relative' }), /绝对路径/);
  const folder = await store.reference({ path: '/private/tmp' });
  assert.equal(folder.kind, 'folder');
  assert.match(attachmentInput(store.resolve([folder.id]))[0].text, /文件夹/);
});

test('auto-review keeps sandbox boundaries and uses the real reviewer on every turn', async t => {
  const { bridge, space } = workspace(t);
  await space.send({ ...prompt, mode: 'auto-review' });
  const start = bridge.calls.find(c => c.method === 'thread/start').params;
  const turn = bridge.calls.find(c => c.method === 'turn/start').params;
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal(start.approvalPolicy, 'on-request');
  assert.equal(start.approvalsReviewer, 'auto_review');
  assert.equal(turn.approvalsReviewer, 'auto_review');
  assert.equal(turn.approvalPolicy, 'on-request');
  assert.equal(turn.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(turn.sandboxPolicy.networkAccess, false);
  bridge.emit('notification', { method: 'item/autoApprovalReview/started', params: { threadId: 'thread-1', reviewId: 'r1', review: { status: 'inProgress' } } });
  bridge.emit('notification', { method: 'item/autoApprovalReview/completed', params: { threadId: 'thread-1', reviewId: 'r1', review: { status: 'denied', rationale: 'Not authorized' } } });
  assert.equal(space.threads.get('thread-1').items.at(-1).text, 'Not authorized');
  assert.equal(bridge.replies.length, 0, 'Web shell must not auto-accept requests');
  await space.interrupt('thread-1');
  await space.send({ ...prompt, threadId: 'thread-1' });
  assert.equal(bridge.calls.filter(c => c.method === 'turn/start').at(-1).params.approvalsReviewer, 'user');
});

test('full access requires explicit consent; plan mode and subsequent manual turns restore boundaries', async t => {
  const { bridge, space } = workspace(t);
  await assert.rejects(space.send({ ...prompt, mode: 'danger-full-access' }), /确认/);
  await assert.rejects(space.send({ ...prompt, mode: 'danger-full-access', fullAccessConfirmed: 'true' }), /确认/);
  assert.ok(!bridge.calls.some(c => c.method === 'thread/start'));
  await space.send({ ...prompt, mode: 'danger-full-access', fullAccessConfirmed: true });
  const start = bridge.calls.find(c => c.method === 'thread/start').params;
  const turn = bridge.calls.find(c => c.method === 'turn/start').params;
  assert.equal(start.sandbox, 'danger-full-access');
  assert.equal(turn.approvalPolicy, 'never');
  assert.deepEqual(turn.sandboxPolicy, { type: 'dangerFullAccess' });
  await space.interrupt('thread-1');
  await space.send({ ...prompt, threadId: 'thread-1', mode: 'danger-full-access', plan: true });
  const planned = bridge.calls.filter(c => c.method === 'turn/start').at(-1).params;
  assert.deepEqual(planned.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(planned.approvalsReviewer, 'user');
  await space.interrupt('thread-1');
  await assert.rejects(space.send({ ...prompt, threadId: 'thread-1', mode: 'danger-full-access' }), /确认/);
  await space.send({ ...prompt, threadId: 'thread-1' });
  assert.equal(bridge.calls.filter(c => c.method === 'turn/start').at(-1).params.sandboxPolicy.type, 'workspaceWrite');
});

test('managed policy and unavailable requirements never silently enable broader access', async t => {
  const { bridge, space } = workspace(t);
  const original = bridge.request.bind(bridge);
  bridge.request = async (method, params) => method === 'configRequirements/read'
    ? { requirements: { allowedSandboxModes: ['read-only', 'workspace-write'], allowedApprovalsReviewers: ['user'] } } : original(method, params);
  await assert.rejects(space.send({ ...prompt, mode: 'auto-review' }), /组织策略/);
  await assert.rejects(space.send({ ...prompt, mode: 'danger-full-access', fullAccessConfirmed: true }), /组织策略/);
  assert.ok(!bridge.calls.some(c => c.method === 'thread/start'));
  space.permissions.cached = null;
  bridge.request = async (method, params) => { if (method === 'configRequirements/read') throw new Error('Unavailable'); return original(method, params); };
  await assert.rejects(space.send({ ...prompt, mode: 'auto-review' }), /无法核验/);
  await space.send(prompt);
  assert.equal(space.threads.get('thread-1').mode, 'workspace-write');
});
