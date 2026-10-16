import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AppApprovals } from '../lib/app-approvals.mjs';
import { createApplication } from '../server.mjs';

async function fixture(options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'lemon-approval-test-')), filePath = path.join(home, 'approvals.json');
  return { home, filePath, service: new AppApprovals({ home, filePath, platformName: 'darwin', ...options }) };
}

test('app authorization list is read-only and revocation removes only the confirmed versioned grant', async () => {
  const { home, filePath, service } = await fixture();
  assert.deepEqual(await service.list(), { available: true, initialized: false, revision: null, apps: [] });
  await assert.rejects(stat(filePath), { code: 'ENOENT' });
  const original = { approvedBundleIdentifiers: ['com.google.Chrome', 'com.example.Editor', 'com.google.Chrome'], futureMetadata: { preserved: true } };
  await writeFile(filePath, JSON.stringify(original));
  const list = await service.list();
  assert.deepEqual(list.apps.map(app => app.name), ['Google Chrome', 'com.example.Editor']); assert.equal(list.apps.length, 2);
  assert.equal(JSON.stringify(list).includes(home), false);
  await assert.rejects(service.revoke({ appId: 'com.google.Chrome', revision: list.revision }), /确认/);
  await assert.rejects(service.revoke({ appId: 'com.unknown', revision: list.revision, confirmed: true }), /变化/);
  const result = await service.revoke({ appId: 'com.google.Chrome', revision: list.revision, confirmed: true });
  assert.deepEqual(result.apps.map(app => app.appId), ['com.example.Editor']); assert.equal(result.revokedAppId, 'com.google.Chrome');
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { approvedBundleIdentifiers: ['com.example.Editor'], futureMetadata: { preserved: true } });
  await assert.rejects(service.revoke({ appId: 'com.example.Editor', revision: list.revision, confirmed: true }), /变化/);
});

test('app authorization updates reject malformed, symlinked and concurrently changed records without overwriting them', async () => {
  const { home, filePath } = await fixture();
  const original = { approvedBundleIdentifiers: ['com.example.One', 'com.example.Two'] };
  const updated = { approvedBundleIdentifiers: [...original.approvedBundleIdentifiers, 'com.example.Three'] };
  await writeFile(filePath, JSON.stringify(original));
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  let entered; const ready = new Promise(resolve => { entered = resolve; });
  const service = new AppApprovals({ home, filePath, platformName: 'darwin', beforeCommit: async () => { entered(); await gate; await writeFile(filePath, JSON.stringify(updated)); } });
  const first = await service.list(), pending = service.revoke({ appId: 'com.example.One', revision: first.revision, confirmed: true });
  await ready;
  await assert.rejects(service.revoke({ appId: 'com.example.Two', revision: first.revision, confirmed: true }), /正在更新/);
  unblock(); await assert.rejects(pending, /变化/);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), updated);
  for (const value of ['{broken', JSON.stringify({ approvedBundleIdentifiers: [3] }), JSON.stringify({ approvedBundleIdentifiers: ['../arbitrary-path'] })]) {
    await writeFile(filePath, value); assert.equal((await service.list()).available, false); assert.equal(await readFile(filePath, 'utf8'), value);
  }
  const link = path.join(home, 'link.json'); await symlink(filePath, link);
  assert.equal((await new AppApprovals({ home, filePath: link, platformName: 'darwin' }).list()).available, false);
  assert.equal((await new AppApprovals({ home, filePath, platformName: 'other' }).list()).available, false);
});

test('app authorization HTTP routes keep session, origin, CSRF and explicit confirmation checks even when the model is offline', async t => {
  class Mock extends EventEmitter { ready = false; async start() {} close() {} }
  const { home, filePath, service } = await fixture();
  await writeFile(filePath, JSON.stringify({ approvedBundleIdentifiers: ['com.example.Test'] }));
  const app = createApplication({ bridge: new Mock(), cwd: home, stateDir: path.join(home, 'state'), appApprovals: service });
  await app.start(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`, route = '/api/computer-use/approvals';
  const page = await fetch(base), cookie = page.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + route)).status, 401);
  assert.equal((await fetch(base + route, { headers: { cookie, origin: 'https://external.example' } })).status, 403);
  const boot = await (await fetch(base + '/api/bootstrap', { headers: { cookie } })).json(); assert.equal(boot.computerUseAppApprovals, true);
  const list = await (await fetch(base + route, { headers: { cookie } })).json(); assert.equal(list.apps.length, 1);
  const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-codex-csrf': boot.csrf }, body = { appId: 'com.example.Test', revision: list.revision, confirmed: true, path: '/ignored-client-path' };
  assert.equal((await fetch(base + route + '/revoke', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  assert.equal((await fetch(base + route + '/revoke', { method: 'POST', headers, body: JSON.stringify({ ...body, confirmed: false }) })).status, 400);
  const revoked = await fetch(base + route + '/revoke', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(revoked.status, 200); assert.deepEqual((await revoked.json()).apps, []);
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { approvedBundleIdentifiers: [] });
});
