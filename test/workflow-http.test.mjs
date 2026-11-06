import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplication } from '../server.mjs';

class Bridge extends EventEmitter {
  ready = true; calls = []; loaded = new Set();
  constructor(cwd) { super(); this.cwd = cwd; }
  async start() {} close() {} unsupported() {} respond() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'config/read') return { config: { features: { memories: true }, memories: {} }, layers: [{ name: { type: 'user' }, version: '1' }] };
    if (method === 'configRequirements/read') return { requirements: null };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'thread/loaded/list') return { data: [...this.loaded] };
    if (method === 'thread/unsubscribe') { this.loaded.delete(params.threadId); return { status: 'unsubscribed' }; }
    if (method === 'thread/memoryMode/set') return {};
    if (method === 'thread/read' || method === 'thread/resume' || method === 'thread/start') { const id = params.threadId || 'fixture-chat'; if (method !== 'thread/read') this.loaded.add(id); return { thread: { id, cwd: this.cwd, path: path.join(this.cwd, 'native-record.jsonl'), turns: [] }, model: 'fixture-model' }; }
    if (method === 'turn/start') return { turn: { id: 'fixture-turn', status: 'inProgress' } };
    if (['model/list', 'skills/list', 'plugin/installed', 'collaborationMode/list', 'experimentalFeature/list'].includes(method)) return { data: [] };
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'memory/status') return {};
    throw new Error('Unexpected method ' + method);
  }
}

test('new workflow routes preserve session/CSRF and HTML interaction has an opaque sandbox', async t => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-workflow-http-'))), bridge = new Bridge(cwd);
  await writeFile(path.join(cwd, 'interactive.html'), '<button onclick="this.textContent=\'worked\'">Try</button><script>window.fixture = 1</script>');
  const app = createApplication({ cwd, bridge, stateDir: path.join(cwd, 'state') }); await app.start(0); t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`, page = await fetch(origin), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const bootstrap = await (await fetch(origin + '/api/bootstrap', { headers: { cookie } })).json(); assert.equal(bootstrap.sharedBrowser, true);
  const get = route => fetch(origin + route, { headers: { cookie } });
  const post = (route, data, csrf = bootstrap.csrf) => fetch(origin + route, { method: 'POST', headers: { cookie, origin, 'x-codex-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await fetch(origin + '/api/browser?cwd=' + encodeURIComponent(cwd))).status, 401);
  assert.equal((await post('/api/browser/settings', {}, 'bad')).status, 403);
  assert.equal((await post('/api/threads/memories', {}, 'bad')).status, 403);
  const file = await (await get('/api/threads/fixture-chat/path')).json(); assert.equal(file.path, path.join(cwd, 'native-record.jsonl'));
  const beforeMode = (await app.workspace.get('fixture-chat')).mode;
  const memory = await (await get('/api/threads/fixture-chat/memories')).json(); assert.equal(memory.use, null);
  const saved = await post('/api/threads/memories', { threadId: 'fixture-chat', revision: memory.revision, use: false, contribute: false }); assert.equal(saved.status, 200); assert.equal((await saved.json()).effective.use, false); assert.equal((await app.workspace.get('fixture-chat')).mode, beforeMode, 'memory edits preserve the chat permission mode');
  assert.ok(bridge.calls.some(call => call.method === 'thread/memoryMode/set' && call.params.mode === 'disabled'));
  await app.workspace.send({ threadId: 'fixture-chat', text: 'Synthetic fixture only', cwd, mode: 'workspace-write' });
  const resumed = bridge.calls.filter(call => call.method === 'thread/resume').at(-1);
  assert.equal(resumed.params.config['memories.use_memories'], false); assert.equal(resumed.params.config['mcp_servers.lemon_browser'].enabled, true);
  const staticPreview = await get('/api/project/preview?cwd=' + encodeURIComponent(cwd) + '&path=interactive.html'); assert.match(staticPreview.headers.get('content-security-policy'), /script-src 'none'/);
  const interactive = await get('/api/project/preview?cwd=' + encodeURIComponent(cwd) + '&path=interactive.html&interactive=1'), policy = interactive.headers.get('content-security-policy');
  assert.equal(interactive.status, 200); assert.match(policy, /sandbox allow-scripts/); assert.ok(!policy.includes('allow-same-origin')); assert.match(policy, /connect-src 'none'/); assert.match(policy, /form-action 'none'/); assert.match(await interactive.text(), /window.fixture/);
  const main = await get('/'); assert.match(main.headers.get('content-security-policy'), /script-src 'self'/); assert.ok(!main.headers.get('content-security-policy').includes('unsafe-inline'));
});
