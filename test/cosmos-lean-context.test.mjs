import test from 'node:test';
import assert from 'node:assert/strict';
import { planCosmosContext } from '../lib/cosmos-context.mjs';
import { cosmosResponse } from '../lib/cosmos-transport.mjs';

const profile = { protocol: 'chatflow', key: 'fictional-only', baseUrl: 'https://not-contacted.example/v1', inputKey: 'input', outputKey: 'output' };
const message = (role, text) => ({ role, type: 'message', content: [{ type: 'input_text', text }] });
const generated = [
  message('developer', '<skills_instructions>Skill catalog with LOCAL_SKILL_MARKER</skills_instructions>\n<permissions instructions>READ_ONLY_PERMISSION_MARKER: request approval for writes.</permissions instructions>\n<collaboration_mode>Default</collaboration_mode>'),
  message('user', '<recommended_plugins>Unused plugins</recommended_plugins>\n# AGENTS.md instructions for /fictional/project\n\n<INSTRUCTIONS>PROJECT_RULE_MARKER: no SQL without --lzy; forbidden_path must not be read.</INSTRUCTIONS>\n<environment_context><cwd>/fictional/project</cwd></environment_context>'),
];
const actual = [message('user', '用中文回答；没有授权不要执行命令。'), { role: 'assistant', content: '好的。' }, message('user', '你是谁')];
const tool = { type: 'function', name: 'fictional_echo', description: 'A mock tool, no real actions.', parameters: { type: 'object', properties: { value: { type: 'string' } } } };
const request = (extra = {}) => ({ instructions: 'CUSTOM_INSTRUCTIONS_MUST_REMAIN: keep user data private.', input: [...generated, ...actual], tools: [tool], ...extra });
const reply = (answer, protocol = 'chatflow') => new Response(JSON.stringify(protocol === 'chatflow' ? { answer: typeof answer === 'string' ? answer : JSON.stringify(answer) } : { data: { status: 'succeeded', outputs: { output: typeof answer === 'string' ? answer : JSON.stringify(answer) } } }));
const sent = options => JSON.parse(JSON.parse(options.body).inputs.input.split('REQUEST_JSON:\n')[1]);

test('conversation defers only recognized prefix scaffolding and preserves custom instructions and actual history', () => {
  const original = request(), snapshot = JSON.stringify(original), plan = planCosmosContext(original);
  assert.equal(plan.deferred, true); assert.equal(plan.lightRequest.instructions, original.instructions);
  assert.deepEqual(plan.lightRequest.input, actual); assert.deepEqual(plan.lightRequest.tools, []);
  assert.strictEqual(plan.request, original); assert.equal(JSON.stringify(original), snapshot);
  for (const text of ['Custom developer instruction', '<skills_instructions>catalog</skills_instructions>\nCustom restriction outside scaffold']) {
    const custom = message('developer', text);
    assert.ok(planCosmosContext(request({ input: [custom, ...generated, ...actual] })).lightRequest.input.includes(custom));
  }
  const userMessage = message('user', '请解释这段：\n<environment_context>example</environment_context>');
  const lateContext = message('user', '<environment_context>Must keep after real conversation</environment_context>');
  const later = planCosmosContext(request({ input: [...generated, userMessage, lateContext] }));
  assert.deepEqual(later.lightRequest.input, [userMessage, lateContext]);
});

test('ongoing tool calls bypass conversation gating; forced tools and structured output retain context', () => {
  const current = request({ input: [...generated, ...actual, { type: 'function_call', name: tool.name, call_id: 'one', arguments: '{}' }, { type: 'function_call_output', call_id: 'one', output: 'done' }] });
  assert.equal(planCosmosContext(current).deferred, false);
  for (const extra of [{ tool_choice: 'required' }, { tool_choice: { type: 'function', name: tool.name } }, { tool_choice: 'none' }, { text: { format: { type: 'json_schema' } } }]) {
    const original = request(extra), plan = planCosmosContext(original);
    assert.equal(plan.deferred, false); assert.strictEqual(plan.request.input, original.input);
  }
});

