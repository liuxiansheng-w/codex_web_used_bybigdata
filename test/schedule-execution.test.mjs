import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../lib/workspace.mjs';
import { Workbench } from '../lib/workbench.mjs';
import { ThreadOrganization } from '../lib/thread-organization.mjs';

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-schedule-execution-')));
  const bridge = Object.assign(new EventEmitter(), { ready: true, calls: [], count: 0, requirements: null });
  bridge.request = async (method, params) => {
    bridge.calls.push({ method, params });
    if (method === 'configRequirements/read') return { requirements: bridge.requirements };
    if (method === 'model/list') return { data: [{ model: 'fixture-model', displayName: '虚构模型', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'low' }] }] };
    if (method === 'thread/start') { await bridge.onStart?.(); return { thread: { id: `scheduled-${++bridge.count}`, cwd, turns: [] }, model: params.model || 'fixture-model' }; }
    if (method === 'turn/start') { await bridge.onTurn?.(params); return { turn: { id: `turn-${bridge.count}` } }; }
    return {};
  };
  const workspace = new Workspace(bridge, cwd);
  const organization = new ThreadOrganization(cwd, { verifyThread: async (id, project) => workspace.threads.get(id)?.cwd === project });
  const desk = new Workbench(workspace, {}, cwd, { threadOrganization: organization });
  t.after(() => { desk.close(); bridge.ready = false; for (const timer of workspace.timers.values()) clearTimeout(timer); });
  const action = body => desk.scheduleAction({ confirmed: true, ...body });
  return { cwd, bridge, workspace, organization, desk, action };
}

test('scheduled native turns use saved model, effort and permissions after placing the thread in its folder', async t => {
  const { cwd, bridge, organization, workspace, desk, action } = await fixture(t);
  const folders = await organization.action({ cwd, revision: 0, action: 'create-folder', name: '自动汇总' }), folderId = folders.folders[0].id;
  const options = await desk.scheduleOptions(cwd); assert.equal(options.models[0].id, 'fixture-model'); assert.equal(options.folders[0].id, folderId);
  await action({ action: 'create', cwd, name: '测试', text: '虚构任务', minutes: 60, model: 'fixture-model', effort: 'high', folderId });
  const job = desk.jobs[0], nextAt = job.nextAt; assert.equal(job.mode, 'auto-review');
  await action({ action: 'update', id: job.id, text: job.text, effort: 'low' }); assert.equal(job.nextAt, nextAt);
  bridge.onTurn = async params => { const value = await organization.list(cwd); assert.equal(value.threads.find(thread => thread.id === params.threadId).folderId, folderId); };
  await action({ action: 'run', id: job.id });
  const start = bridge.calls.find(call => call.method === 'thread/start').params, turn = bridge.calls.find(call => call.method === 'turn/start').params;
  assert.equal(start.model, 'fixture-model'); assert.equal(start.approvalsReviewer, 'auto_review'); assert.equal(turn.model, 'fixture-model'); assert.equal(turn.effort, 'low'); assert.equal(turn.sandboxPolicy.type, 'workspaceWrite'); assert.equal(turn.approvalPolicy, 'on-request'); assert.equal(turn.approvalsReviewer, 'auto_review');
  assert.equal(job.nextAt, nextAt); assert.equal(job.history[0].turnId, 'turn-1'); assert.equal(job.history[0].status, 'submitted');
  assert.equal((await desk.schedules()).jobs[0].folderName, '自动汇总');
  const saved = JSON.parse(await readFile(path.join(cwd, 'schedules.json'), 'utf8'))[0]; assert.equal(saved.effort, 'low'); assert.equal(saved.folderId, folderId);
  const restarted = new Workbench(workspace, {}, cwd, { threadOrganization: organization }); t.after(() => restarted.close());
  const restored = (await restarted.schedules()).jobs[0]; assert.equal(restored.enabled, false); assert.equal(restored.mode, 'auto-review'); assert.equal(restored.folderId, folderId); assert.equal(restored.model, 'fixture-model');
});

test('full access requires explicit task consent and is passed to the native runtime without a sandbox', async t => {
  const { cwd, bridge, desk, action } = await fixture(t), body = { action: 'create', cwd, text: '虚构任务', minutes: 60, mode: 'danger-full-access' };
  await assert.rejects(action(body), /确认完全访问/); assert.equal(desk.jobs.length, 0);
  await action({ ...body, fullAccessConfirmed: true }); const job = desk.jobs[0];
  await action({ action: 'update', id: job.id, text: '改名后的虚构任务' }); assert.equal(job.fullAccessConfirmed, true);
  await action({ action: 'run', id: job.id });
  const turn = bridge.calls.find(call => call.method === 'turn/start').params;
  assert.equal(turn.sandboxPolicy.type, 'dangerFullAccess'); assert.equal(turn.approvalPolicy, 'never');
});

test('invalid or retired model/effort, changed runtime policy and removed folders fail before inference', async t => {
  const { cwd, bridge, workspace, organization, desk, action } = await fixture(t);
  const base = { action: 'create', cwd, text: '虚构任务', minutes: 60 };
  await assert.rejects(action({ ...base, model: 'missing-model' }), /模型已不可用/);
  await assert.rejects(action({ ...base, model: 'fixture-model', effort: 'ultra' }), /不支持/);
  await assert.rejects(action({ ...base, folderId: 'foreign-folder' }), /文件夹已不存在/);
  const folders = await organization.action({ cwd, revision: 0, action: 'create-folder', name: '临时分组' }), folderId = folders.folders[0].id;
  await action({ ...base, folderId }); const job = desk.jobs[0];
  await organization.action({ cwd, revision: folders.revision, action: 'remove-folder', folderId });
  await action({ action: 'run', id: job.id }); assert.match(job.history[0].error, /文件夹已不存在/);
  await action({ action: 'update', id: job.id, text: job.text, folderId: null });
  bridge.requirements = { allowedApprovalsReviewers: ['user'] }; workspace.permissions.cached = null;
  await action({ action: 'run', id: job.id }); assert.match(job.history[0].error, /组织策略/);
  assert.equal(bridge.calls.filter(call => ['thread/start', 'turn/start'].includes(call.method)).length, 0);
});

test('a folder removed during thread creation prevents the first turn and retains the created thread link', async t => {
  const { cwd, bridge, organization, desk, action } = await fixture(t);
  const value = await organization.action({ cwd, revision: 0, action: 'create-folder', name: '可能移除的分组' }), folderId = value.folders[0].id;
  await action({ action: 'create', cwd, text: '虚构任务', minutes: 60, folderId }); const job = desk.jobs[0];
  bridge.onStart = async () => organization.action({ cwd, revision: value.revision, action: 'remove-folder', folderId });
  await action({ action: 'run', id: job.id }); assert.equal(job.history[0].status, 'failed'); assert.equal(job.history[0].threadId, 'scheduled-1'); assert.match(job.history[0].error, /文件夹已不存在/);
  assert.equal(bridge.calls.filter(call => call.method === 'turn/start').length, 0);
});
