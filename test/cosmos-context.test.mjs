import test from 'node:test';
import assert from 'node:assert/strict';
import { planCosmosTools } from '../lib/cosmos-context.mjs';
import { cosmosResponse, workflowPrompt } from '../lib/cosmos-transport.mjs';

const profile = { protocol: 'chatflow', key: 'fictional-only', baseUrl: 'https://not-contacted.example/v1', inputKey: 'input', outputKey: 'output' };
const tool = (name, type = 'function') => ({ type, name, description: `Tool ${name}. Approval and project permissions must be checked before execution. ` + 'Detailed documentation. '.repeat(90), ...(type === 'custom' ? { format: { type: 'text' } } : { parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }) });
const tools = () => [...Array.from({ length: 20 }, (_, i) => tool(`plugin_${i}`)), { type: 'namespace', name: 'local', description: 'Local operations require runtime approval.', tools: [tool('read_file'), tool('patch', 'custom')] }];
const request = (extra = {}) => ({ instructions: 'Preserve all approval requirements and skill instructions.', input: [{ role: 'developer', content: 'Permission rules and skill list' }, { role: 'user', content: 'Project AGENTS.md rules' }, { role: 'user', content: 'hello' }], tools: tools(), ...extra });
const response = (value, protocol = 'chatflow') => new Response(JSON.stringify(protocol === 'chatflow' ? { event: 'message', answer: JSON.stringify(value) } : { data: { status: 'succeeded', outputs: { output: JSON.stringify(value) } } }));
const payload = options => JSON.parse(JSON.parse(options.body).inputs.input.split('REQUEST_JSON:\n')[1]);

test('large tool sets become a compact catalog; rules, history and original full schemas remain intact', () => {
  const original = request(), snapshot = JSON.stringify(original), plan = planCosmosTools(original), view = plan.view();
  assert.equal(plan.lazy, true); assert.equal(view.request.tools.length, 0); assert.equal(view.catalog.length, 22);
  assert.ok(view.catalog.every(t => [...t.summary].length <= 80));
  assert.equal(view.request.instructions, original.instructions); assert.strictEqual(view.request.input, original.input);
  assert.equal(JSON.stringify(original), snapshot);
  const prompt = workflowPrompt(view.request, view);
  assert.ok(prompt.length < workflowPrompt(original).length * 0.25);
  assert.match(prompt, /load_tools/); assert.match(prompt, /grants no execution permission/);
  plan.load(['local.patch', 'plugin_1']);
  const loaded = plan.view();
  assert.strictEqual(loaded.request.tools[0], original.tools[1]);
  assert.deepEqual(loaded.request.tools[1], { ...original.tools.at(-1), tools: [original.tools.at(-1).tools[1]] });
  assert.ok(!loaded.catalog.some(t => ['local.patch', 'plugin_1'].includes(t.name)));
  assert.equal(JSON.stringify(original), snapshot);
});

test('recent calls preload exact current schemas without sharing state with other requests', () => {
  const history = [...request().input, ...Array.from({ length: 6 }, (_, i) => ({ type: 'function_call', name: `plugin_${i}`, arguments: '{}' })), { type: 'custom_tool_call', namespace: 'local', name: 'patch', input: 'fictional' }];
  const original = request({ input: history }), plan = planCosmosTools(original), view = plan.view();
  assert.equal(view.request.tools.length, 4);
  assert.deepEqual(view.request.tools.slice(0, 3).map(t => t.name), ['plugin_3', 'plugin_4', 'plugin_5']);
  assert.equal(view.request.tools.at(-1).tools[0].name, 'patch');
  assert.strictEqual(view.request.input, history);
  plan.load(['plugin_10']); assert.equal(planCosmosTools(original).view().catalog.some(t => t.name === 'plugin_10'), true);
  const changed = request({ input: [{ type: 'function_call', name: 'removed_tool' }] });
  assert.equal(planCosmosTools(changed).view().request.tools.length, 0);
});

