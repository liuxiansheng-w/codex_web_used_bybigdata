import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUNDLED_CALENDAR } from '../public/holiday-calendar.js';
import { beijingDate } from '../public/schedule-time.js';

const MAX_BYTES = 150_000;
const REFRESH_INTERVAL = 12 * 60 * 60 * 1000;
const sourceUrl = year => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;

function validatedYear(value, year) {
  if (!value || value.year !== year || !Array.isArray(value.papers) || !value.papers.length || value.papers.length > 10 || !Array.isArray(value.days) || !value.days.length || value.days.length > 150) throw new Error('日历格式不完整');
  if (!value.papers.every(paper => { try { const url = new URL(paper); return url.protocol === 'https:' && (url.hostname === 'www.gov.cn' || url.hostname.endsWith('.www.gov.cn')); } catch { return false; } })) throw new Error('日历缺少国务院文件来源');
  const seen = new Map(), days = [];
  for (const item of value.days) {
    if (!item || typeof item.name !== 'string' || item.name.length > 100 || typeof item.date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(item.date) || typeof item.isOffDay !== 'boolean') throw new Error('日历日期无效');
    const date = new Date(`${item.date}T00:00:00Z`);
    if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== item.date || ![year, year - 1].includes(date.getUTCFullYear())) throw new Error('日历日期超出范围');
    if (seen.has(item.date) && seen.get(item.date) !== item.isOffDay) throw new Error('日历日期冲突');
    days.push({ date: item.date, isOffDay: item.isOffDay, name: item.name });
    seen.set(item.date, item.isOffDay);
  }
  if (!['元旦', '春节', '清明', '劳动', '端午', '中秋', '国庆'].every(name => value.days.some(item => item.isOffDay && item.name.includes(name)))) throw new Error('年度日历不完整');
  return { year, papers: value.papers, days, source: 'holiday-cn 数据集（标注国务院通知）' };
}

async function boundedText(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('日历数据过大');
  if (!response.body?.getReader) { const text = await response.text(); if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('日历数据过大'); return text; }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_BYTES) throw new Error('日历数据过大'); chunks.push(value); }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

export class HolidayCalendar {
  constructor(stateDir, { fetchImpl = globalThis.fetch } = {}) {
    this.stateDir = stateDir; this.fetch = fetchImpl; this.calendar = structuredClone(BUNDLED_CALENDAR); this.loaded = false; this.lastAttempt = 0; this.lastWarning = '';
  }
  async load() {
    if (this.loaded) return this.snapshot();
    if (!this.loading) this.loading = (async () => {
      try {
        const text = await readFile(path.join(this.stateDir, 'holiday-calendar.json'), 'utf8');
        if (Buffer.byteLength(text) > MAX_BYTES * 5) throw new Error('缓存过大');
        const stored = JSON.parse(text);
        for (const value of Object.values(stored.years || {})) {
          if (!Number.isInteger(value.year) || value.year < 2000 || value.year > 2099) throw new Error('年份无效');
          this.calendar.years[value.year] = validatedYear(value, value.year);
        }
      } catch (error) { if (error.code !== 'ENOENT') this.lastWarning = '节假日缓存无法读取，已保留内置数据。'; }
      this.loaded = true;
    })();
    await this.loading; this.loading = null; return this.snapshot();
  }
  snapshot() { return { years: structuredClone(this.calendar.years), warning: this.lastWarning, lastAttempt: this.lastAttempt || null }; }
  async refresh({ force = false, at = Date.now() } = {}) {
    await this.load();
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.lastAttempt < REFRESH_INTERVAL) return this.snapshot();
    this.lastAttempt = Date.now();
    this.refreshing = (async () => {
      const year = Number(beijingDate(at).slice(0, 4));
      const results = await Promise.allSettled([year, year + 1].filter(value => value <= 2099).map(async value => {
        const response = await this.fetch(sourceUrl(value), { signal: AbortSignal.timeout(4000), redirect: 'error', headers: { accept: 'application/json' } });
        return validatedYear(JSON.parse(await boundedText(response)), value);
      }));
      let updated = false;
      for (const entry of results) if (entry.status === 'fulfilled') { this.calendar.years[entry.value.year] = entry.value; updated = true; }
      this.lastWarning = results.some(item => item.status === 'rejected') ? '部分年度日历未能更新；只使用已有数据，未知日期不会自动执行。' : '';
      if (updated) {
        try {
          await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
          const temporary = path.join(this.stateDir, `holiday-${randomUUID()}.tmp`), handle = await open(temporary, 'wx', 0o600);
          try { await handle.writeFile(JSON.stringify(this.calendar)); } finally { await handle.close(); }
          await rename(temporary, path.join(this.stateDir, 'holiday-calendar.json'));
        } catch { this.lastWarning = '日历已更新但未能保存缓存；服务重启后需重新更新。'; }
      }
      return this.snapshot();
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
}