test('plain conversation sends no tools, skill list, paths or project scaffolding and needs one model call', async () => {
  for (const protocol of ['chatflow', 'workflow']) {
    let count = 0;
    const result = await cosmosResponse({ ...profile, protocol }, request(), { fetchImpl: async (_, options) => {
      count++; const input = sent(options);
      assert.equal(input.context_mode, 'conversation'); assert.equal(input.tools, undefined); assert.equal(input.tool_catalog, undefined);
      assert.match(input.instructions, /CUSTOM_INSTRUCTIONS_MUST_REMAIN/);
      assert.deepEqual(input.input, actual);
      assert.doesNotMatch(JSON.stringify(input), /LOCAL_SKILL_MARKER|READ_ONLY_PERMISSION_MARKER|PROJECT_RULE_MARKER|fictional\/project/);
      return reply('我是柠檬，使用你配置的 Cosmos 模型服务。', protocol);
    } });
    assert.equal(count, 1); assert.equal(result.output.length, 1); assert.equal(result.output[0].type, 'message');
    assert.match(result.output[0].content[0].text, /^我是柠檬/);
  }
});

test('project work restores exact instructions, permissions and skills before any tool call; continuation keeps them', async () => {
  const original = request(); let count = 0;
  const fetchImpl = async (_, options) => {
    count++; const input = sent(options);
    if (count === 1) return reply({ text: '', calls: [], load_context: 'workspace' });
    assert.deepEqual(input.input.slice(0, original.input.length), original.input);
    assert.deepEqual(input.tools, [tool]);
    assert.match(input.instructions, /CUSTOM_INSTRUCTIONS_MUST_REMAIN/);
    assert.match(JSON.stringify(input), /LOCAL_SKILL_MARKER/); assert.match(JSON.stringify(input), /READ_ONLY_PERMISSION_MARKER/); assert.match(JSON.stringify(input), /PROJECT_RULE_MARKER/);
    return count === 2 ? reply({ text: '', calls: [{ name: tool.name, arguments: { value: 'fake' } }] }) : reply('工具结果已收到。');
  };
  const first = await cosmosResponse(profile, original, { fetchImpl });
  assert.equal(first.output[0].type, 'function_call'); assert.equal(count, 2);
  const continued = await cosmosResponse(profile, { ...original, input: [...original.input, ...first.output, { type: 'function_call_output', call_id: first.output[0].call_id, output: 'mock result' }] }, { fetchImpl });
  assert.equal(count, 3); assert.equal(continued.output[0].content[0].text, '工具结果已收到。');
});

test('a lightweight response cannot call tools or mix context loading with actions', async () => {
  for (const value of [
    { text: '', calls: [{ name: tool.name, arguments: {} }] },
    { text: '', calls: [], load_tools: [tool.name] },
    { text: '', calls: [], load_context: 'invented' },
    { text: '混合回复', calls: [], load_context: 'workspace' },
    { text: '', calls: [{ name: tool.name, arguments: {} }], load_context: 'workspace' },
  ]) {
    let calls = 0;
    await assert.rejects(cosmosResponse(profile, request(), { fetchImpl: async () => { calls++; return reply(value); } }));
    assert.equal(calls, 1);
  }
});

test('context load is bounded and abort prevents any following inference', async () => {
  let calls = 0;
  await assert.rejects(cosmosResponse(profile, request(), { fetchImpl: async () => { calls++; return reply({ text: '', calls: [], load_context: 'workspace' }); } }), /上下文/);
  assert.equal(calls, 2);
  const abort = new AbortController(); calls = 0;
  await assert.rejects(cosmosResponse(profile, request(), { signal: abort.signal, fetchImpl: async () => { calls++; abort.abort(); return reply({ text: '', calls: [], load_context: 'workspace' }); } }), { status: 499 });
  assert.equal(calls, 1);
});

test('plain replies are accepted but malformed control envelopes and required-tool probes stay strict', async () => {
  for (const text of ['普通回复', '[查看文件](demo.sql)', '```sql\nSELECT 1\n```']) {
    const result = await cosmosResponse(profile, { input: [message('user', '解释一下')], tools: [tool] }, { fetchImpl: async () => reply(text) });
    assert.equal(result.output[0].content[0].text, text);
  }
  for (const value of ['{"text":"partial","calls":', 'prefix {"calls": [', '```json\n{"calls":', { text: 'wrong', calls: 'not-an-array' }]) {
    await assert.rejects(cosmosResponse(profile, request(), { fetchImpl: async () => reply(value) }));
  }
  await assert.rejects(cosmosResponse(profile, request({ tool_choice: 'required' }), { fetchImpl: async () => reply('SELECT 1') }), /工具协议 JSON/);
});

test('incomplete SSE still rejects a complete-looking plain answer instead of displaying success', async () => {
  await assert.rejects(cosmosResponse(profile, request(), { fetchImpl: async () => new Response('data: {"event":"message","answer":"已完成"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) }), /断开/);
});
