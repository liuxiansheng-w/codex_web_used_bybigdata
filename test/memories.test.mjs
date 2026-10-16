import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Memories } from '../lib/memories.mjs';
import { createApplication } from '../server.mjs';

class Bridge extends EventEmitter {
  ready = true; calls = []; version = 'v1'; managed = null; runtimeEnabled = false;
  config = { features: { memories: false }, memories: { generate_memories: true, use_memories: true }, credential: 'must-not-leak' };
  async start() {} close() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'config/read') return { config: structuredClone(this.config), layers: [{ name: { type: 'user', profile: null }, version: this.version, config: { private: 'must-not-leak' } }], origins: {} };
    if (method === 'configRequirements/read') return { requirements: { featureRequirements: this.managed == null ? {} : { memories: this.managed } } };
    if (method === 'memory/status') return { v2ConsolidatedThreads: 0, v2Ready: false };
    if (method === 'experimentalFeature/list') return { data: [{ name: 'memories', enabled: this.runtimeEnabled }] };
    if (method === 'experimentalFeature/enablement/set') { assert.deepEqual(Object.keys(params.enablement), ['memories']); this.runtimeEnabled = params.enablement.memories; return params; }
    if (method === 'config/batchWrite') {
      assert.equal(params.expectedVersion, this.version); assert.equal(params.reloadUserConfig, true); assert.equal(params.filePath, undefined);
      for (const edit of params.edits) { const [group, key] = edit.keyPath.split('.'); this.config[group] ||= {}; this.config[group][key] = edit.value; }
      this.version += 'x'; return { status: 'ok', version: this.version, overriddenMetadata: null };
    }
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list' || method === 'collaborationMode/list') return { data: [] };
    throw new Error(`Unexpected RPC ${method}`);
  }
}
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'ningmeng-memory-test-'));
  const bridge = new Bridge(), memories = new Memories(bridge, { codeHome: home });
  return { home, bridge, memories };
}

test('memory controls persist only named settings with native version checks and enforce managed state', async () => {
  const { bridge, memories, home } = await fixture();
  const initial = await memories.status(); assert.equal(initial.settings.enabled, false); assert.deepEqual(initial.files, []);
  assert.ok(!JSON.stringify(initial).includes('must-not-leak'));
  const enabled = await memories.update({ revision: initial.revision, settings: { enabled: true, allowExternal: false } });
  assert.equal(enabled.settings.enabled, true); assert.equal(enabled.settings.allowExternal, false); assert.equal(enabled.runtimeEnabled, true);
  const write = bridge.calls.find(call => call.method === 'config/batchWrite');
  assert.deepEqual(write.params.edits, [{ keyPath: 'features.memories', value: true, mergeStrategy: 'replace' }, { keyPath: 'memories.disable_on_external_context', value: true, mergeStrategy: 'replace' }]);
  const anotherSession = new Memories(bridge, { codeHome: home }); assert.equal((await anotherSession.status()).settings.enabled, true);
  await assert.rejects(memories.update({ revision: initial.revision, settings: { enabled: false } }), /已变化/);
  await assert.rejects(memories.update({ revision: enabled.revision, settings: { token: true } }), /格式/);
  await assert.rejects(memories.update({ revision: enabled.revision, settings: { enabled: 'true' } }), /格式/);
  bridge.managed = true; const managed = await memories.status();
  await assert.rejects(memories.update({ revision: managed.revision, settings: { enabled: false } }), /组织策略/);
  assert.equal(bridge.calls.filter(call => call.method === 'config/batchWrite').length, 1);
  assert.equal(bridge.calls.some(call => call.method === 'turn/start' || call.method === 'memory/reset'), false);
});

test('memory previews are bounded, fixed to generated files and reject links or arbitrary paths', async () => {
  const { memories, home } = await fixture(); await mkdir(path.join(home, 'memories'));
  await writeFile(path.join(home, 'memories', 'memory_summary.md'), '# 虚构记忆\n<script>inert</script>');
  await writeFile(path.join(home, 'memories', 'MEMORY.md'), '界'.repeat(100000));
  await writeFile(path.join(home, 'private.txt'), 'private fixture');
  const listed = await memories.listFiles(); assert.deepEqual(listed.map(file => file.id), ['summary', 'durable']);
  assert.ok(!JSON.stringify(listed).includes(home));
  assert.match((await memories.read({ id: 'summary' })).content, /虚构记忆/);
  const long = await memories.read({ id: 'durable' }); assert.equal(long.truncated, true); assert.ok(Buffer.byteLength(long.content) <= 256 * 1024); assert.ok(!long.content.endsWith('\uFFFD'));
  await assert.rejects(memories.read({ id: '../private.txt' }), /不存在/);
  await symlink(path.join(home, 'private.txt'), path.join(home, 'memories', 'raw_memories.md'));
  await assert.rejects(memories.read({ id: 'recent' }), /无法读取/);
  const other = await fixture(); await symlink(path.join(home, 'memories'), path.join(other.home, 'memories'));
  await assert.rejects(other.memories.listFiles(), /目录类型/);
});

test('memory HTTP routes require session, same origin and CSRF, and never expose unrelated config', async t => {
  const { bridge, memories, home } = await fixture();
  const app = createApplication({ cwd: home, stateDir: path.join(home, 'state'), bridge, memories });
  const port = await app.start(0); t.after(() => app.close()); const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/api/memories')).status, 401);
  assert.equal((await fetch(base + '/api/memories/file?id=summary')).status, 401);
  const page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const bootstrap = await (await fetch(base + '/api/bootstrap', { headers: { cookie } })).json(); assert.equal(bootstrap.memorySettings, true);
  const response = await fetch(base + '/api/memories', { headers: { cookie } }); assert.equal(response.headers.get('cache-control'), 'no-store');
  const record = await response.json(); assert.ok(!JSON.stringify(record).includes('must-not-leak'));
  const body = JSON.stringify({ revision: record.revision, settings: { enabled: true } });
  assert.equal((await fetch(base + '/api/memories/settings', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: base }, body })).status, 403);
  assert.equal((await fetch(base + '/api/memories/settings', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'http://other.test', 'x-codex-csrf': bootstrap.csrf }, body })).status, 403);
  const saved = await fetch(base + '/api/memories/settings', { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: base, 'x-codex-csrf': bootstrap.csrf }, body });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).settings.enabled, true);
  assert.equal(bridge.calls.filter(call => call.method === 'config/batchWrite').length, 1);
});
