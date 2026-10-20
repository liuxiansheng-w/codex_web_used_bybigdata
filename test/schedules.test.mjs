import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Workbench } from '../lib/workbench.mjs';
import { createSchedules } from '../public/schedules.js';
import { nextScheduleAt, normalizeSchedule, upcomingSchedule, describeSchedule, formatScheduleTime } from '../public/schedule-time.js';

const at = text => Date.parse(`${text}+08:00`), rule = (kind, extra = {}) => ({ kind, time: '09:00', ...extra });
test('calendar rules use Beijing time, strict future dates, Monday-first weeks and missing-month skips', () => {
  assert.equal(nextScheduleAt(rule('daily'), at('2026-10-19T08:59:59')), at('2026-10-19T09:00:00'));
  assert.equal(nextScheduleAt(rule('daily'), at('2026-10-19T09:00:00')), at('2026-10-20T09:00:00'));
  assert.equal(nextScheduleAt(rule('weekly', { days: [1, 2, 3, 4, 5] }), at('2026-10-23T09:00:00')), at('2026-10-26T09:00:00'));
  assert.equal(nextScheduleAt(rule('weekly', { days: [7, 1] }), at('2026-10-24T20:00:00')), at('2026-10-25T09:00:00'));
  assert.equal(nextScheduleAt(rule('monthly', { day: 31 }), at('2026-04-01T00:00:00')), at('2026-05-31T09:00:00'));
  assert.equal(nextScheduleAt(rule('monthly', { day: 29 }), at('2028-02-01T00:00:00')), at('2028-02-29T09:00:00'));
  assert.equal(nextScheduleAt(rule('once', { date: '2026-10-19' }), at('2026-10-19T09:00:00')), null);
  assert.equal(upcomingSchedule(rule('once', { date: '2026-10-20' }), at('2026-10-19T09:00:00')).length, 1);
  assert.equal(upcomingSchedule(rule('daily'), at('2026-12-31T09:00:00'))[0], at('2027-01-01T09:00:00'));
  assert.match(formatScheduleTime(at('2026-10-19T00:05:00')), /2026年10月19日 周一 00:05/);
  assert.equal(describeSchedule(rule('weekly', { days: [5, 1, 3] })), '每周一、周三、周五 09:00');
  assert.equal(describeSchedule({ kind: 'interval', minutes: 1440 }), '每 1 天执行一次');
  for (const invalid of [rule('once', { date: '2026-02-30' }), rule('daily', { time: '24:00' }), rule('weekly', { days: [] }), rule('monthly', { day: 32 }), { kind: 'interval', minutes: 14 }, { kind: 'interval', minutes: 60.5 }, rule('daily', { timeZone: 'America/New_York' })]) assert.throws(() => normalizeSchedule(invalid));
});

