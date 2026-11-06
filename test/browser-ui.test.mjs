import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBrowserWorkspace } from '../public/browser-workspace.js';

test('browser focuses input before the remote click returns and queues immediate typing behind that click', async t => {
  const dom = new JSDOM('<section id="browser"></section>', { url: 'http://localhost/', pretendToBeVisual: true }), win = dom.window, root = win.document.getElementById('browser');
  const calls = []; let clickDone, revision = 1;
  win.URL.createObjectURL = () => 'blob:fixture'; win.URL.revokeObjectURL = () => {}; win.fetch = async () => ({ ok: true, headers: { get: () => String(revision) }, blob: async () => new win.Blob(['fixture']) });
  const browser = createBrowserWorkspace({ root, getContext: () => ({ cwd: '/fixture', thread: { id: 'chat' } }), api: async (route, body) => {
    if (!body) return { tabs: [{ id: 'tab', url: 'https://example.test/', title: 'Fixture', revision }], downloads: [], shared: false };
    calls.push(body);
    if (body.action === 'click') await new Promise(resolve => { clickDone = resolve; });
    return { id: 'tab', revision: ++revision };
  } });
  t.after(() => { browser.setVisible(false); win.close(); });
  browser.setVisible(true); await new Promise(resolve => setTimeout(resolve, 0));
  const image = root.querySelector('img'), input = root.querySelector('textarea'); image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1100, height: 760 });
  image.dispatchEvent(new win.MouseEvent('pointerdown', { button: 0, clientX: 50, clientY: 60, bubbles: true, cancelable: true }));
  assert.equal(win.document.activeElement, input, 'typing must not be lost while the click is in flight');
  input.value = 'immediate'; input.dispatchEvent(new win.Event('input', { bubbles: true })); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls.map(call => call.action), ['click']); clickDone(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.map(call => call.action), ['click', 'type']); assert.equal(calls[1].text, 'immediate'); assert.equal(calls[1].revision, 2);
});