test('small and forced tool sets keep their semantics; tools disabled means no catalog or definitions', () => {
  for (const original of [request({ tools: [tool('only')] }), request({ tool_choice: { type: 'function', name: 'plugin_1' } })]) {
    const plan = planCosmosTools(original); assert.equal(plan.lazy, false); assert.strictEqual(plan.view().request.tools, original.tools);
  }
  const view = planCosmosTools(request({ tool_choice: 'none' })).view();
  assert.deepEqual(view.request.tools, []); assert.deepEqual(view.catalog, []);
  assert.throws(() => planCosmosTools(request()).load(['unknown']), /无效/);
  assert.throws(() => planCosmosTools(request()).load(Array.from({ length: 9 }, (_, i) => `plugin_${i}`)), /无效/);
});

test('ordinary conversation uses one inference without loading any tool schemas', async () => {
  let calls = 0;
  const result = await cosmosResponse(profile, request(), { fetchImpl: async (_, options) => {
    calls++; const sent = payload(options);
    assert.equal(sent.tools.length, 0); assert.equal(sent.tool_catalog.length, 22);
    return response({ text: 'hello back', calls: [] });
  } });
  assert.equal(calls, 1); assert.equal(result.output[0].content[0].text, 'hello back');
});

test('Chatflow and Workflow load requested schemas then return real calls to the runtime without executing them', async () => {
  for (const protocol of ['chatflow', 'workflow']) {
    const seen = [];
    const original = request();
    const result = await cosmosResponse({ ...profile, protocol }, original, { fetchImpl: async (_, options) => {
      const sent = payload(options); seen.push(sent);
      assert.deepEqual(sent.input, original.input);
      if (seen.length === 1) return response({ text: '', calls: [], load_tools: ['local.patch', 'plugin_2'] }, protocol);
      assert.deepEqual(sent.tools.map(t => t.name), ['plugin_2', 'local.patch']);
      assert.deepEqual(sent.tools[0], original.tools[2]);
      assert.match(sent.tools[1].description, /Approval and project permissions/);
      return response({ text: '', calls: [{ name: 'local.patch', input: 'fictional patch' }, { name: 'plugin_2', arguments: { value: 'test' } }] }, protocol);
    } });
    assert.equal(seen.length, 2); assert.equal(result.output[0].type, 'custom_tool_call');
    assert.equal(result.output[0].namespace, 'local'); assert.equal(result.output[0].name, 'patch');
    assert.equal(result.output[1].name, 'plugin_2');
    assert.ok(seen.reduce((n, v) => n + JSON.stringify(v).length, 0) < JSON.stringify(original).length);
  }
});

test('unknown, unloaded and mixed tool calls fail closed without execution or inference retries', async () => {
  for (const value of [
    { text: '', calls: [{ name: 'plugin_1', arguments: { value: 'guessing' } }] },
    { text: '', calls: [], load_tools: ['invented'] },
    { text: 'must not silently discard', calls: [], load_tools: ['plugin_1'] },
    { text: '', calls: [{ name: 'plugin_1', arguments: {} }], load_tools: ['plugin_1'] },
  ]) {
    let count = 0;
    await assert.rejects(cosmosResponse(profile, request(), { fetchImpl: async () => { count++; return response(value); } }));
    assert.equal(count, 1);
  }
});

test('discovery is bounded, repeats are rejected and cancellation prevents follow-up inference', async () => {
  let count = 0;
  await assert.rejects(cosmosResponse(profile, request(), { fetchImpl: async () => response({ text: '', calls: [], load_tools: [`plugin_${count++}`] }) }), /超过两轮/);
  assert.equal(count, 3);
  count = 0;
  await assert.rejects(cosmosResponse(profile, request(), { fetchImpl: async () => { count++; return response({ text: '', calls: [], load_tools: ['plugin_0'] }); } }), /重复请求/);
  assert.equal(count, 2);
  count = 0; const abort = new AbortController();
  await assert.rejects(cosmosResponse(profile, request(), { signal: abort.signal, fetchImpl: async () => { count++; abort.abort(); return response({ text: '', calls: [], load_tools: ['plugin_0'] }); } }), { status: 499 });
  assert.equal(count, 1);
});
