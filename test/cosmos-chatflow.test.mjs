import test from 'node:test';
import assert from 'node:assert/strict';
import { cosmosResponse, cosmosIdentity } from '../lib/cosmos-transport.mjs';
import { ModelConnections, connectionProfile, COSMOS_MODEL } from '../lib/model-connections.mjs';

const profile = { protocol: 'chatflow', key: 'fictional-chatflow-key', baseUrl: 'https://cosmos.example/v1', inputKey: 'input', outputKey: 'ignored' };
const request = { model: 'cosmos-chatflow', input: [{ role: 'user', content: '虚构的测试消息' }], tools: [], tool_choice: 'none' };
const frame = (event, eol = '\n') => `data: ${JSON.stringify(event)}${eol}${eol}`;
function stream(text, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
const answer = result => result.output[0].content[0].text;

test('Cosmos identity distinguishes the model service from Codex host without replacing rules or history', () => {
  const original = { ...request, instructions: 'You are a coding agent running in the Codex CLI.\nApproval is required before writes.',
    input: [{ role: 'assistant', content: '我是 Codex' }, { role: 'user', content: '你是谁' }], tools: [{ type: 'function', name: 'read_file' }] };
  const snapshot = JSON.stringify(original);
  const patched = cosmosIdentity(original, profile);
  assert.ok(patched.instructions.startsWith(original.instructions));
  assert.match(patched.instructions, /assistant name is 柠檬/);
  assert.match(patched.instructions, /user-configured Cosmos model service/);
  assert.match(patched.instructions, /not evidence of your underlying model identity/);
  assert.match(patched.instructions, /do not guess/);
  assert.match(patched.instructions, /permissions, approval requirements/);
  assert.strictEqual(patched.input, original.input); assert.strictEqual(patched.tools, original.tools);
  assert.equal(JSON.stringify(original), snapshot); assert.ok(!JSON.stringify(patched).includes(profile.key));
  const native = cosmosIdentity(original, { ...profile, protocol: 'responses', model: 'private-model-1' });
  assert.match(native.instructions, /configured model ID is "private-model-1"/);
});

test('every Cosmos transport carries identity facts including existing conversations; reply text is never rewritten', async () => {
  for (const protocol of ['chatflow', 'workflow', 'responses']) {
    const value = { text: 'upstream reply is preserved', calls: [] };
    const result = await cosmosResponse({ ...profile, protocol, model: 'private-model-1', outputKey: 'output' }, request, { fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body);
      const forwarded = protocol === 'responses' ? body : JSON.parse((body.query || body.inputs.input).split('REQUEST_JSON:\n')[1]);
      assert.match(forwarded.instructions, /Current deployment identity/);
      assert.match(forwarded.instructions, /Cosmos model service/);
      assert.deepEqual(forwarded.input, request.input);
      return new Response(JSON.stringify(protocol === 'responses'
        ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: value.text }] }] }
        : protocol === 'chatflow' ? { event: 'message', answer: JSON.stringify(value) }
          : { data: { status: 'succeeded', outputs: { output: JSON.stringify(value) } } }));
    } });
    assert.equal(answer(result), value.text);
  }
});

