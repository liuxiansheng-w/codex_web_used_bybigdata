import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTerminalConsole } from '../public/workbench.js';

function setup(t, { start, action } = {}) {
  const dom = new JSDOM('<section id="terminal"></section>', { url: 'http://localhost', pretendToBeVisual: true });
  const { document } = dom.window, $ = id => document.getElementById(id), requests = [], processes = [];
  let cwd = '/project', visible = true, count = 0;
  dom.window.confirm = () => assert.fail('Pressing Enter must not open a second confirmation');
  const api = async (route, body) => {
    requests.push({ route, body });
    if (route === '/api/terminal') return { processes: structuredClone(processes) };
    if (route === '/api/terminal/start') {
      if (start) await start(body);
      const id = `command-${++count}`; processes.push({ ...body, id, output: '', running: true }); return { id };
    }
    if (route === '/api/terminal/action') {
      if (action) await action(body);
      if (body.action === 'stop') { const p = processes.find(p => p.id === body.id); p.running = false; p.exitCode = 130; }
      return { ok: true };
    }
    assert.fail(`Unexpected API ${route}`);
  };
  const control = createTerminalConsole({ root: $('terminal'), api, getContext: () => ({ cwd }), isVisible: () => visible });
  t.after(() => { control.dispose(); dom.window.close(); }); control.syncContext();
  const input = $('terminalCommand');
  const type = value => { input.value = value; input.dispatchEvent(new dom.window.Event('input')); };
  const key = (value, extra = {}) => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }));
  const settle = async (condition = () => !control.pending) => { for (let i = 0; i < 100; i++) { await new Promise(resolve => setImmediate(resolve)); if (condition()) return; } assert.fail('Terminal did not settle'); };
  return { $, window: dom.window, input, requests, processes, control, type, key, settle, async project(next) { cwd = next; control.syncContext(); await settle(() => true); }, hide() { visible = false; control.hide(); }, async show() { visible = true; await control.refresh(); } };
}

test('terminal executes one explicit Enter without a submit button, keeps IME and multiline paste safe, and recalls history', async t => {
  const { $, input, type, key, requests, processes, settle, control } = setup(t); await settle();
  assert.equal($('terminalForm').querySelector('button'), null);
  type('printf "hello"'); key('Enter', { isComposing: true }); key('Enter', { shiftKey: true });
  assert.equal(requests.filter(r => r.route.endsWith('/start')).length, 0);
  key('Enter'); key('Enter', { repeat: true }); await settle();
  assert.deepEqual(requests.find(r => r.route.endsWith('/start')).body, { cwd: '/project', command: 'printf "hello"', writable: false, confirmed: true });
  assert.equal(requests.filter(r => r.route.endsWith('/start')).length, 1);
  processes[0].running = false; processes[0].exitCode = 0; processes[0].output = '\u001b[32mhello\u001b[0m\n<img src=x onerror=alert(1)>';
  await control.refresh(); assert.match($('terminalResults').textContent, /hello/); assert.equal($('terminalResults').querySelector('img'), null);
  assert.doesNotMatch($('terminalResults').textContent, /\u001b|退出码 0/);
  type('unfinished'); key('ArrowUp'); assert.equal(input.value, 'printf "hello"'); key('ArrowDown'); assert.equal(input.value, 'unfinished');
  type('line one\nline two'); assert.equal(requests.filter(r => r.route.endsWith('/start')).length, 1, 'pasting multiline text cannot execute it');
  key('c', { ctrlKey: true }); assert.equal(input.value, ''); assert.equal(requests.filter(r => r.route.endsWith('/action')).length, 0);
  key('l', { ctrlKey: true }); assert.equal($('terminalResults').textContent, '');
  key('ArrowUp'); assert.equal(input.value, 'printf "hello"', 'clearing the view preserves command history');
});

test('the same prompt sends stdin while running, preserves draft and selection while polling, and Ctrl+C targets only its process', async t => {
  const { $, input, type, key, requests, processes, settle, control, hide, show } = setup(t); await settle();
  type('read demo'); key('Enter'); await settle();
  assert.equal(input.getAttribute('aria-label'), '终端标准输入');
  type('answer'); input.setSelectionRange(1, 3); await control.refresh(); assert.equal(input.selectionStart, 1); assert.equal(input.value, 'answer');
  hide(); await show(); assert.equal(input.value, 'answer');
  key('Enter'); await settle();
  assert.deepEqual(requests.find(r => r.body?.action === 'input').body, { id: 'command-1', action: 'input', text: 'answer' });
  assert.equal(input.value, ''); type('unsent stdin'); key('c', { ctrlKey: true }); await settle();
  assert.deepEqual(requests.find(r => r.body?.action === 'stop').body, { id: 'command-1', action: 'stop' });
  assert.equal(processes[0].running, false); assert.equal(input.getAttribute('aria-label'), '终端命令');
  assert.match($('terminalResults').textContent, /退出码 130/);
  assert.equal(requests.filter(r => r.route.endsWith('/start')).length, 1);
});

test('switching projects during submission cannot clear or execute the new project draft and keeps write permission scoped', async t => {
  let resolveStart; const gate = new Promise(resolve => { resolveStart = resolve; });
  const { $, window, type, key, input, project, requests, settle } = setup(t, { start: () => gate }); await settle();
  $('terminalWritable').checked = true; $('terminalWritable').dispatchEvent(new window.Event('change'));
  type('project A command'); key('Enter'); key('Enter');
  await project('/another-project'); type('project B draft');
  assert.equal($('terminalWritable').checked, false); assert.equal(input.readOnly, false);
  resolveStart(); await settle();
  assert.equal(input.value, 'project B draft'); assert.equal($('terminalResults').textContent, '');
  const starts = requests.filter(r => r.route.endsWith('/start'));
  assert.equal(starts.length, 1); assert.equal(starts[0].body.cwd, '/project'); assert.equal(starts[0].body.writable, true);
  await project('/project'); assert.match($('terminalResults').textContent, /project A command/); assert.equal($('terminalWritable').checked, true);
  await project('/another-project'); assert.equal(input.value, 'project B draft');
  key('ArrowUp'); assert.equal(input.value, 'project B draft', 'history from another project must not leak into this prompt');
});

test('a failed start or stdin write preserves its draft and never retries without Enter', async t => {
  let fail = true;
  const { $, input, type, key, settle, requests, control } = setup(t, {
    start: () => { if (fail) throw new Error('start rejected'); }, action: () => { throw new Error('input rejected'); },
  }); await settle();
  type('keep this command'); key('Enter'); await settle();
  assert.equal(input.value, 'keep this command'); assert.equal(input.readOnly, false); assert.match($('terminalStatus').textContent, /start rejected/);
  await control.refresh(); assert.equal(requests.filter(r => r.route.endsWith('/start')).length, 1);
  fail = false; key('Enter'); await settle(); type('keep this input'); key('Enter'); await settle();
  assert.equal(input.value, 'keep this input'); assert.match($('terminalStatus').textContent, /input rejected/);
  assert.equal(requests.filter(r => r.body?.action === 'input').length, 1);
});
