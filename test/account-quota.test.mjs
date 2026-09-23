import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { quotaWindows, createQuotaIndicator } from '../public/interactions.js';
const usage = (usedPercent = 54) => ({ rateLimits: { limitId: 'codex', primary: { usedPercent, windowDurationMins: 10080, resetsAt: 1790252707 }, secondary: null, credits: { unlimited: false, balance: '0' } } });
const loggedIn = { connected: true, loggedIn: true, type: 'chatgpt' };
function setup(t, api) {
  const dom = new JSDOM('<button><i></i><span></span></button>', { pretendToBeVisual: true });
  const { window } = dom, doc = window.document, button = doc.querySelector('button');
  let time = 1790000000000;
  const calls = [], quota = createQuotaIndicator({ button, api: (...args) => { calls.push(args); return api(...args); }, now: () => time });
  t.after(() => { quota.destroy(); window.close(); });
  return { quota, button, window, doc, calls, tick: ms => { time += ms; } };
}

test('quota uses real account windows, keeps distinct periods and never treats missing values or credits as 100%', () => {
  assert.deepEqual(quotaWindows(usage()), [{ label: '周', remaining: 46, resetsAt: 1790252707000 }]);
  const data = usage(99);
  data.rateLimitsByLimitId = { codex: { primary: { usedPercent: 20, windowDurationMins: 300 }, secondary: { usedPercent: 91, windowDurationMins: 10080 } }, other: { primary: { usedPercent: 0 } } };
  assert.deepEqual(quotaWindows(data).map(({ label, remaining }) => [label, remaining]), [['5h', 80], ['周', 9]]);
  assert.equal(quotaWindows(usage(0))[0].remaining, 100);
  assert.equal(quotaWindows(usage(100))[0].remaining, 0);
  for (const value of [null, undefined, '54', NaN]) assert.deepEqual(quotaWindows(usage(value === undefined ? null : value)), []);
  assert.deepEqual(quotaWindows({ rateLimitsByLimitId: { other: { primary: { usedPercent: 0 } } } }), []);
  assert.deepEqual(quotaWindows({ rateLimits: { limitId: 'other', primary: { usedPercent: 0 } } }), []);
  assert.deepEqual(quotaWindows({ rateLimits: { credits: { unlimited: true } } }), []);
});

test('footer quota refreshes on demand, reports both windows and clears stale success after an error', async t => {
  let data = usage(), fail = false;
  const { quota, button, calls } = setup(t, async () => { if (fail) throw new Error('private upstream details'); return data; });
  quota.setAvailability(loggedIn); await quota.refresh();
  assert.equal(button.textContent, '额度 46%'); assert.equal(button.dataset.level, 'normal');
  assert.match(button.title, /周额度剩余 46%.*重置时间/); assert.match(button.title, /点击刷新/);
  await quota.refresh(); assert.equal(calls.length, 1, 'focus/turn updates are throttled');
  data = { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 }, secondary: { usedPercent: 91, windowDurationMins: 10080 } } };
  button.click(); await quota.refresh();
  assert.equal(button.textContent, '额度 5h 80% · 周 9%'); assert.equal(button.dataset.level, 'low');
  fail = true; await quota.refresh({ force: true });
  assert.equal(button.textContent, '额度 —'); assert.equal(button.dataset.level, 'unknown');
  assert.match(button.title, /暂不可用/); assert.doesNotMatch(button.title, /private/);
  fail = false; data = usage(75); await quota.refresh({ force: true });
  assert.equal(button.textContent, '额度 25%'); assert.equal(button.dataset.level, 'warning');
  assert.ok(calls.every(([route, body]) => route === '/api/usage' && body === undefined));
});

test('logout invalidates an in-flight response and unsupported login does not poll', async t => {
  let finish, signal;
  const { quota, button, calls } = setup(t, (_route, _body, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); });
  quota.setAvailability(loggedIn); const pending = quota.refresh(); await Promise.resolve();
  quota.setAvailability({ connected: true, loggedIn: false });
  assert.equal(signal.aborted, true); finish(usage()); await pending;
  assert.equal(button.textContent, '额度 —'); assert.equal(button.disabled, true); assert.match(button.title, /登录后/);
  quota.setAvailability({ ...loggedIn, type: 'apiKey' }); await quota.refresh();
  assert.equal(calls.length, 1); assert.match(button.title, /不提供订阅额度/);
});

test('hidden pages pause quota reads and returning focus refreshes without touching other DOM', async t => {
  const { quota, button, window, doc, calls, tick } = setup(t, async () => usage());
  const input = doc.createElement('textarea'); input.value = '未发送草稿'; doc.body.append(input); input.focus();
  quota.setAvailability(loggedIn); await quota.refresh();
  Object.defineProperty(doc, 'hidden', { configurable: true, value: true });
  tick(180000); await quota.refresh(); assert.equal(calls.length, 1); assert.doesNotMatch(button.textContent, /46/);
  Object.defineProperty(doc, 'hidden', { configurable: true, value: false });
  doc.dispatchEvent(new window.Event('visibilitychange')); await quota.refresh();
  assert.equal(calls.length, 2); assert.equal(button.textContent, '额度 46%');
  assert.equal(input.value, '未发送草稿'); assert.equal(doc.activeElement, input);
  quota.setAvailability({ ...loggedIn, connected: false }); assert.equal(button.textContent, '额度 —');
});
