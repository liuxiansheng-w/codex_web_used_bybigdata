import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { defaultExecutable } from '../lib/bridge.mjs';
import { Workspace } from '../lib/workspace.mjs';
import { createModelCatalogRefresh } from '../public/interactions.js';

test('model catalog runtime follows the desktop app, explicit overrides and existing fallbacks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lemon-runtime-'));
  const home = path.join(root, 'home'), apps = path.join(root, 'apps');
  const options = { home, applicationRoots: [apps], platformName: 'darwin', archName: 'arm64', override: '' };
  const desktop = path.join(apps, 'ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
  const extension = path.join(home, '.cursor/extensions/openai.chatgpt-test/bin/macos-aarch64/codex');
  for (const file of [desktop, extension]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, '#!/bin/sh\n', { mode: 0o700 }); }
  await writeFile(path.join(home, '.cursor/extensions/extensions.json'), JSON.stringify([{ identifier: { id: 'openai.chatgpt' }, relativeLocation: 'openai.chatgpt-test' }]));
  assert.equal(await defaultExecutable(options), desktop);
  assert.equal(await defaultExecutable({ ...options, override: '/explicit/codex' }), '/explicit/codex');
  await chmod(desktop, 0o600);
  assert.equal(await defaultExecutable(options), extension);
  await chmod(extension, 0o600);
  assert.equal(await defaultExecutable(options), 'codex');
});

test('model catalog loads all visible pages atomically, deduplicates reads and retains Cosmos', async () => {
  const bridge = new EventEmitter(); let broken = false, calls = [];
  bridge.request = async (method, params) => {
    assert.equal(method, 'model/list'); assert.equal(params.includeHidden, false); calls.push(params.cursor || null);
    if (!params.cursor) return { data: [{ model: 'first', displayName: 'First' }, { model: 'hidden', hidden: true }], nextCursor: 'page2' };
    if (broken) throw new Error('catalog unavailable');
    return { data: [{ model: 'first', displayName: 'First' }, { model: 'new-model', displayName: 'New model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: null };
  };
  const modelConnections = { loading: Promise.resolve(), value: { cosmos: { verifiedAt: 1 } }, model: () => ({ model: 'lemon-cosmos', displayName: 'Cosmos' }) };
  const workspace = new Workspace(bridge, '/project', { modelConnections });
  const [a, b] = await Promise.all([workspace.readModels(), workspace.readModels()]);
  assert.deepEqual(a, b); assert.deepEqual(calls, [null, 'page2']);
  assert.deepEqual(a.map(m => m.id), ['first', 'new-model', 'lemon-cosmos']);
  assert.deepEqual(a[1].efforts, [{ reasoningEffort: 'high' }]);
  const previous = workspace.models; broken = true;
  await assert.rejects(workspace.readModels(), /catalog unavailable/); assert.equal(workspace.models, previous);
  bridge.request = async () => ({ data: [], nextCursor: 'same-page' });
  await assert.rejects(workspace.readModels(), /分页异常/); assert.equal(workspace.models, previous);
});

test('model catalog refresh throttles, coalesces and discards stale responses without changing the last good list', async () => {
  let clock = 0, calls = 0, resolve, reject, current = ['old'], errors = 0;
  const control = createModelCatalogRefresh({ now: () => clock, load: () => { calls++; return new Promise((ok, fail) => { resolve = ok; reject = fail; }); }, apply: models => { current = models; }, onError: () => { errors++; } });
  control.markLoaded(); await control.refresh(); assert.equal(calls, 0);
  clock = 60_000; const first = control.refresh(), second = control.refresh(); assert.equal(first, second);
  await Promise.resolve(); resolve({ models: ['old', 'new'] }); await first; assert.deepEqual(current, ['old', 'new']);
  clock += 60_000; const stale = control.refresh(); await Promise.resolve();
  control.markLoaded(); resolve({ models: ['stale'] }); await stale; assert.deepEqual(current, ['old', 'new']);
  clock += 60_000; const failed = control.refresh(); await Promise.resolve(); reject(new Error('offline')); await failed;
  assert.equal(errors, 1); assert.deepEqual(current, ['old', 'new']); assert.equal(calls, 3);
});
