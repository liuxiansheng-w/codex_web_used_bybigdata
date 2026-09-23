import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import XLSX from 'xlsx';
import { createPatch } from 'diff';
import { ProjectFiles } from '../lib/project-files.mjs';
import { FileTools } from '../lib/file-tools.mjs';
import { FileHistory } from '../lib/file-history.mjs';
import { Workbench } from '../lib/workbench.mjs';
import { Workspace } from '../lib/workspace.mjs';
import { Subagents } from '../lib/subagents.mjs';
import { SpreadsheetPreview } from '../lib/spreadsheet-preview.mjs';
import { previewWorkbook } from '../lib/spreadsheet-worker.mjs';

async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-features-'))), files = new ProjectFiles(), tools = new FileTools(files, { trash: path.join(cwd, 'trash') });
  const workspace = { threads: new Map(), get: async id => workspace.threads.get(id) }, history = new FileHistory(files, tools, workspace, path.join(cwd, 'state'));
  return { cwd, files, tools, workspace, history };
}
test('saved versions survive restart; restore preserves CRLF/BOM and can itself be undone', async () => {
  const { cwd, files, tools, workspace, history } = await fixture(); await writeFile(path.join(cwd, 'example.txt'), '\uFEFFold\r\n');
  await files.save({ ...await files.read({ cwd, path: 'example.txt' }), content: 'new\n' });
  const restarted = new FileHistory(files, tools, workspace, path.join(cwd, 'state'));
  const { versions } = await restarted.list({ cwd, path: 'example.txt' }); assert.equal(versions.length, 1);
  const preview = await restarted.preview({ cwd, path: 'example.txt', source: 'history', revisionId: versions[0].id });
  assert.match(preview.diff, /-new\n\+old/); assert.equal(await readFile(path.join(cwd, 'example.txt'), 'utf8'), '\uFEFFnew\r\n');
  await assert.rejects(restarted.apply({ id: preview.id }), /确认/);
  await restarted.apply({ id: preview.id, confirmed: true });
  assert.equal(await readFile(path.join(cwd, 'example.txt'), 'utf8'), '\uFEFFold\r\n');
  await assert.rejects(restarted.apply({ id: preview.id, confirmed: true }), /过期/);
  const undo = await restarted.list({ cwd, path: 'example.txt' });
  const revert = await restarted.preview({ cwd, path: 'example.txt', source: 'history', revisionId: undo.versions[0].id });
  await restarted.apply({ id: revert.id, confirmed: true }); assert.equal((await files.read({ cwd, path: 'example.txt' })).content, 'new\n');
});
test('restore refuses external edits, in-flight tasks, symlinks, and revisions from another file', async () => {
  const { cwd, files, workspace, history } = await fixture(); await writeFile(path.join(cwd, 'a.txt'), 'one\n'); await writeFile(path.join(cwd, 'b.txt'), 'other');
  await files.save({ ...await files.read({ cwd, path: 'a.txt' }), content: 'two\n' });
  const revisionId = (await history.list({ cwd, path: 'a.txt' })).versions[0].id;
  const input = { cwd, path: 'a.txt', source: 'history', revisionId }, preview = await history.preview(input);
  await writeFile(path.join(cwd, 'a.txt'), 'external\n');
  await assert.rejects(history.apply({ id: preview.id, confirmed: true }), /已变化/); assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'external\n');
  await assert.rejects(history.preview({ ...input, path: 'b.txt' }), /过期/);
  await symlink(path.join(cwd, 'a.txt'), path.join(cwd, 'link.txt')); await assert.rejects(history.list({ cwd, path: 'link.txt' }), /符号链接/);
  await assert.rejects(history.list({ cwd, path: '../a.txt' }), /之外/);
  workspace.threads.set('busy', { cwd, busy: true }); await assert.rejects(history.preview(input), /任务/);
});
test('AI patch reversal requires recorded positions; creation goes to Trash and deletion can be restored', async () => {
  const { cwd, files, workspace, history } = await fixture();
  const item = { id: 'edit', type: 'fileChange', status: 'completed', changes: [] };
  workspace.threads.set('root', { id: 'root', cwd, items: [item] });
  const input = { cwd, path: 'a.txt', source: 'ai', threadId: 'root', itemId: 'edit' };
  item.changes = [{ path: 'a.txt', kind: 'update', diff: createPatch('a.txt', 'before\ncontext\n', 'after\ncontext\n') }];
  await writeFile(path.join(cwd, 'a.txt'), 'after\ncontext\n');
  let preview = await history.preview(input); await history.apply({ id: preview.id, confirmed: true }); assert.equal((await files.read(input)).content, 'before\ncontext\n');
  await writeFile(path.join(cwd, 'a.txt'), 'prefix\nafter\ncontext\n'); await assert.rejects(history.preview(input), /不再匹配/);
  item.changes = [{ path: 'new.txt', kind: 'add', diff: createPatch('new.txt', '', 'created\n') }]; await writeFile(path.join(cwd, 'new.txt'), 'created\n');
  preview = await history.preview({ ...input, path: 'new.txt' }); const removed = await history.apply({ id: preview.id, confirmed: true });
  assert.equal(await readFile(removed.recovery, 'utf8'), 'created\n'); await assert.rejects(files.read({ cwd, path: 'new.txt' }), /删除/);
  item.changes = [{ path: 'deleted.txt', kind: 'delete', diff: createPatch('deleted.txt', 'recovered\n', '') }];
  preview = await history.preview({ ...input, path: 'deleted.txt' }); await history.apply({ id: preview.id, confirmed: true }); assert.equal((await files.read({ cwd, path: 'deleted.txt' })).content, 'recovered\n');
});
test('Excel previews preserve sheet names, formatted values and reject stale workbook versions', async t => {
  const { cwd, files } = await fixture(), bridge = new EventEmitter(), desk = new Workbench({ bridge }, files, path.join(cwd, 'state')), preview = new SpreadsheetPreview(desk);
  t.after(() => { desk.close(); preview.close(); });
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['名称', '值'], ['<script>alert(1)</script>', 25]]), '第一页');
  const second = XLSX.utils.aoa_to_sheet([['指标'], [0.125]]); second.A2.z = '0.0%'; XLSX.utils.book_append_sheet(book, second, '比例');
  await writeFile(path.join(cwd, 'sample.xlsx'), XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }));
  const result = await preview.read({ cwd, path: 'sample.xlsx' }); assert.deepEqual(result.sheets, ['第一页', '比例']); assert.equal(result.rows[1][0], '<script>alert(1)</script>');
  const other = await preview.read({ cwd, path: 'sample.xlsx', sheet: 1, version: result.version }); assert.equal(other.rows[1][0], '12.5%');
  await assert.rejects(preview.read({ cwd, path: 'sample.xlsx', sheet: 9 }), /不存在/);
  await writeFile(path.join(cwd, 'sample.xlsx'), XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: false }));
  await assert.rejects(preview.read({ cwd, path: 'sample.xlsx', version: result.version }), /已更新/);
  assert.equal(previewWorkbook(XLSX.write(book, { type: 'buffer', bookType: 'xls' }), 1).rows[1][0], '12.5%');
  const many = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(many, XLSX.utils.aoa_to_sheet(Array.from({ length: 2100 }, (_, i) => [i])), 'Large');
  const limited = previewWorkbook(XLSX.write(many, { type: 'buffer', bookType: 'xlsx' })); assert.equal(limited.rows.length, 2000); assert.equal(limited.totalRows, 2100); assert.equal(limited.limited, true);
});
test('explicit AIdata Excel exports preview without exposing ignored folders to search, writes or symlink traversal', async t => {
  const { cwd, files, tools } = await fixture(), bridge = new EventEmitter();
  const desk = new Workbench({ bridge }, files, path.join(cwd, 'state')), preview = new SpreadsheetPreview(desk);
  t.after(() => { desk.close(); preview.close(); });
  await mkdir(path.join(cwd, 'AIdata', 'run', 'multi'), { recursive: true });
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['value'], [42]]), 'Result');
  for (const extension of ['xlsx', 'xls', 'xlsm']) {
    const relative = `AIdata/run/multi/result.${extension}`;
    await writeFile(path.join(cwd, relative), XLSX.write(book, { type: 'buffer', bookType: extension }));
    const artifact = await desk.artifact({ cwd, path: relative }); assert.equal(artifact.extension, '.' + extension);
    assert.equal((await desk.artifact({ cwd, path: relative, stamp: artifact.stamp })).unchanged, true);
    const parsed = await preview.read({ cwd, path: relative, version: artifact.version }); assert.equal(parsed.rows[1][0], '42');
    await assert.rejects(files.read({ cwd, path: relative }), { status: 403 });
    await assert.rejects(files.save({ cwd, path: relative, content: 'overwrite', version: artifact.version }), { status: 403 });
  }
  assert.ok(!(await files.list({ cwd })).entries.some(entry => entry.name === 'AIdata'));
  await assert.rejects(files.list({ cwd, path: 'AIdata/run' }), { status: 403 });
  assert.equal((await tools.search({ cwd, query: 'result', filenames: true })).results.length, 0);
  await symlink(path.join(cwd, 'AIdata/run/multi/result.xlsx'), path.join(cwd, 'AIdata/run/multi/link.xlsx'));
  for (const relative of ['AIdata/run/multi/link.xlsx', 'AIdata/.private/result.xlsx', 'AIdata/node_modules/result.xlsx', 'AIdata/run/../multi/result.xlsx', 'AIdata/run/result.txt', '待删除/result.xlsx', '../result.xlsx']) {
    await assert.rejects(desk.artifact({ cwd, path: relative, allowExportPreview: true }), { status: 403 });
  }
});

