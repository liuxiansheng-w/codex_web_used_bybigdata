import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Workspace } from '../lib/workspace.mjs';
import { readHistoryTiming, turnTiming } from '../lib/message-timing.mjs';
import { messageClock, formatDuration, turnDuration, renderMessageTimes } from '../public/message-timing.js';

const start = 1789635363000;
function workspace(t) {
  const bridge = new EventEmitter(), space = new Workspace(bridge, '/project');
  t.after(() => { for (const timer of space.timers.values()) clearTimeout(timer); });
  return { bridge, space, emit(method, params) { space.notification({ method, params: { threadId: 'one', turnId: 'turn-1', ...params } }); } };
}

test('native lifecycle times survive echo, deltas, completion, reimport and late start responses', t => {
  const { space, emit } = workspace(t), thread = space.importThread({ id: 'one', cwd: '/project', turns: [] });
  emit('turn/started', { turn: { id: 'turn-1', startedAt: start / 1000, status: 'inProgress' } });
  const user = { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'request' }] };
  emit('item/started', { item: user, startedAtMs: start + 100 });
  emit('item/completed', { item: user, completedAtMs: start + 500 });
  assert.equal(thread.items[0].timestamp, start + 100);
  emit('item/agentMessage/delta', { itemId: 'a1', delta: 'reply' });
  emit('item/completed', { item: { id: 'a1', type: 'agentMessage', text: 'reply', phase: 'final_answer' }, completedAtMs: start + 46000 });
  emit('turn/completed', { turn: { id: 'turn-1', startedAt: start / 1000, completedAt: start / 1000 + 47, durationMs: 46521, status: 'completed' } });
  space.recordTurn(thread, { id: 'turn-1', status: 'inProgress', startedAt: start / 1000 }, 'response');
  assert.equal(thread.turnTimings[0].durationMs, 46521); assert.equal(thread.turnTimings[0].status, 'completed');
  assert.equal(thread.items[1].timestamp, start + 46000); assert.equal(thread.items[1].phase, 'final_answer');
  const refreshed = space.importThread({ id: 'one', cwd: '/project', turns: [{ id: 'turn-1', status: 'completed', items: [user, { id: 'a1', type: 'agentMessage', text: 'reply' }] }] });
  assert.equal(refreshed.items[0].timestamp, start + 100); assert.equal(refreshed.turnTimings[0].durationMs, 46521);
});

test('history timestamps match message IDs and logs cannot read outside native session storage', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'codex-timing-')); await mkdir(path.join(home, 'sessions')); await mkdir(path.join(home, 'archived_sessions'));
  const filename = path.join(home, 'sessions', 'test.jsonl');
  const record = (type, payload, at = start) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
  const data = [record('session_meta', { id: 'one' }),
    record('event_msg', { type: 'task_started', turn_id: 'turn-1', started_at: start / 1000 }),
    record('response_item', { type: 'message', role: 'user', id: 'u1', content: 'same text' }, start + 100),
    record('response_item', { type: 'message', role: 'user', id: 'u2', content: 'same text' }, start + 9000),
    record('response_item', { type: 'reasoning', id: 'secret', content: 'never return this' }),
    record('response_item', { type: 'message', role: 'assistant', id: 'a1' }, start + 46000),
    record('event_msg', { type: 'item_completed', thread_id: 'one', item: { type: 'UserMessage', id: 'u3' }, started_at_ms: start + 12340, completed_at_ms: start + 12400 }),
    record('event_msg', { type: 'task_complete', turn_id: 'turn-1', started_at: start / 1000, completed_at: start / 1000 + 47, duration_ms: 46521 }), '{partial',
  ].join('\n');
  await writeFile(filename, data);
  const timing = await readHistoryTiming({ id: 'one', path: filename }, home);
  assert.equal(timing.messages.size, 4); assert.equal(timing.messages.get('u2').timestamp, start + 9000); assert.equal(timing.messages.get('u3').timestamp, start + 12340);
  assert.equal(timing.turns.get('turn-1').durationMs, 46521); assert.equal(timing.messages.has('secret'), false);
  const { space } = workspace(t);
  const imported = space.importThread({ id: 'one', cwd: '/project', turns: [{ id: 'turn-1', status: 'completed', items: [
    { id: 'u1', type: 'userMessage' }, { id: 'u2', type: 'userMessage' }, { id: 'a1', type: 'agentMessage' },
  ] }] }, {}, timing);
  assert.deepEqual(imported.items.map(i => i.timestamp), [start + 100, start + 9000, start + 46000]);
  assert.equal((await readHistoryTiming({ id: 'different', path: filename }, home)).messages.size, 0);
  const outside = path.join(home, 'outside.jsonl'); await writeFile(outside, data);
  const linked = path.join(home, 'sessions', 'link.jsonl'); await symlink(outside, linked);
  for (const file of [outside, linked]) assert.equal((await readHistoryTiming({ id: 'one', path: file }, home)).messages.size, 0);
  const archived = path.join(home, 'archived_sessions', 'test.jsonl'); await writeFile(archived, data);
  assert.equal((await readHistoryTiming({ id: 'one', path: archived }, home)).messages.size, 4);
});

