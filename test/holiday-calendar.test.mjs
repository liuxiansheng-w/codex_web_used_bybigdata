import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUNDLED_CALENDAR, workdayStatus } from '../public/holiday-calendar.js';
import { nextScheduleAt, upcomingSchedule } from '../public/schedule-time.js';
import { HolidayCalendar } from '../lib/holiday-calendar.mjs';

const at = value => Date.parse(`${value}+08:00`);
const rule = { kind: 'workday', time: '09:00' };
const fixture2027 = {
  year: 2027, papers: ['https://www.gov.cn/fixture'], days: [
    { name: '元旦', date: '2026-12-31', isOffDay: true },
    { name: '元旦', date: '2027-01-01', isOffDay: true },
    { name: '春节', date: '2027-02-08', isOffDay: true },
    { name: '清明', date: '2027-04-05', isOffDay: true },
    { name: '劳动', date: '2027-05-01', isOffDay: true },
    { name: '端午', date: '2027-06-09', isOffDay: true },
    { name: '中秋', date: '2027-09-15', isOffDay: true },
    { name: '国庆', date: '2027-10-01', isOffDay: true },
    { name: '春节', date: '2027-02-06', isOffDay: false },
  ],
}; // Synthetic dates exercise the protocol only; not a 2027 holiday notice.

test('national workdays include makeup weekends and exclude holidays while weekday schedules stay unchanged', () => {
  assert.equal(workdayStatus('2026-09-20'), true);
  assert.equal(workdayStatus('2026-09-25'), false);
  assert.equal(workdayStatus('2026-10-10'), true);
  assert.equal(workdayStatus('2026-10-11'), false);
  assert.equal(nextScheduleAt(rule, at('2026-09-19T09:00:00')), at('2026-09-20T09:00:00'));
  assert.equal(nextScheduleAt(rule, at('2026-09-30T09:00:00')), at('2026-10-08T09:00:00'));
  assert.equal(nextScheduleAt(rule, at('2026-10-09T09:00:00')), at('2026-10-10T09:00:00'));
  assert.equal(nextScheduleAt({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, at('2026-09-19T09:00:00')), at('2026-09-21T09:00:00'));
  assert.throws(() => workdayStatus('2026-12-31'), /日历|节假日/);
  assert.throws(() => workdayStatus('2027-01-01'), /日历|节假日/);
  const partial = upcomingSchedule(rule, at('2026-12-17T09:00:00'), 3);
  assert.deepEqual([...partial], [at('2026-12-18T09:00:00')]); assert.equal(partial.calendarIncomplete, true);
  const future = { years: { ...BUNDLED_CALENDAR.years, 2027: fixture2027 } };
  assert.equal(workdayStatus('2026-12-31', future), false);
  assert.equal(workdayStatus('2027-02-06', future), true);
});

test('calendar refresh caches a structurally complete, sourced year and rejects incomplete updates', async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-holiday-')));
  let valid = true;
  const fetchImpl = async url => {
    if (url.endsWith('/2026.json')) throw Error('offline');
    const data = valid ? fixture2027 : { ...fixture2027, days: fixture2027.days.slice(0, 1) };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const source = new HolidayCalendar(cwd, { fetchImpl });
  const first = await source.refresh({ force: true, at: at('2026-10-30T08:00:00') });
  assert.ok(first.years[2026]); assert.ok(first.years[2027]); assert.match(first.warning, /部分年度/);
  assert.equal(workdayStatus('2026-12-31', first), false);
  assert.ok(JSON.parse(await readFile(path.join(cwd, 'holiday-calendar.json'), 'utf8')).years[2027]);
  valid = false; const second = await source.refresh({ force: true, at: at('2026-10-30T08:00:00') });
  assert.equal(workdayStatus('2027-02-06', second), true, 'invalid data must not replace the last known calendar');
  const restarted = new HolidayCalendar(cwd, { fetchImpl }); await restarted.load();
  assert.equal(workdayStatus('2026-12-31', restarted.snapshot()), false);
});
