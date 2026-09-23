// Local HTTP integration. Only changes its own temporary fixtures; never sends a model turn.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const index = process.argv.indexOf('--url');
const base = index >= 0 ? process.argv[index + 1] : 'http://127.0.0.1:4318';
const page = await fetch(base), cookie = page.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
const html = await page.text();
const get = async route => { const response = await fetch(base + route, { headers: { cookie } }); assert.equal(response.status, 200, route); return response.json(); };
const boot = await get('/api/bootstrap');
if (process.argv.includes('--check-idle')) {
  const response = await fetch(base + '/api/events', { headers: { cookie }, signal: AbortSignal.timeout(5000) });
  const reader = response.body.getReader(), decoder = new TextDecoder(); let data = '';
  try { while (!data.includes('\n\n')) { const { done, value } = await reader.read(); if (done) break; data += decoder.decode(value, { stream: true }); } } finally { await reader.cancel(); }
  const snapshot = JSON.parse(data.split('\n').find(line => line.startsWith('data: ')).slice(6));
  const { processes } = await get('/api/terminal'), { jobs } = await get('/api/schedules');
  const busyThreads = snapshot.threads.filter(thread => thread.busy).length, runningCommands = processes.filter(process => process.running).length, enabledSchedules = jobs.filter(job => job.enabled).length;
  const queuedMessages = snapshot.threads.reduce((count, thread) => count + (thread.queue?.length || 0), 0);
  console.log(JSON.stringify({ connected: boot.connected, busyThreads, runningCommands, enabledSchedules, queuedMessages }));
  if (busyThreads || runningCommands || enabledSchedules || queuedMessages) process.exitCode = 2;
} else {
  for (const id of ['projectList', 'addProjectButton', 'projectPicker', 'chooseProject']) assert.ok(html.includes(`id="${id}"`));
  assert.equal((await fetch(base + '/project-list.js')).status, 200);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-projects-smoke-'))), roots = ['one', 'two'].map(name => path.join(root, name));
  for (const cwd of roots) { await mkdir(cwd); await writeFile(path.join(cwd, 'same.py'), `# ${path.basename(cwd)} fixture\n`); }
  const listing = await get(`/api/project/files?cwd=${encodeURIComponent(root)}`); assert.deepEqual(listing.entries.map(entry => entry.name), ['one', 'two']);
  for (const cwd of roots) {
    const result = await get(`/api/project/files?cwd=${encodeURIComponent(cwd)}`); assert.equal(result.cwd, cwd); assert.equal(result.entries[0].name, 'same.py');
    const file = await get(`/api/project/file?cwd=${encodeURIComponent(cwd)}&path=same.py`), content = `# edited ${path.basename(cwd)} fixture\n`;
    const saved = await fetch(base + '/api/project/save', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-codex-csrf': boot.csrf }, body: JSON.stringify({ cwd, path: 'same.py', version: file.version, content }) }); assert.equal(saved.status, 200);
    assert.equal(await readFile(path.join(cwd, 'same.py'), 'utf8'), content);
  }
  assert.equal(await readFile(path.join(roots[0], 'same.py'), 'utf8'), '# edited one fixture\n');
  const missing = await fetch(`${base}/api/project/files?cwd=${encodeURIComponent(path.join(root, 'missing'))}`, { headers: { cookie } }); assert.ok(missing.status >= 400);
  console.log(JSON.stringify({ ok: true, projectPickerAsset: true, independentProjectRoots: 2, sameNameFilesSavedSeparately: true, invalidDirectoryRejected: true, modelTurns: 0, onlyTemporaryFixturesModified: true }));
}
