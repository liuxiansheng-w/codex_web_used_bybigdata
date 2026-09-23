import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ModelConnections, connectionProfile, COSMOS_MODEL, COSMOS_PROVIDER } from '../lib/model-connections.mjs';
import { workflowPrompt, workflowResult, cosmosResponse, responseEvents } from '../lib/cosmos-transport.mjs';
import { createApplication } from '../server.mjs';
import { Workspace } from '../lib/workspace.mjs';

export function mockCosmos(calls = []) {
  return async (url, options) => {
    calls.push({ url, ...options });
    const body = JSON.parse(options.body);
    const request = body.inputs ? JSON.parse(body.inputs.input.split('REQUEST_JSON:\n')[1]) : body;
    const returned = request.input.findLast(i => i.type === 'function_call_output');
    const marker = returned ? JSON.parse(returned.output).marker : request.input[0]?.content.match(/marker ([\w-]+)\./)?.[1];
    const envelope = { text: returned ? marker : '', calls: returned ? [] : [{ name: 'lemon_probe', arguments: { marker } }] };
    return new Response(JSON.stringify(body.inputs ? { data: { status: 'succeeded', outputs: { output: JSON.stringify(envelope) } } } : workflowResult(envelope, body)));
  };
}
const form = { action: 'configure', revision: 0, key: 'fictional-secret-key-123', protocol: 'workflow', baseUrl: 'https://cosmos.example/v1', inputKey: 'input', outputKey: 'output' };
async function setup(options = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'model-connections-')), calls = [];
  const manager = new ModelConnections({ stateDir, fetchImpl: mockCosmos(calls), ...options });
  manager.origin = 'http://127.0.0.1:54321'; await manager.loading;
  return { manager, calls, stateDir };
}

test('keys stay server-side, are saved privately and restored with verified routing', async () => {
  const { manager, calls, stateDir } = await setup();
  const result = await manager.update(form);
  assert.equal(calls.length, 2); assert.equal(result.active, 'cosmos');
  assert.equal(JSON.stringify(result).includes(form.key), false); assert.equal(result.cosmos.hasKey, true);
  assert.equal((await stat(manager.file)).mode & 0o777, 0o600); assert.equal((await stat(manager.dir)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(manager.file, 'utf8')).cosmos.key, form.key);
  const restored = new ModelConnections({ stateDir }); await restored.loading;
  assert.equal((await restored.status()).active, 'cosmos');
  const options = await manager.options(COSMOS_MODEL);
  assert.equal(options.modelProvider, COSMOS_PROVIDER); assert.equal(JSON.stringify(options).includes(form.key), false);
  assert.match(options.config[`model_providers.${COSMOS_PROVIDER}`].base_url, /^http:\/\/127\.0\.0\.1:54321\/internal\/model\/[a-f0-9]{64}\/v1$/);
  assert.equal(options.config['agents.default_subagent_model'], 'cosmos-workflow');
});

test('invalid or template-only workflow cannot replace a working key or provider', async () => {
  const { manager } = await setup(); await manager.update(form);
  const saved = await readFile(manager.file, 'utf8');
  manager.fetchImpl = async () => new Response(JSON.stringify({ data: { status: 'succeeded', outputs: { output: 'SELECT 1' } } }));
  await assert.rejects(manager.update({ ...form, revision: 1, key: 'invalid-replacement' }), /工具协议 JSON/);
  assert.equal(await readFile(manager.file, 'utf8'), saved); assert.equal(manager.value.cosmos.key, form.key);
  await assert.rejects(manager.update({ ...form, revision: 0 }), { status: 409 });
  await assert.rejects(manager.update({ ...form, revision: 1, key: '', baseUrl: 'https://changed.example' }), /重新输入/);
  assert.equal((await manager.status()).active, 'cosmos');
});

test('rotation and selecting Codex preserve in-flight leases and never auto-fallback', async () => {
  const { manager, calls } = await setup(); await manager.update(form);
  const old = await manager.options(COSMOS_MODEL); manager.bind('running', old);
  await manager.update({ ...form, revision: 1, key: 'replacement-test-key' });
  assert.equal(await manager.forThread('running', COSMOS_MODEL), old);
  assert.notEqual(await manager.options(COSMOS_MODEL), old);
  await manager.update({ action: 'select', provider: 'codex', revision: 2 });
  assert.equal(calls.length, 4); assert.equal((await manager.status()).active, 'codex');
  assert.equal(await manager.forThread('running', COSMOS_MODEL), old);
  assert.equal(await manager.options('native-model'), null);
});