class AgentBridge extends EventEmitter {
  ready = true; threads = new Map(); calls = [];
  async request(method, params) { this.calls.push({ method, params }); if (method === 'thread/read') { const thread = this.threads.get(params.threadId); if (!thread) throw new Error('not found'); return { thread }; } return {}; }
}
test('subtask panel reflects nested native agents, real status, and only interrupts a live descendant turn', async () => {
  const bridge = new AgentBridge(), workspace = new Workspace(bridge, '/private/tmp'), tracker = new Subagents(workspace);
  const spawn = (sender, id) => ({ id: `spawn-${id}`, type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: sender, receiverThreadIds: [id], prompt: 'bounded task', agentsStates: { [id]: { status: 'running' } } });
  const raw = { id: 'root', cwd: '/private/tmp', turns: [{ id: 'root-turn', status: 'completed', items: [spawn('root', 'child'), spawn('root', 'missing')] }] }; workspace.importThread(raw);
  bridge.threads.set('child', { id: 'child', parentThreadId: 'root', agentNickname: '检查器', agentRole: 'reviewer', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns: [{ id: 'turn-child', status: 'inProgress', items: [spawn('child', 'grandchild')] }] });
  bridge.threads.set('grandchild', { id: 'grandchild', parentThreadId: 'child', status: { type: 'idle' }, turns: [{ id: 'done', status: 'completed', items: [{ type: 'agentMessage', text: 'all good' }] }] });
  let result = await tracker.list('root'); assert.equal(result.agents.length, 3); assert.equal(result.agents[0].status, 'waiting'); assert.equal(result.agents[1].status, 'unknown'); assert.equal(result.agents[2].message, 'all good'); assert.equal(result.agents[2].depth, 2);
  assert.equal(workspace.threads.get('root').items[0].type, 'collabAgentToolCall');
  await assert.rejects(tracker.interrupt('root', { childId: 'sibling' }), /不属于/);
  await tracker.interrupt('root', { childId: 'child' }); assert.deepEqual(bridge.calls.filter(call => call.method === 'turn/interrupt').map(call => call.params), [{ threadId: 'child', turnId: 'turn-child' }]);
  bridge.threads.get('child').turns[0].status = 'completed'; bridge.threads.get('child').status.type = 'idle';
  await assert.rejects(tracker.interrupt('root', { childId: 'child' }), /不属于/);
  workspace.importThread({ ...bridge.threads.get('child'), turns: [{ id: 'old-turn', status: 'inProgress', items: [] }] });
  const refreshed = await workspace.get('child'); assert.equal(refreshed.busy, false); assert.equal(refreshed.latestTurnId, 'turn-child', 'opening a child driven by its parent refreshes stale history without resuming it');
  assert.equal(bridge.calls.some(call => /start|resume|spawn/.test(call.method)), false, 'opening panel never creates or resumes AI tasks');
});

