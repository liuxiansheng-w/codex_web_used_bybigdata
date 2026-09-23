// Explicit opt-in smoke test: creates one real, read-only Codex conversation.
// It uses the existing local login and consumes a small amount of model quota.
import assert from 'node:assert/strict';
const base = process.env.DESK_URL || 'http://127.0.0.1:4317';
const page = await fetch(base);
const cookie = page.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie, 'Could not establish local browser session');
const bootstrap = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
assert.equal(bootstrap.connected, true);
const headers = { cookie, Origin: base, 'Content-Type': 'application/json', 'X-Codex-CSRF': bootstrap.csrf };
async function post(route, body) {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  return result;
}
const controller = new AbortController();
const response = await fetch(`${base}/api/events`, { headers: { cookie }, signal: controller.signal });
const reader = response.body.getReader();
const decoder = new TextDecoder();
const events = [];
const consume = (async () => {
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (frame.startsWith('event: thread') && data) events.push(JSON.parse(data.slice(6)));
      }
    }
  } catch (error) { if (error.name !== 'AbortError') throw error; }
})();
async function finish(id) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const snapshot = await (await fetch(`${base}/api/threads/${id}`, { headers: { cookie } })).json();
    if (!snapshot.busy) { assert.ok(!snapshot.error, snapshot.error); return snapshot; }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error('Timed out waiting for real Codex reply');
}
try {
  const model = bootstrap.models.find(m => m.id.includes('luna'))?.id || bootstrap.models[0]?.id;
  const common = { cwd: bootstrap.cwd, model, mode: 'read-only' };
  const first = await post('/api/send', { ...common, text: '这是网页连通性测试。不要读取文件，不要运行命令或工具。请记住测试词 desk-mint-47，只回复：连接成功 desk-mint-47' });
  const firstResult = await finish(first.threadId);
  assert.match(firstResult.items.filter(i => i.type === 'agentMessage').map(i => i.text).join('\n'), /desk-mint-47/);
  await post('/api/send', { ...common, threadId: first.threadId, text: '继续连通性测试：不要使用工具，只回复我上一条让你记住的测试词。' });
  const second = await finish(first.threadId);
  assert.match(second.items.filter(i => i.type === 'agentMessage').at(-1).text, /desk-mint-47/);
  assert.ok(events.some(t => t.id === first.threadId && t.busy), 'Expected live progress event');
  assert.equal(second.items.filter(i => i.type === 'userMessage').length, 2);
  console.log(JSON.stringify({ ok: true, threadId: first.threadId, model, turns: 2, streamedSnapshots: events.filter(t => t.id === first.threadId).length, message: '真实登录、两轮上下文和 SSE 事件验证通过' }));
} finally { controller.abort(); await consume; }
