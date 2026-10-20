// Shared by the browser preview and the local scheduler. All calendar rules use Beijing time.
export const SCHEDULE_ZONE = 'Asia/Shanghai';
const OFFSET = 8 * 60 * 60 * 1000, DAY = 24 * 60 * 60 * 1000;
const assert = (value, message) => { if (!value) throw Object.assign(new Error(message), { status: 400 }); };
const pad = value => String(value).padStart(2, '0');
export function beijingDate(at = Date.now()) { return new Date(at + OFFSET).toISOString().slice(0, 10); }
export function beijingTime(at = Date.now()) { return new Date(at + OFFSET).toISOString().slice(11, 16); }
function dateAt(value, label) {
  assert(typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value), `请填写有效的${label}（YYYY-MM-DD）。`);
  const at = Date.parse(`${value}T00:00:00+08:00`);
  assert(Number.isFinite(at) && beijingDate(at) === value, `${label}不存在，请重新选择。`);
  return at;
}
export function normalizeSchedule(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), '请选择执行频率。');
  assert(value.timeZone === undefined || value.timeZone === SCHEDULE_ZONE, '执行时间统一使用北京时间。');
  const { kind } = value, result = { kind, timeZone: SCHEDULE_ZONE };
  assert(['once', 'daily', 'weekly', 'monthly', 'interval'].includes(kind), '执行频率无效。');
  if (kind !== 'once') {
    assert(!(value.endDate && value.maxRuns != null), '请选择一种结束条件。');
    if (value.startDate && kind !== 'interval') { dateAt(value.startDate, '生效日期'); result.startDate = value.startDate; }
    if (value.endDate) { dateAt(value.endDate, '结束日期'); result.endDate = value.endDate; }
    if (value.maxRuns != null) { assert(Number.isInteger(value.maxRuns) && value.maxRuns >= 1 && value.maxRuns <= 10000, '执行次数须为 1 至 10,000 次。'); result.maxRuns = value.maxRuns; }
  }
  if (kind === 'interval') {
    assert(Number.isInteger(value.minutes) && value.minutes >= 15 && value.minutes <= 43200, '执行间隔须为 15 分钟至 30 天。');
    if (value.anchorAt != null) { assert(Number.isSafeInteger(value.anchorAt) && value.anchorAt >= dateAt('2000-01-01', '生效日期') && value.anchorAt < dateAt('2099-12-31', '生效日期') + DAY, '首次执行时间无效。'); result.anchorAt = value.anchorAt; }
    else if (value.startDate) {
      dateAt(value.startDate, '生效日期');
      assert(typeof value.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time), '请填写有效的执行时间（24 小时制）。');
      result.anchorAt = Date.parse(`${value.startDate}T${value.time}:00+08:00`);
    }
    assert(!result.endDate || result.anchorAt == null || dateAt(result.endDate, '结束日期') + DAY > result.anchorAt, '结束日期不能早于生效日期。');
    return { ...result, minutes: value.minutes };
  }
  assert(typeof value.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time), '请选择有效的执行时间（24 小时制）。');
  result.time = value.time;
  if (kind === 'once') {
    dateAt(value.date, '执行日期');
    result.date = value.date;
  }
  if (kind === 'weekly') {
    assert(Array.isArray(value.days) && value.days.length > 0 && value.days.length <= 7 && value.days.every(day => Number.isInteger(day) && day >= 1 && day <= 7), '请至少选择一个星期。');
    result.days = [...new Set(value.days)].sort((a, b) => a - b);
  }
  if (kind === 'monthly') { assert(value.day === 'last' || Number.isInteger(value.day) && value.day >= 1 && value.day <= 31, '请选择每月 1 至 31 日或最后一天。'); result.day = value.day; }
  assert(!result.startDate || !result.endDate || result.endDate >= result.startDate, '结束日期不能早于生效日期。');
  return result;
}
export function nextScheduleAt(value, after = Date.now(), completed = 0) {
  const rule = normalizeSchedule(value);
  if (rule.maxRuns && completed >= rule.maxRuns) return null;
  const end = rule.endDate ? dateAt(rule.endDate, '结束日期') + DAY : Infinity;
  if (rule.kind === 'interval') {
    const period = rule.minutes * 60000, at = rule.anchorAt == null ? after + period : rule.anchorAt + Math.max(0, Math.floor((after - rule.anchorAt) / period) + 1) * period;
    return at < end ? at : null;
  }
  if (rule.kind === 'once') { const at = Date.parse(`${rule.date}T${rule.time}:00+08:00`); return at > after ? at : null; }
  const start = rule.startDate ? dateAt(rule.startDate, '生效日期') : after;
  const clock = new Date(Math.max(after, start) + OFFSET), [hour, minute] = rule.time.split(':').map(Number);
  const today = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate(), hour, minute) - OFFSET;
  for (let offset = 0; offset < 370; offset++) {
    const at = today + offset * DAY, local = new Date(at + OFFSET);
    if (at >= end) return null;
    if (at <= after) continue;
    if (rule.kind === 'weekly' && !rule.days.includes(local.getUTCDay() || 7)) continue;
    if (rule.kind === 'monthly' && local.getUTCDate() !== (rule.day === 'last' ? new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate() : rule.day)) continue;
    return at;
  }
  return null;
}
export function upcomingSchedule(value, after = Date.now(), count = 3, completed = 0) {
  const times = [];
  for (let index = 0; index < count; index++) { const at = nextScheduleAt(value, after, completed + index); if (at == null) break; times.push(at); after = at; }
  return times;
}
export function formatScheduleTime(at) {
  if (!Number.isFinite(at)) return '—';
  const date = new Date(at + OFFSET);
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日 周${'日一二三四五六'[date.getUTCDay()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
export function describeSchedule(value) {
  const rule = normalizeSchedule(value);
  if (rule.kind === 'interval') return `每 ${rule.minutes % 1440 === 0 ? `${rule.minutes / 1440} 天` : rule.minutes % 60 === 0 ? `${rule.minutes / 60} 小时` : `${rule.minutes} 分钟`}执行一次`;
  if (rule.kind === 'once') return `${rule.date.replace(/^(\d+)-(\d+)-(\d+)$/, '$1年$2月$3日')} ${rule.time}，仅一次`;
  if (rule.kind === 'daily') return `每天 ${rule.time}`;
  if (rule.kind === 'monthly') return `每月${rule.day === 'last' ? '最后一天' : ` ${rule.day} 日`} ${rule.time}`;
  const days = rule.days.join(',') === '1,2,3,4,5' ? '每周一至周五' : rule.days.length === 7 ? '每天' : `每周${rule.days.map(day => '一二三四五六日'[day - 1]).join('、周')}`;
  return `${days} ${rule.time}`;
}