test('validation accepts responses models and preserves tool arguments and outputs', async () => {
  const { manager, calls } = await setup();
  await manager.update({ ...form, protocol: 'responses', model: 'private-model' });
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.url.endsWith('/responses')));
  assert.ok(calls.every(c => JSON.parse(c.body).model === 'private-model'));
  assert.ok(calls.every(c => c.redirect === 'error' && c.headers.Authorization === `Bearer ${form.key}`));
});

test('cancelled verification cannot persist or switch and raw upstream errors are never exposed', async () => {
  const controller = new AbortController(); controller.abort();
  const { manager } = await setup();
  await assert.rejects(manager.update(form, { signal: controller.signal }), { status: 499 });
  assert.equal((await manager.status()).active, 'codex');
  manager.fetchImpl = async () => new Response(`secret ${form.key}`, { status: 401 });
  await assert.rejects(manager.update(form), error => /Key 无效/.test(error.message) && !error.message.includes(form.key));
  assert.equal((await manager.status()).cosmos.hasKey, false);
});

test('URLs and profiles are validated, corrupt state never silently enables a different provider', async () => {
  for (const baseUrl of ['file:///etc/passwd', 'https://user:secret@service.test', 'https://service.test?key=secret']) assert.throws(() => connectionProfile({ ...form, baseUrl }));
  assert.throws(() => connectionProfile({ ...form, key: 'abc\r\nheader' }));
  assert.throws(() => connectionProfile({ ...form, protocol: 'responses', model: '' }));
  assert.equal(connectionProfile({ ...form, baseUrl: 'https://service.test/v1/workflows/run' }).baseUrl, 'https://service.test/v1');
  assert.equal(connectionProfile({ ...form, protocol: 'chatflow', baseUrl: '' }).baseUrl, 'http://cosmos-api-inner.qingsonghealth.net/v1');
  const { manager, stateDir } = await setup(); await manager.update(form); await writeFile(manager.file, 'corrupted');
  await assert.rejects(new ModelConnections({ stateDir }).status(), /无法读取/);
});

test('workflow adapter preserves ordered history, function/custom/namespace calls and refuses unsupported input', () => {
  const request = { model: 'cosmos', input: [{ role: 'user', content: 'inspect a file' }], tools: [
    { type: 'function', name: 'read_file', parameters: { type: 'object' } }, { type: 'custom', name: 'apply_patch' },
    { type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'echo', parameters: { type: 'object' } }] },
  ] };
  assert.equal(JSON.parse(workflowPrompt(request).split('REQUEST_JSON:\n')[1]).tools[2].name, 'functions.echo');
  const result = workflowResult({ text: 'checking', calls: [{ name: 'read_file', arguments: { path: 'demo.txt' } }, { name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' }, { name: 'functions.echo', arguments: { x: 1 } }] }, request);
  assert.equal(result.output[1].type, 'function_call'); assert.deepEqual(JSON.parse(result.output[1].arguments), { path: 'demo.txt' });
  assert.equal(result.output[2].type, 'custom_tool_call'); assert.equal(result.output[3].namespace, 'functions'); assert.equal(result.output[3].name, 'echo');
  const events = responseEvents(result); assert.equal(events[0].type, 'response.created'); assert.equal(events.at(-1).type, 'response.completed');
  assert.ok(events.some(e => e.type === 'response.custom_tool_call_input.delta')); assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
  assert.throws(() => workflowResult({ text: '', calls: [{ name: 'invented', arguments: {} }] }, request), /未提供/);
  assert.throws(() => workflowPrompt({ ...request, input: [{ type: 'compaction', encrypted_content: 'private' }] }), /压缩上下文/);
  assert.throws(() => workflowPrompt({ ...request, tools: [{ type: 'web_search' }] }), /工具类型/);
  assert.throws(() => workflowResult({ text: '', calls: [{ name: 'read_file', arguments: {} }] }, { ...request, tool_choice: 'none' }), /禁用工具/);
});

class FakeBridge extends EventEmitter {
  ready = true; calls = []; threads = new Map(); async start() {} close() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ model: 'native-model', displayName: 'Native', isDefault: true }] };
    if (method === 'configRequirements/read') return { requirements: null };
    if (method === 'skills/list') return { data: [] };
    if (method === 'plugin/installed') return { marketplaces: [] };
    if (method === 'collaborationMode/list') return { data: [] };
    if (method === 'thread/list') return { data: [...this.threads.values()], nextCursor: null };
    if (method === 'thread/start') {
      const thread = { id: `thread-${this.threads.size}`, cwd: params.cwd, turns: [], modelProvider: params.modelProvider || 'openai' };
      this.threads.set(thread.id, thread); return { thread, model: params.model || 'native-model' };
    }
    if (method === 'thread/read' || method === 'thread/resume') return { thread: this.threads.get(params.threadId), model: 'native-model' };
    if (method === 'turn/start') return { turn: { id: 'turn-1' } };
    return {};
  }
}