test('missing history is not replaced with load time; live estimates freeze on completion or disconnect', t => {
  const { space, bridge, emit } = workspace(t);
  const thread = space.importThread({ id: 'one', cwd: '/project', turns: [{ id: 'old', status: 'completed', items: [{ id: 'old-user', type: 'userMessage' }] }] });
  assert.equal(thread.items[0].timestamp, null); assert.equal(messageClock(thread.items[0]).text, '时间未记录');
  assert.equal(turnTiming({ id: 'unknown' }).durationMs, null);
  emit('turn/started', { turn: { id: 'turn-1', status: 'inProgress', startedAt: start / 1000 } });
  assert.equal(turnDuration(thread, 'turn-1', true, start + 65000).text, '已用时 1 分钟 5 秒');
  assert.equal(turnDuration(thread, 'turn-1', false, start + 999000).text, '耗时待同步');
  bridge.emit('offline', 'lost'); assert.equal(thread.turnTimings.at(-1).completedAt, null);
  emit('turn/completed', { turn: { id: 'turn-1', status: 'interrupted', startedAt: start / 1000, completedAt: start / 1000 + 66, durationMs: 66000 } });
  assert.equal(turnDuration(thread, 'turn-1', true, start + 999000).text, '用时 1 分钟 6 秒 · 已停止');
  const approximate = turnTiming({ id: 'fallback', status: 'inProgress' }, undefined, { startedAt: start });
  assert.equal(approximate.estimated, true); assert.equal(approximate.completedAt, null);
  const native = turnTiming({ id: 'fallback', status: 'completed', startedAt: start / 1000, completedAt: start / 1000 + 2, durationMs: 2000 }, approximate);
  assert.equal(native.estimated, false);
});

test('message clocks show dates across days and only the last reply in each turn gets duration', t => {
  const today = new Date(2026, 8, 17, 17).getTime(), sent = new Date(2026, 8, 17, 16, 56).getTime();
  assert.equal(messageClock({ timestamp: sent }, today).text, '16:56');
  assert.match(messageClock({ timestamp: new Date(2026, 8, 16, 16, 56).getTime() }, today).text, /9月16日/);
  assert.match(messageClock({ timestamp: new Date(2025, 8, 17).getTime() }, today).text, /2025\//);
  assert.equal(formatDuration(246000), '4 分钟 6 秒'); assert.equal(formatDuration(3600000), '1 小时'); assert.equal(formatDuration(0), '不到 1 秒'); assert.equal(formatDuration(-1), null);
  const dom = new JSDOM('<main></main>'), saved = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = saved; dom.window.close(); });
  const thread = { busy: false, items: [{ id: 'u', type: 'userMessage', turnId: 'a', timestamp: sent }, { id: 'progress', type: 'agentMessage', turnId: 'a', timestamp: sent }, { id: 'final', type: 'agentMessage', turnId: 'a', timestamp: sent + 246000 }], turnTimings: [{ id: 'a', status: 'completed', durationMs: 246000 }] };
  const elements = new Map(thread.items.map(item => { const el = document.createElement('article'); el.innerHTML = '<div class="turn-duration" hidden></div><p>unchanged reply</p>'; return [item.id, el]; }));
  renderMessageTimes(thread, elements, true, today);
  const final = elements.get('final'), time = final.querySelector('time'), body = final.querySelector('p');
  assert.equal(elements.get('progress').querySelector('.turn-duration').hidden, true);
  assert.equal(final.querySelector('.turn-duration').textContent, '用时 4 分钟 6 秒'); assert.equal(time.getAttribute('datetime'), new Date(sent + 246000).toISOString());
  renderMessageTimes(thread, elements, true, today + 1000);
  assert.equal(final.querySelector('time'), time); assert.equal(final.querySelector('p'), body); assert.equal(final.querySelectorAll('time').length, 1);
});
