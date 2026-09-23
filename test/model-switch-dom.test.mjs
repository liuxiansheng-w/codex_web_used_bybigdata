import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createModelSwitch } from '../public/interactions.js';
const state = () => ({ active: 'codex', revision: 0, cosmos: { protocol: 'workflow', baseUrl: 'https://cosmos.example/v1', inputKey: 'input', outputKey: 'output', model: '', hasKey: false } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(t, api) {
  const dom = new JSDOM('<button id="switch"><strong>Codex</strong></button><textarea>unsent draft</textarea>', { url: 'http://localhost', pretendToBeVisual: true });
  const { window } = dom, doc = window.document;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const button = doc.querySelector('button'), calls = [], switches = [];
  const ui = createModelSwitch({ button, api: (...args) => { calls.push(args); return api(...args); }, onSwitch: async value => switches.push(value) });
  t.after(() => window.close());
  return { ui, calls, switches, window, doc, button, dialog: doc.querySelector('dialog'), key: doc.querySelector('#cosmosKey'),
    submit() { doc.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); } };
}

test('left switch accepts a password key, verifies before changing and never stores it in browser state', async t => {
  let saved = state();
  const f = fixture(t, async (route, body) => { assert.equal(route, '/api/model-connections'); if (body) saved = { ...saved, active: 'cosmos', revision: 1, cosmos: { ...saved.cosmos, hasKey: true } }; return saved; });
  f.button.click(); await tick(); f.doc.querySelector('[data-model-provider=cosmos]').click();
  assert.equal(f.key.type, 'password'); f.key.value = 'fictional-private-key';
  f.submit(); await tick();
  const body = f.calls.find(([, body]) => body)?.[1]; assert.equal(body.key, 'fictional-private-key'); assert.equal(body.protocol, 'workflow');
  assert.equal(f.switches.length, 1); assert.equal(f.dialog.open, false); assert.equal(f.key.value, '');
  assert.equal(f.doc.querySelector('textarea').value, 'unsent draft'); assert.equal(f.window.localStorage.length, 0);
  assert.equal(f.doc.body.textContent.includes('fictional-private-key'), false);
  f.button.click(); await tick(); assert.equal(f.key.value, ''); assert.match(f.key.placeholder, /已保存/);
  assert.equal(f.doc.querySelector('[data-model-key-editor]').hidden, true);
  f.doc.querySelector('[data-model-replace]').click();
  f.key.value = 'replacement'; f.doc.querySelector('[data-model-reveal]').click(); assert.equal(f.key.type, 'text');
  f.dialog.dispatchEvent(new f.window.Event('cancel', { cancelable: true })); assert.equal(f.key.value, ''); assert.equal(f.key.type, 'password');
});

test('failed verification preserves the selected service and allows correcting the entered key', async t => {
  const f = fixture(t, async (_, body) => { if (body) throw new Error('Key 无效'); return state(); });
  f.button.click(); await tick(); f.doc.querySelector('[data-model-provider=cosmos]').click(); f.key.value = 'invalid'; f.submit(); await tick();
  assert.equal(f.dialog.open, true); assert.equal(f.key.value, 'invalid'); assert.equal(f.switches.length, 0);
  assert.match(f.doc.querySelector('[role=status]').textContent, /Key 无效/); assert.equal(f.button.querySelector('strong').textContent, 'Codex');
  assert.equal(f.doc.querySelector('[data-model-apply]').disabled, false);
});

test('Chatflow exposes application type, omits output variable and preserves advanced values across type changes', async t => {
  const initial = state(); initial.cosmos.protocol = 'chatflow'; initial.cosmos.baseUrl = 'http://cosmos-api-inner.qingsonghealth.net/v1';
  const f = fixture(t, async (_, body) => body ? { ...initial, active: 'cosmos' } : initial);
  f.button.click(); await tick(); f.doc.querySelector('[data-model-provider=cosmos]').click();
  const protocol = f.doc.querySelector('[name=protocol]');
  assert.equal(protocol.value, 'chatflow'); assert.equal(protocol.closest('details'), null);
  assert.equal(f.doc.querySelector('[data-model-output]').hidden, true);
  assert.equal(f.doc.querySelector('[name=outputKey]').disabled, true);
  assert.equal(f.doc.querySelector('[data-model-chatflow-help]').hidden, false);
  assert.match(f.doc.querySelector('#modelProtocolHint').textContent, /直接回复/);
  f.doc.querySelector('[name=inputKey]').value = '';
  protocol.value = 'workflow'; protocol.dispatchEvent(new f.window.Event('change'));
  assert.equal(f.doc.querySelector('[data-model-output]').hidden, false);
  protocol.value = 'responses'; protocol.dispatchEvent(new f.window.Event('change'));
  assert.equal(f.doc.querySelector('[name=model]').required, true);
  protocol.value = 'chatflow'; protocol.dispatchEvent(new f.window.Event('change'));
  f.key.value = 'fictional-chatflow-key'; f.submit(); await tick();
  const body = f.calls.at(-1)[1]; assert.equal(body.protocol, 'chatflow'); assert.equal(body.inputKey, '');
  assert.equal(body.baseUrl, 'http://cosmos-api-inner.qingsonghealth.net/v1'); assert.equal(f.switches.length, 1);
});

test('a saved key stays hidden and is reused without resubmitting a secret; cancelled replacements clear the draft', async t => {
  const initial = state(); initial.active = 'cosmos'; initial.cosmos.hasKey = true;
  const f = fixture(t, async () => initial);
  f.button.click(); await tick();
  assert.equal(f.doc.querySelector('.model-key-saved').hidden, false);
  assert.equal(f.doc.querySelector('[data-model-key-editor]').hidden, true);
  assert.equal(f.key.disabled, true); assert.equal(f.doc.activeElement, f.doc.querySelector('[data-model-apply]'));
  f.doc.querySelector('[data-model-replace]').click();
  assert.equal(f.key.disabled, false); assert.equal(f.doc.activeElement, f.key);
  f.key.value = 'discarded-secret'; f.doc.querySelector('[data-model-cancel-replace]').click();
  assert.equal(f.key.value, ''); assert.equal(f.doc.querySelector('[data-model-key-editor]').hidden, true);
  f.submit(); await tick();
  assert.deepEqual(f.calls.at(-1)[1], { action: 'select', provider: 'cosmos', revision: 0 });
  f.button.click(); await tick(); assert.equal(f.doc.querySelector('[data-model-key-editor]').hidden, true);
  assert.equal(f.window.localStorage.length, 0);
});

test('changing settings can reuse a saved key but changing its destination requires a new one', async t => {
  const initial = state(); initial.active = 'cosmos'; initial.cosmos.hasKey = true; initial.cosmos.protocol = 'chatflow';
  const f = fixture(t, async (_, body) => body ? { ...initial, cosmos: { ...initial.cosmos, inputKey: body.inputKey } } : initial);
  f.button.click(); await tick();
  const input = f.doc.querySelector('[name=inputKey]'); input.value = ''; input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(f.doc.querySelector('[data-model-key-editor]').hidden, true);
  f.submit(); await tick(); assert.equal(f.calls.at(-1)[1].key, ''); assert.equal(f.calls.at(-1)[1].action, 'configure');
  f.button.click(); await tick();
  const base = f.doc.querySelector('[name=baseUrl]'); base.value = 'https://other.example/v1'; base.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(f.doc.querySelector('[data-model-key-editor]').hidden, false);
  const before = f.calls.length; f.submit(); await tick(); assert.equal(f.calls.length, before);
  assert.match(f.doc.querySelector('[role=status]').textContent, /服务地址已改变/);
  base.value = initial.cosmos.baseUrl + '/'; base.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.equal(f.doc.querySelector('[data-model-key-editor]').hidden, true);
});

test('cancel aborts verification and ignores late success; switching to Codex sends no key', async t => {
  let release, signal;
  const f = fixture(t, async (_, body, options) => {
    if (!body) return state();
    if (body.action === 'select') return state();
    signal = options.signal; return new Promise(resolve => { release = resolve; });
  });
  f.button.click(); await tick(); f.doc.querySelector('[data-model-provider=cosmos]').click(); f.key.value = 'test'; f.submit(); await tick();
  f.doc.querySelector('[data-model-close]').click(); assert.equal(signal.aborted, true);
  release({ ...state(), active: 'cosmos' }); await tick(); assert.equal(f.switches.length, 0); assert.equal(f.dialog.open, false);
  f.button.click(); await tick(); f.submit(); await tick();
  assert.deepEqual(f.calls.at(-1)[1], { action: 'select', provider: 'codex', revision: 0 }); assert.equal(f.switches.length, 1);
});