test('Chatflow validates both tool rounds through chat-messages and keeps full context without remote memory', async () => {
  const calls = [];
  const manager = new ModelConnections({ stateDir: '/private/tmp/chatflow-test-unused', ephemeral: true, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    const body = JSON.parse(options.body);
    assert.equal(body.query, body.inputs.input); assert.equal(body.response_mode, 'streaming');
    assert.equal(body.conversation_id, ''); assert.equal(body.auto_generate_name, false);
    assert.equal(body.user, 'ningmeng-local'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${profile.key}`);
    const payload = JSON.parse(body.query.split('REQUEST_JSON:\n')[1]);
    const returned = payload.input.findLast(i => i.type === 'function_call_output');
    const marker = returned ? JSON.parse(returned.output).marker : payload.input[0].content.match(/marker ([\w-]+)\./)[1];
    if (returned) assert.equal(payload.input.filter(i => i.type === 'function_call').length, 1);
    const text = JSON.stringify({ text: returned ? marker : '', calls: returned ? [] : [{ name: 'lemon_probe', arguments: { marker } }] });
    return stream(frame({ event: 'workflow_started', task_id: 'fictional-task' }) + frame({ event: 'message', answer: text }) + frame({ event: 'message_end', conversation_id: 'not-reused' }));
  } });
  assert.equal((await manager.status()).cosmos.baseUrl, 'http://cosmos-api-inner.qingsonghealth.net/v1');
  assert.equal((await manager.status()).cosmos.protocol, 'chatflow');
  const state = await manager.update({ ...profile, action: 'configure', revision: 0 });
  assert.equal(state.active, 'cosmos'); assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.url === `${profile.baseUrl}/chat-messages`));
  assert.ok(!JSON.stringify(state).includes(profile.key));
  manager.origin = 'http://127.0.0.1:54321'; assert.equal((await manager.options(COSMOS_MODEL)).model, 'cosmos-chatflow');
});

test('Chatflow parses fragmented UTF-8, CRLF, heartbeat and replacement, ignoring intermediate node outputs', async () => {
  const replacement = JSON.stringify({ text: '最终回复，中文正确', calls: [] });
  const data = ': ping\r\n\r\n' + frame({ event: 'node_finished', data: { outputs: { text: 'must not be used' } } }, '\r\n')
    + frame({ event: 'message', answer: '{"text":"discarded"' }, '\r\n') + frame({ event: 'message_replace', answer: replacement }, '\r\n')
    + frame({ event: 'workflow_finished', data: { status: 'succeeded' } }, '\r\n') + frame({ event: 'message_end' }, '\r\n');
  const result = await cosmosResponse(profile, request, { fetchImpl: async () => stream(data) });
  assert.equal(answer(result), '最终回复，中文正确');
});

test('Chatflow accepts blocking JSON when returned by a compatible server and supports query-only apps', async () => {
  const p = connectionProfile({ ...profile, inputKey: '', baseUrl: profile.baseUrl + '/chat-messages/' });
  assert.equal(p.baseUrl, profile.baseUrl); assert.equal(p.inputKey, '');
  const result = await cosmosResponse(p, request, { fetchImpl: async (_, options) => {
    assert.deepEqual(JSON.parse(options.body).inputs, {});
    return new Response(JSON.stringify({ event: 'message', answer: JSON.stringify({ text: 'done', calls: [] }) }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(answer(result), 'done');
});

test('Chatflow never accepts partial tool envelopes or a failed workflow as success', async () => {
  for (const events of [
    [ { event: 'message', answer: '{"text":"seems complete","calls":[]}' } ],
    [ { event: 'workflow_finished', data: { status: 'failed', error: profile.key } }, { event: 'message_end' } ],
    [ { event: 'message_end' } ],
  ]) {
    await assert.rejects(cosmosResponse(profile, request, { fetchImpl: async () => stream(events.map(e => frame(e)).join('')) }), error => !error.message.includes(profile.key) && /断开|未成功|没有返回/.test(error.message));
  }
});

test('Chatflow cancellation stops only its own task once and does not retry inference', async () => {
  const abort = new AbortController(), calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/stop')) return new Response('{"result":"success"}');
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame({ event: 'workflow_started', task_id: 'task-ours' })));
      const timer = setTimeout(() => abort.abort(), 10);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); controller.error(new DOMException('Aborted', 'AbortError')); }, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  await assert.rejects(cosmosResponse(profile, request, { fetchImpl, signal: abort.signal }), { status: 499 });
  assert.equal(calls.length, 2); assert.equal(calls[1].url, profile.baseUrl + '/chat-messages/task-ours/stop');
  assert.deepEqual(calls[1].body, { user: 'ningmeng-local' });
});

test('HTTP and SSE failures give useful mapped errors without exposing upstream secrets or retrying', async () => {
  for (const [code, expected] of [['not_workflow_app', /Chatflow/], ['provider_not_initialize', /模型凭据/], ['provider_quota_exceeded', /额度不足/], ['app_unavailable', /发布应用/], ['invalid_param', /长度上限/]]) {
    for (const sse of [false, true]) {
      let calls = 0;
      await assert.rejects(cosmosResponse(profile, request, { fetchImpl: async () => {
        calls++;
        const data = { event: 'error', status: 400, code, message: `private ${profile.key}` };
        return sse ? stream(frame(data)) : new Response(JSON.stringify(data), { status: 400 });
      } }), error => expected.test(error.message) && !error.message.includes(profile.key));
      assert.equal(calls, 1);
    }
  }
});