async function fixture(t) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'lemon-schedules-')), bridge = Object.assign(new EventEmitter(), { ready: true }), calls = [];
  const workspace = { bridge, threads: new Map(), send: async body => { calls.push(body); const threadId = `scheduled-${calls.length}`; workspace.threads.set(threadId, { busy: true, latestTurnId: 'scheduled-turn' }); return { threadId }; } };
  const desk = new Workbench(workspace, {}, cwd); t.after(() => desk.close());
  const action = body => desk.scheduleAction({ confirmed: true, ...body });
  return { cwd, desk, workspace, bridge, calls, action };
}
test('legacy intervals migrate without changing their frequency, restart paused, and persist with private permissions', async t => {
  const { cwd, desk, action, calls } = await fixture(t);
  await writeFile(path.join(cwd, 'schedules.json'), JSON.stringify([{ id: 'old', cwd, text: '原有任务', minutes: 90, enabled: true, nextAt: Date.now(), history: [] }]));
  const job = (await desk.schedules()).jobs[0]; assert.equal(job.enabled, false); assert.equal(job.pauseReason, 'restart'); assert.equal(job.schedule.minutes, 90);
  await action({ action: 'setEnabled', id: job.id, version: job.version, enabled: true });
  assert.equal(calls.length, 0); assert.equal((await stat(path.join(cwd, 'schedules.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path.join(cwd, 'schedules.json'), 'utf8'))[0].enabled, true);
});
test('create/edit validation, stale versions, archive restoration and failed disk writes preserve task state', async t => {
  const { cwd, desk, action, calls } = await fixture(t);
  await assert.rejects(desk.scheduleAction({ action: 'create', cwd, text: '内容', minutes: 60 }), /确认/);
  await action({ action: 'create', cwd, name: '每日检查', text: '只读检查', schedule: rule('daily') });
  const job = (await desk.schedules()).jobs[0];
  await action({ action: 'update', id: job.id, version: job.version, cwd: '/wrong-project', name: '每周检查', text: '新内容', schedule: rule('weekly', { days: [1, 5] }), enabled: false });
  assert.equal(desk.jobs[0].cwd, job.cwd); assert.equal(desk.jobs[0].enabled, false); assert.equal(calls.length, 0);
  await assert.rejects(action({ action: 'archive', id: job.id, version: job.version }), /其他页面/);
  await action({ action: 'archive', id: job.id }); assert.equal(desk.jobs[0].archived, true);
  await assert.rejects(action({ action: 'run', id: job.id }), /归档/);
  await action({ action: 'restore', id: job.id }); assert.equal(desk.jobs[0].enabled, false); assert.equal(desk.jobs[0].archived, false);
  const previous = structuredClone(desk.jobs);
  t.mock.method(desk, 'persistJobs', async () => { throw Error('disk full'); });
  await assert.rejects(action({ action: 'setEnabled', id: job.id, enabled: true }), /disk full/); assert.deepEqual(desk.jobs, previous);
});
test('manual runs do not move the schedule, use readonly policy, and show only observed completion', async t => {
  const { cwd, desk, action, calls, workspace, bridge } = await fixture(t);
  await action({ action: 'create', cwd, name: '检查', text: '仅读取', schedule: rule('daily') });
  const job = desk.jobs[0], next = job.nextAt;
  await action({ action: 'run', id: job.id }); assert.equal(job.nextAt, next); assert.equal(calls[0].mode, 'read-only'); assert.equal((await desk.schedules()).jobs[0].history[0].status, 'running');
  await assert.rejects(action({ action: 'run', id: job.id }), /尚未完成/);
  await assert.rejects(action({ action: 'update', id: job.id, text: 'change', schedule: rule('daily') }), /结束/);
  await action({ action: 'setEnabled', id: job.id, enabled: false }); assert.equal(workspace.threads.get(job.lastThreadId).busy, true);
  workspace.threads.set(job.lastThreadId, { busy: false, completion: 'completed', latestTurnId: 'scheduled-turn' }); assert.equal((await desk.schedules()).jobs[0].history[0].status, 'completed');
  workspace.threads.set(job.lastThreadId, { busy: false, completion: 'failed', latestTurnId: 'later-user-turn' }); assert.equal((await desk.schedules()).jobs[0].history[0].status, 'submitted', 'a later user turn must not overwrite the scheduled result');
  workspace.threads.clear(); assert.equal((await desk.schedules()).jobs[0].history[0].status, 'submitted');
  bridge.ready = false; await assert.rejects(action({ action: 'run', id: job.id }), /未连接/);
});
test('one-shot runs end automatically, missed recurring periods coalesce, and failed submissions do not retry', async t => {
  const { cwd, desk, action, calls, workspace } = await fixture(t);
  let now = at('2026-10-19T08:00:00'); t.mock.method(Date, 'now', () => now);
  await action({ action: 'create', cwd, text: '一次检查', schedule: rule('once', { date: '2026-10-19' }) });
  now = at('2026-10-19T10:00:00'); await desk.tick(); assert.equal(calls.length, 1); assert.equal(desk.jobs[0].enabled, false); assert.equal(desk.jobs[0].nextAt, null); await desk.tick(); assert.equal(calls.length, 1);
  await assert.rejects(action({ action: 'setEnabled', id: desk.jobs[0].id, enabled: true }), /已过去/);
  await action({ action: 'create', cwd, text: '每小时检查', minutes: 60 }); now += 10 * 3600000;
  workspace.send = async () => { calls.push('failed'); throw Error('模拟连接失败'); };
  await desk.tick(); assert.equal(calls.length, 2); assert.equal(desk.jobs[1].history[0].status, 'failed'); assert.equal(desk.jobs[1].nextAt, now + 3600000);
  await desk.tick(); assert.equal(calls.length, 2);
});
test('pending task creation blocks tick and duplicate writes until persistence completes', async t => {
  const { cwd, desk, action, calls } = await fixture(t);
  let finish; const original = desk.persistJobs.bind(desk); desk.persistJobs = () => new Promise(resolve => { finish = async () => { await original(); resolve(); }; });
  const creating = action({ action: 'create', cwd, text: 'test', minutes: 15 });
  for (let i = 0; i < 100 && !finish; i++) await new Promise(setImmediate);
  assert.ok(finish); desk.jobs[0].nextAt = Date.now() - 1;
  await desk.tick(); assert.equal(calls.length, 0); await assert.rejects(action({ action: 'archive', id: desk.jobs[0].id }), /更新/);
  await finish(); await creating;
});

function ui(t, handler = async () => ({ jobs: [] })) {
  const dom = new JSDOM('<section id="schedules"></section>', { pretendToBeVisual: true }); t.after(() => dom.window.close());
  const root = dom.window.document.querySelector('section'), requests = [], context = { cwd: '/project-a' }, threads = [];
  const controller = createSchedules({ root, api: async (url, body) => { requests.push({ url, body }); return handler(url, body); }, getContext: () => context, onThread: async id => threads.push(id), close() {} }); t.after(() => controller.dispose());
  const $ = id => root.querySelector(`#${id}`), input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const choose = value => { const radio = root.querySelector(`[name=scheduleMode][value=${value === 'once' ? 'once' : 'repeat'}]`); radio.checked = true; if (value !== 'once') $('scheduleCycle').value = value; radio.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  const submit = () => $('scheduleForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  const settle = async check => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(setImmediate); } assert.fail('UI did not settle'); };
  return { root, $, input, choose, submit, settle, requests, controller, context, threads, dom };
}
test('Chinese calendar form previews three executions and preserves failed drafts and their original project', async t => {
  let failing = true;
  const { $, root, input, choose, submit, settle, requests, controller, context } = ui(t, async (url, body) => { if (body && failing) throw Error('保存失败'); return { jobs: [] }; });
  await controller.load(); assert.match($('scheduleResults').textContent, /还没有/); assert.equal($('scheduleForm').hidden, true);
  $('scheduleNew').click(); input('scheduleName', '每周汇总'); input('scheduleText', '读取变更并输出摘要'); choose('weekdays');
  assert.match($('schedulePreview').textContent, /每周一至周五 09:00/); assert.equal($('schedulePreview').querySelectorAll('li').length, 3); assert.match($('scheduleRuleHint').textContent, /节假日/);
  context.cwd = '/project-b'; await controller.load(); assert.equal($('scheduleText').value, '读取变更并输出摘要'); assert.equal(controller.hasDraft(), true);
  submit(); await settle(() => /保存失败/.test($('scheduleNotice').textContent)); assert.equal($('scheduleForm').hidden, false); assert.equal(controller.hasDraft(), true);
  assert.equal(requests.at(-1).body.cwd, '/project-a'); assert.deepEqual(requests.at(-1).body.schedule.days, [1, 2, 3, 4, 5]); assert.equal(requests.at(-1).body.confirmed, true);
  failing = false; $('scheduleEnabled').checked = false; submit(); await settle(() => $('scheduleForm').hidden); assert.equal(controller.hasDraft(), false);
  assert.equal(requests.at(-1).body.enabled, false); assert.equal(root.querySelector('script'), null);
});
test('weekly validation and interval units stay usable; filters, edits, archives and results use explicit task identity', async t => {
  const job = { id: 'job-1', version: 'v1', cwd: '/project-a', name: '<script>example</script>', text: '只读任务', enabled: false, schedule: rule('daily'), nextAt: Date.now() + 86400000, history: [{ at: Date.now(), threadId: 'run-1', status: 'completed' }] };
  const { $, root, choose, input, submit, settle, controller, requests, threads } = ui(t, async (url, body) => { if (body?.action === 'archive') job.archived = true; if (body?.action === 'restore') job.archived = false; return { jobs: [structuredClone(job)] }; });
  await controller.load(); assert.equal(root.querySelector('script'), null); assert.match($('scheduleResults').textContent, /已完成/);
  const card = root.querySelector('.schedule-card'); card.querySelector('details').open = true; await controller.load(); assert.equal(root.querySelector('.schedule-card'), card); assert.equal(card.querySelector('details').open, true, 'unchanged polling keeps reading state and DOM nodes');
  [...root.querySelectorAll('button')].find(el => el.textContent === '查看结果').click(); await settle(() => threads.length); assert.deepEqual(threads, ['run-1']);
  [...root.querySelectorAll('button')].find(el => el.textContent === '编辑').click(); choose('weekly'); for (const el of $('scheduleDays').querySelectorAll('input')) el.checked = false;
  submit(); await settle(() => /至少选择/.test($('scheduleNotice').textContent)); assert.equal(requests.filter(r => r.body).length, 0);
  choose('interval'); input('scheduleIntervalValue', '2'); assert.match($('schedulePreview').textContent, /每 2 小时/); submit(); await settle(() => $('scheduleForm').hidden);
  assert.equal(requests.at(-1).body.schedule.minutes, 120); assert.equal(requests.at(-1).body.version, 'v1'); assert.equal(requests.at(-1).body.action, 'update');
  [...root.querySelectorAll('button')].find(el => el.textContent === '归档').click(); await settle(() => /没有/.test($('scheduleResults').textContent));
  $('scheduleFilter').value = 'archived'; $('scheduleFilter').dispatchEvent(new root.ownerDocument.defaultView.Event('change')); assert.match($('scheduleResults').textContent, /已归档/);
  [...root.querySelectorAll('button')].find(el => el.textContent === '恢复任务').click(); await settle(() => requests.at(-1).body?.action === 'restore');
});

test('effective dates, inclusive end dates, month-end and anchored intervals share precise preview rules', () => {
  assert.equal(nextScheduleAt(rule('daily', { startDate: '2029-01-01' }), at('2026-10-19T10:00:00')), at('2029-01-01T09:00:00'));
  assert.equal(nextScheduleAt(rule('weekly', { days: [1], startDate: '2026-10-20' }), at('2026-10-19T08:00:00')), at('2026-10-26T09:00:00'));
  assert.equal(nextScheduleAt(rule('monthly', { day: 'last' }), at('2028-02-01T00:00:00')), at('2028-02-29T09:00:00'));
  assert.equal(nextScheduleAt(rule('monthly', { day: 'last' }), at('2026-04-01T00:00:00')), at('2026-04-30T09:00:00'));
  assert.deepEqual(upcomingSchedule(rule('daily', { startDate: '2026-10-20', endDate: '2026-10-21' }), at('2026-10-19T10:00:00')), [at('2026-10-20T09:00:00'), at('2026-10-21T09:00:00')]);
  const interval = { kind: 'interval', minutes: 120, startDate: '2026-10-20', time: '09:00' };
  assert.equal(nextScheduleAt(interval, at('2026-10-19T00:00:00')), at('2026-10-20T09:00:00'));
  assert.equal(nextScheduleAt(interval, at('2026-10-20T09:30:00')), at('2026-10-20T11:00:00'));
  assert.equal(nextScheduleAt(interval, at('2026-10-20T13:15:00')), at('2026-10-20T15:00:00'));
  assert.equal(upcomingSchedule({ ...interval, maxRuns: 3 }, at('2026-10-20T09:30:00'), 3, 2).length, 1);
  assert.equal(nextScheduleAt({ ...interval, maxRuns: 3 }, at('2026-10-20T09:30:00'), 3), null);
  for (const invalid of [rule('daily', { startDate: '2026-02-30' }), rule('daily', { startDate: '2026-10-22', endDate: '2026-10-21' }), { ...interval, endDate: '2026-10-19' }, rule('daily', { maxRuns: 0 }), rule('daily', { maxRuns: 1.1 }), rule('daily', { maxRuns: 2, endDate: '2026-10-22' })]) assert.throws(() => normalizeSchedule(invalid));
});
test('editing content, redundant enable, pause and resume preserve the original interval grid', async t => {
  const { cwd, desk, action, calls } = await fixture(t); let now = at('2026-10-20T08:00:00'); t.mock.method(Date, 'now', () => now);
  await action({ action: 'create', cwd, text: '原任务', schedule: { kind: 'interval', minutes: 120, startDate: '2026-10-20', time: '09:00' } });
  const job = desk.jobs[0], anchorAt = job.schedule.anchorAt; now = at('2026-10-20T08:30:00');
  await action({ action: 'update', id: job.id, name: '新名称', text: '新内容', schedule: job.schedule }); assert.equal(job.nextAt, anchorAt); assert.equal(job.scheduleRuns, 0);
  await action({ action: 'setEnabled', id: job.id, enabled: true }); assert.equal(job.nextAt, anchorAt);
  await action({ action: 'setEnabled', id: job.id, enabled: false }); now = at('2026-10-20T09:30:00');
  await action({ action: 'setEnabled', id: job.id, enabled: true }); assert.equal(job.nextAt, at('2026-10-20T11:00:00')); assert.equal(job.schedule.anchorAt, anchorAt);
  now = at('2026-10-20T11:15:00'); await action({ action: 'update', id: job.id, name: '第二次改名', text: '只改内容' }); assert.equal(job.nextAt, at('2026-10-20T11:00:00'), 'overdue work must remain due after text edits');
  await desk.tick(); assert.equal(calls.length, 1); assert.equal(job.nextAt, at('2026-10-20T13:00:00'));
});
test('automatic trigger counts survive edits and restart, exclude manual runs, and finish even on submission failure', async t => {
  const { cwd, desk, action, workspace, calls } = await fixture(t); let now = at('2026-10-20T08:00:00'); t.mock.method(Date, 'now', () => now);
  await action({ action: 'create', cwd, text: '检查', schedule: rule('daily', { startDate: '2026-10-20', maxRuns: 2 }) }); const job = desk.jobs[0];
  await action({ action: 'run', id: job.id }); assert.equal(job.scheduleRuns, 0); assert.equal(job.history[0].automatic, false); workspace.threads.clear();
  now = at('2026-10-20T09:00:00'); await desk.tick(); assert.equal(job.scheduleRuns, 1); assert.equal(job.history[0].automatic, true); workspace.threads.clear();
  await action({ action: 'update', id: job.id, name: '改名', text: '检查', schedule: job.schedule }); assert.equal(job.scheduleRuns, 1);
  const restarted = new Workbench(workspace, {}, cwd); t.after(() => restarted.close()); await restarted.schedules(); assert.equal(restarted.jobs[0].scheduleRuns, 1); assert.equal(restarted.jobs[0].enabled, false);
  now = at('2026-10-21T09:00:00'); workspace.send = async () => { calls.push('failed'); throw Error('模拟失败'); }; await desk.tick(); assert.equal(job.scheduleRuns, 2); assert.equal(job.enabled, false); assert.equal(job.pauseReason, 'finished'); assert.equal(job.nextAt, null); assert.equal(job.history[0].status, 'failed');
  await assert.rejects(action({ action: 'setEnabled', id: job.id, enabled: true }), /结束条件/);
  const finished = desk.jobs[0]; await action({ action: 'update', id: finished.id, name: '结束后改名', text: '检查', schedule: finished.schedule, enabled: false }); assert.equal(desk.jobs[0].scheduleRuns, 2); assert.equal(desk.jobs[0].pauseReason, 'finished');
  await action({ action: 'update', id: finished.id, text: '新计划', schedule: rule('daily', { startDate: '2026-10-22', maxRuns: 3 }), enabled: true }); assert.equal(desk.jobs[0].scheduleRuns, 0); assert.equal(desk.jobs[0].nextAt, at('2026-10-22T09:00:00'));
});
test('expired recurring schedules never submit missed work after the inclusive end date', async t => {
  const { cwd, desk, action, calls } = await fixture(t); let now = at('2026-10-20T08:00:00'); t.mock.method(Date, 'now', () => now);
  await action({ action: 'create', cwd, text: '检查', schedule: rule('daily', { endDate: '2026-10-20' }) }); now = at('2026-10-21T00:00:00'); await desk.tick();
  assert.equal(calls.length, 0); assert.equal(desk.jobs[0].enabled, false); assert.equal(desk.jobs[0].pauseReason, 'finished'); assert.equal(desk.jobs[0].scheduleRuns, 0);
});
test('Chinese date picker uses Monday-first dates, keyboard navigation, leap days and independent end fields', async t => {
  const { $, root, input, choose, dom, controller } = ui(t); $('scheduleNew').click();
  assert.equal($('scheduleDateCalendar').hidden, true); assert.equal(controller.hasDraft(), false);
  input('scheduleDate', '2028-02-28'); $('scheduleDate').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal($('scheduleDateCalendar').hidden, false); assert.deepEqual([...$('scheduleDateCalendar').querySelectorAll('[role=columnheader]')].map(el => el.textContent), [...'一二三四五六日']);
  assert.equal(dom.window.document.activeElement.dataset.date, '2028-02-28'); dom.window.document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); assert.equal(dom.window.document.activeElement.dataset.date, '2028-02-29'); dom.window.document.activeElement.click(); assert.equal($('scheduleDate').value, '2028-02-29'); assert.equal($('scheduleDateCalendar').hidden, true);
  choose('monthly'); input('scheduleMonthDay', 'last'); assert.match($('schedulePreview').textContent, /每月最后一天/);
  input('scheduleEnd', 'date'); input('scheduleEndDate', '2028-03-31'); $('scheduleEndDate').click(); assert.equal($('scheduleEndDateCalendar').hidden, false); $('scheduleName').focus(); assert.equal($('scheduleEndDateCalendar').hidden, true);
  choose('once'); assert.equal($('scheduleCycleRow').hidden, true); assert.equal($('scheduleEndRow').hidden, true); assert.equal($('scheduleEndDate').disabled, true); assert.equal($('scheduleDate').getAttribute('aria-label'), '执行日期');
  choose('weekly'); input('scheduleEnd', 'count'); input('scheduleMaxRuns', '1'); assert.equal($('schedulePreview').querySelector('details'), null); assert.match($('scheduleRuleHint').textContent, /立即运行不计入/); assert.equal(root.querySelectorAll('[name=scheduleMode]').length, 2);
});
test('saving an unchanged legacy interval from the form preserves seconds, counters and its original anchor', async t => {
  const schedule = normalizeSchedule({ kind: 'interval', minutes: 120, anchorAt: at('2026-10-20T09:00:27'), maxRuns: 8 });
  const job = { id: 'legacy', version: 'v1', cwd: '/project-a', name: '原名称', text: '任务', enabled: false, schedule, scheduleRuns: 3, history: [] };
  const { root, $, input, controller, submit, settle, requests } = ui(t, async () => ({ jobs: [job] })); await controller.load(); [...root.querySelectorAll('button')].find(el => el.textContent === '编辑').click();
  input('scheduleName', '新名称'); assert.match($('schedulePreview').textContent, /3 \/ 8/); submit(); await settle(() => $('scheduleForm').hidden); assert.deepEqual(requests.at(-1).body.schedule, schedule);
});
