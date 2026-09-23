// Local HTTP integration check; never starts a model turn or reads file contents.
import assert from 'node:assert/strict';
const urlIndex = process.argv.indexOf('--url');
const base = (urlIndex >= 0 && process.argv[urlIndex + 1]) || 'http://127.0.0.1:4318';
const page = await fetch(base), html = await page.text();
const cookie = page.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
async function get(route) {
  const response = await fetch(`${base}${route}`, { headers: { cookie } });
  assert.equal(response.status, 200, route); return response.json();
}
const boot = await get('/api/bootstrap');
const controller = new AbortController();
const response = await fetch(`${base}/api/events`, { headers: { cookie }, signal: controller.signal });
const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
while (!buffer.includes('\n\n')) buffer += decoder.decode((await reader.read()).value, { stream: true });
controller.abort();
const snapshot = JSON.parse(buffer.split('\n').find(line => line.startsWith('data: ')).slice(6));
const busy = snapshot.threads.filter(thread => thread.busy).map(thread => thread.id);
if (process.argv.includes('--status')) { console.log(JSON.stringify({ connected: boot.connected, busy })); process.exit(busy.length ? 1 : 0); }
assert.match(html, /id="projectFileTree"/);
assert.equal((await fetch(`${base}/file-tree.js`)).status, 200);
const root = await get(`/api/project/files?cwd=${encodeURIComponent(boot.cwd)}`);
assert.ok(root.entries.some(entry => entry.path === 'codex-web-shell'));
for (const name of ['AIdata', '待删除', '祥誉-交接', '.git', '.vscode', 'openclaw']) assert.ok(!root.entries.some(entry => entry.name === name));
const nested = await get(`/api/project/files?cwd=${encodeURIComponent(boot.cwd)}&path=codex-web-shell`);
assert.ok(nested.entries.some(entry => entry.path === 'codex-web-shell/README.md'));
const headers = { cookie, origin: base, 'Content-Type': 'application/json', 'X-Codex-CSRF': boot.csrf };
const added = await fetch(`${base}/api/project/attach`, { method: 'POST', headers, body: JSON.stringify({ cwd: boot.cwd, path: 'codex-web-shell/README.md' }) });
assert.equal(added.status, 200);
const attachment = await added.json(); assert.equal(attachment.projectPath, 'codex-web-shell/README.md');
const blocked = await fetch(`${base}/api/project/files?cwd=${encodeURIComponent(boot.cwd)}&path=../`, { headers: { cookie } });
assert.equal(blocked.status, 403);
console.log(JSON.stringify({ ok: true, connected: boot.connected, busy, tree: true, lazyDirectory: true, attachmentReference: true, traversalBlocked: true, modelTurns: 0 }));
