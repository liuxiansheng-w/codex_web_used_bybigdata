import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBrowserAnnotations } from '../public/browser-annotations.js';

function setup(t, options = {}) {
  const dom = new JSDOM('<section id="browser"><div class="browser-options"></div><p class="browser-status"></p><div class="browser-viewport"><img></div><p class="browser-caption"></p></section>', { url: 'http://localhost/', pretendToBeVisual: true });
  const win = dom.window, root = win.document.getElementById('browser'), image = root.querySelector('img'), viewport = root.querySelector('.browser-viewport');
  image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1100, height: 760 });
  const state = { cwd: '/project-a', thread: { id: 'chat-a' }, browserAnnotations: true }, tab = { id: 'tab-a', url: 'https://example.test/page?private=not-for-prompt', revision: 7 };
  const frame = { blob: new win.Blob(['fixture']), tabId: tab.id, revision: 7, url: tab.url };
  const sent = [], inspected = [];
  const controller = createBrowserAnnotations({ root, image, viewport, getContext: () => state, getTab: () => tab, getFrame: () => frame,
    inspect: async value => { inspected.push(value); return { element: { selector: 'button#save', role: 'button', label: 'Save', text: 'Save', rect: { x: 20, y: 30, width: 100, height: 40 } } }; },
    imageBuilder: options.imageBuilder || (async (_win, _frame, notes, index) => new win.File(['fixture-' + notes.length], 'shot-' + index + '.png', { type: 'image/png' })),
    onAnnotations: async value => { sent.push(value); return true; }, notify: message => assert.fail(message),
  });
  t.after(() => win.close());
  const click = (node, type, x, y) => node.dispatchEvent(new win.MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const choose = async (start, end) => {
    root.querySelector('.browser-options button').click(); const layer = root.querySelector('.browser-annotation-layer');
    click(layer, 'pointerdown', ...start); if (end) click(layer, 'pointermove', ...end); click(layer, 'pointerup', ...(end || start));
    await new Promise(resolve => win.setTimeout(resolve, 0));
  };
  const save = text => {
    const form = root.querySelector('.browser-annotation-panel form'), input = form.querySelector('textarea');
    input.value = text; input.dispatchEvent(new win.Event('input', { bubbles: true })); form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  };
  return { win, root, state, tab, frame, sent, inspected, controller, choose, save };
}

test('element and area annotations stay in draft until explicitly added with marked images', async t => {
  const f = setup(t);
  await f.choose([30, 40]); assert.equal(f.inspected.length, 1); assert.equal(f.inspected[0].revision, 7);
  assert.equal(f.sent.length, 0); assert.equal(f.controller.hasDraft, true);
  f.save('请缩小这个按钮'); assert.match(f.root.querySelector('[data-list]').textContent, /缩小/);
  // Turn selection off and back on for the second annotation.
  f.root.querySelector('.browser-options button').click();
  await f.choose([120, 140], [420, 300]); f.save('调整这片区域');
  assert.equal(f.root.querySelectorAll('.browser-annotation-row').length, 2);
  assert.equal(f.inspected.length, 1, 'dragging an area must not click or inspect the remote page');
  f.root.querySelector('[data-attach]').click(); await new Promise(resolve => f.win.setTimeout(resolve, 0));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].images.length, 1);
  assert.match(f.sent[0].text, /缩小这个按钮/); assert.match(f.sent[0].text, /调整这片区域/);
  assert.match(f.sent[0].text, /button#save/); assert.doesNotMatch(f.sent[0].text, /private=not-for-prompt/);
  assert.equal(f.controller.hasDraft, false);
});

test('annotation drafts remain isolated across chats and a late attachment cannot cross contexts', async t => {
  let release;
  const f = setup(t, { imageBuilder: async win => { await new Promise(resolve => { release = resolve; }); return new win.File(['fixture'], 'shot.png', { type: 'image/png' }); } });
  await f.choose([15, 15], [200, 100]); f.save('保留在原聊天');
  f.root.querySelector('[data-attach]').click(); await new Promise(resolve => f.win.setTimeout(resolve, 0));
  f.state.thread = { id: 'chat-b' }; f.controller.sync(); release();
  await new Promise(resolve => f.win.setTimeout(resolve, 0));
  assert.equal(f.sent.length, 0); assert.equal(f.controller.hasDraft, true);
  assert.equal(f.root.querySelectorAll('.browser-annotation-row').length, 0);
  f.state.thread = { id: 'chat-a' }; f.controller.sync();
  assert.match(f.root.querySelector('[data-list]').textContent, /保留在原聊天/);
  assert.equal(f.controller.hasTabDraft('/project-a', 'tab-a'), true);
});