test('reused subtask reports its current assignment and never shows an earlier answer as current progress', async () => {
  const bridge = new AgentBridge(), workspace = new Workspace(bridge, '/private/tmp'), tracker = new Subagents(workspace);
  workspace.importThread({ id: 'root', cwd: '/private/tmp', turns: [{ id: 'first', status: 'completed', items: [{ id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'root', receiverThreadIds: ['child'], prompt: '旧任务', agentsStates: { child: { status: 'completed', message: '旧结果' } } }] }, { id: 'next', status: 'inProgress', items: [{ id: 'followup', type: 'collabAgentToolCall', tool: 'sendInput', senderThreadId: 'root', receiverThreadIds: ['child'], prompt: '新任务', agentsStates: { child: { status: 'running' } } }] }] });
  const raw = { id: 'child', parentThreadId: 'root', status: { type: 'active' }, turns: [{ id: 'old', status: 'completed', items: [{ type: 'agentMessage', text: '旧结果' }] }, { id: 'new', status: 'inProgress', items: [{ type: 'commandExecution', status: 'inProgress' }] }] }; bridge.threads.set('child', raw);
  let [agent] = (await tracker.list('root')).agents;
  assert.equal(agent.prompt, '新任务'); assert.equal(agent.message, ''); assert.equal(agent.activity, '正在执行命令'); assert.equal(agent.status, 'running');
  raw.turns[1].items.push({ type: 'agentMessage', text: '新'.repeat(5100) });
  [agent] = (await tracker.list('root')).agents;
  assert.equal(agent.message.length, 5000); assert.equal(agent.messageTruncated, true);
});