test('workspace routes Cosmos through the local runtime, keeps approvals and pins old conversations', async t => {
  const { manager } = await setup(); await manager.update(form);
  const bridge = new FakeBridge(), workspace = new Workspace(bridge, '/private/tmp', { modelConnections: manager });
  t.after(() => { for (const timer of workspace.timers.values()) clearTimeout(timer); });
  await workspace.bootstrap();
  const sent = await workspace.send({ text: 'fictional task', cwd: '/private/tmp', mode: 'workspace-write', modelService: 'cosmos' });
  const start = bridge.calls.find(c => c.method === 'thread/start').params;
  assert.equal(start.modelProvider, COSMOS_PROVIDER); assert.equal(start.approvalPolicy, 'on-request'); assert.equal(start.sandbox, 'workspace-write');
  const turn = bridge.calls.find(c => c.method === 'turn/start').params;
  assert.equal(turn.model, 'cosmos-workflow'); assert.equal(turn.collaborationMode.settings.model, 'cosmos-workflow');
  assert.equal(workspace.threads.get(sent.threadId).model, COSMOS_MODEL);
  assert.equal(JSON.stringify(bridge.calls).includes(form.key), false);
  workspace.threads.get(sent.threadId).busy = false;
  await assert.rejects(workspace.send({ threadId: sent.threadId, text: 'keep', cwd: '/private/tmp', model: 'native-model', mode: 'workspace-write' }), /新建对话/);
  await manager.update({ action: 'select', provider: 'codex', revision: 1 });
  await workspace.send({ text: 'native', cwd: '/private/tmp', mode: 'workspace-write', modelService: 'codex' });
  assert.equal(bridge.calls.filter(c => c.method === 'thread/start').at(-1).params.modelProvider, undefined);
});

test('HTTP configuration and proxy enforce session, CSRF, origin and unguessable runtime routes', async t => {
  const { manager } = await setup(); const app = createApplication({ bridge: new FakeBridge(), cwd: '/private/tmp', modelConnections: manager });
  await app.start(0); t.after(() => app.close());
  const base = manager.origin, page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  const boot = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
  const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-codex-csrf': boot.csrf };
  assert.equal((await fetch(`${base}/api/model-connections`)).status, 401);
  assert.equal((await fetch(`${base}/api/model-connections`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(form) })).status, 403);
  const saved = await fetch(`${base}/api/model-connections`, { method: 'POST', headers, body: JSON.stringify(form) });
  assert.equal(saved.status, 200); assert.equal((await saved.text()).includes(form.key), false);
  const options = await manager.options(COSMOS_MODEL), proxy = options.config[`model_providers.${COSMOS_PROVIDER}`].base_url + '/responses';
  assert.equal((await fetch(proxy, { method: 'POST', headers, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/internal/model/${'a'.repeat(64)}/v1/responses`, { method: 'POST', body: '{}' })).status, 403);
  manager.fetchImpl = async () => new Response(JSON.stringify({ data: { status: 'succeeded', outputs: { output: JSON.stringify({ text: 'mock response', calls: [] }) } } }));
  const stream = await fetch(proxy, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'anything', input: [], tools: [], stream: true }) });
  assert.equal(stream.status, 200); const text = await stream.text(); assert.match(text, /response.completed/); assert.match(text, /mock response/); assert.ok(!text.includes(form.key));
});
