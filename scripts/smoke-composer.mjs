// Opt-in: uses the existing login and model quota; creates only a test thread.
// --status only reads state and prints whether restarting the local service is safe.
import assert from 'node:assert/strict';
const urlIndex = process.argv.indexOf('--url');
const base = process.env.DESK_URL || (urlIndex >= 0 && process.argv[urlIndex + 1]) || 'http://127.0.0.1:4317';
const page = await fetch(base);
const cookie = page.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const html = await page.text();
assert.match(html, /id="addButton"/);
if (!process.argv.includes('--status')) {
  const controller = await fetch(`${base}/composer.js`);
  assert.equal(controller.status, 200);
  assert.match(await controller.text(), /export function createComposerTools/);
}
async function get(route) {
  const response = await fetch(`${base}${route}`, { headers: { cookie } });
  const value = await response.json(); assert.equal(response.status, 200, value.error); return value;
}
const boot = await get('/api/bootstrap');
assert.equal(boot.connected, true, boot.error);
if (process.argv.includes('--status')) {
  for (const asset of ['/app.js', '/composer.js', '/permissions.js', '/permission-presets.js', '/interactions.js', '/file-tree.js', '/file-editor.js', '/editor-window.js', '/editor-tools.js', '/workbench.js', '/task-results.js', '/message-timing.js', '/code-highlight.js', '/style.css', '/favicon.svg']) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200, `Missing asset: ${asset}`);
    await response.text();
  }
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { headers: { cookie }, signal: controller.signal });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (!buffer.includes('\n\n')) buffer += decoder.decode((await reader.read()).value, { stream: true });
  controller.abort();
  const snapshot = JSON.parse(buffer.split('\n').find(line => line.startsWith('data: ')).slice(6));
  const busy = snapshot.threads.filter(t => t.busy).map(t => t.id);
  console.log(JSON.stringify({ connected: boot.connected, busy, models: boot.models.map(m => m.id), permissions: boot.permissions, permissionMenu: html.includes('id="permissionButton"') }));
  process.exit(busy.length ? 1 : 0);
}
const headers = { cookie, Origin: base, 'Content-Type': 'application/json', 'X-Codex-CSRF': boot.csrf };
async function post(route, body) {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const value = await response.json(); assert.equal(response.status, 200, value.error); return value;
}
async function finish(id) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const thread = await get(`/api/threads/${id}`);
    if (!thread.busy) { assert.ok(!thread.error, thread.error); return thread; }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  await post('/api/interrupt', { threadId: id });
  throw new Error('Composer smoke test timed out; test turn interrupted');
}
const catalog = await get(`/api/capabilities?cwd=${encodeURIComponent(boot.cwd)}`);
assert.ok(catalog.planSupported);
assert.ok(boot.models.some(m => m.id === 'gpt-6-astra'), 'Expected models from Cursor extension runtime');
const model = boot.models.find(m => m.id.includes('luna'))?.id || boot.models[0].id;
const common = { cwd: boot.cwd, model, mode: 'read-only', effort: 'low' };
const probe = 'COMPOSER_PROBE_73';
const attachment = await post('/api/attachments/upload', { name: 'composer-probe.txt', base64: Buffer.from(probe).toString('base64') });
const first = await post('/api/send', { ...common, attachments: [attachment.id], text: '这是本地网页联调。只读取附加的 composer-probe.txt 文件，只回复文件中的探针词。不得修改文件或访问外部服务。' });
const firstResult = await finish(first.threadId);
assert.match(firstResult.items.filter(i => i.type === 'agentMessage').at(-1).text, new RegExp(probe));
console.log('附件读取与推理强度通过');
const pdf = catalog.plugins.find(p => p.name === 'pdf');
assert.ok(pdf, 'Expected the installed PDF plugin');
let goalSet = false;
try {
  const goal = await post('/api/goal', { threadId: first.threadId, objective: '暂停状态的网页目标接口测试，无需执行其他任务。', status: 'paused', tokenBudget: 2000 });
  goalSet = true;
  assert.equal(goal.goal.status, 'paused');
  assert.equal(goal.goal.tokenBudget, 2000);
  await post('/api/send', { ...common, threadId: first.threadId, plan: true, capabilities: [pdf.key], text: '这是计划模式和插件引用的协议联调，不是 PDF 处理任务。不要调用工具或读取文件，不要继续任何目标。仅回复 PLAN_COMPOSER_OK。' });
  const second = await finish(first.threadId);
  assert.match(second.items.filter(i => i.type === 'agentMessage').at(-1).text, /PLAN_COMPOSER_OK/);
  assert.equal(second.plan, true);
  assert.ok(second.items.filter(i => i.type === 'userMessage').at(-1).attachments.some(a => a.kind === 'mention'));
  console.log(JSON.stringify({ ok: true, threadId: first.threadId, model, plan: true, goal: 'paused', attachment: true, plugin: pdf.title, pluginsAvailable: catalog.plugins.length, skillsAvailable: catalog.skills.length }));
} finally {
  if (goalSet) await post('/api/goal', { threadId: first.threadId, clear: true });
}
