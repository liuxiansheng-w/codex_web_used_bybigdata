import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createTestPreview, latestTestImage } from '../public/product-ui.js';
import { createModuleThemeControls } from '../public/interactions.js';

const image = n => ({ kind: 'image', name: '工具图片', previewUrl: `/api/attachments/images/12345678-1234-1234-1234-${String(n).padStart(12, '0')}` });
const user = (id = 'u1', turnId = 't1') => ({ id, turnId, type: 'userMessage', text: '测试虚构页面' });
const shot = (id = 'shot1', n = 1, turnId = 't1') => ({ id, turnId, type: 'mcpToolCall', title: 'cua_repl / js', status: 'completed', surface: { kind: 'browser', label: '内置浏览器' }, attachments: [image(n)] });
const task = () => ({ id: 'thread1', cwd: '/fixture', turnId: 't1', latestTurnId: 't1', busy: true, items: [user()], requests: [] });

function page(t, initial = task()) {
  const errors = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div class="workspace-shortcuts"><button id="toolboxButton">工具箱</button><button>更多工具</button></div><textarea id="prompt">聊天草稿</textarea><textarea id="fileEditorText">未保存文件</textarea></body></html>', { url: 'http://localhost:4318', pretendToBeVisual: true, virtualConsole: console });
  const { document } = dom.window, $ = id => document.getElementById(id);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const context = { thread: initial, live: true, cwd: '/fixture' }; let time = Date.UTC(2026, 9, 21, 12, 34, 56);
  const preview = createTestPreview({ document, getContext: () => context, now: () => time });
  t.after(() => { preview.destroy(); dom.window.close(); assert.deepEqual(errors, []); });
  return { dom, document, $, context, preview, time: value => { time = value; } };
}

test('selector uses only actual authenticated tool images in the newest user request', () => {
  const thread = task();
  thread.items.push(shot(), { id: 'generated', type: 'imageGeneration', turnId: 't1', attachment: image(9) }, { id: 'assistant', type: 'agentMessage', turnId: 't1', text: 'file:///tmp/fake.png', attachments: [image(8)] }, { ...shot('external'), attachments: [{ kind: 'image', previewUrl: 'https://example.test/tracker.png' }] });
  const latest = latestTestImage(thread); assert.equal(latest.item.id, 'shot1'); assert.equal(latest.unavailable, true);
  thread.items.push(shot('newer', 2)); assert.equal(latestTestImage(thread).attachment.previewUrl, image(2).previewUrl);
  thread.items.push(user('u2')); assert.equal(latestTestImage(thread), null);
  thread.items.push({ ...shot('dynamic', 3), type: 'dynamicToolCall', surface: undefined }); assert.equal(latestTestImage(thread).item.id, 'dynamic');
  thread.items.push({ ...user('pending', null), pending: true }); assert.equal(latestTestImage(thread), null);
});

test('first live image opens without stealing focus; subsequent images reuse the image and controls', t => {
  const { $, document, context, preview, time } = page(t);
  assert.equal($('testPreviewWindow').hidden, true); $('prompt').focus();
  context.thread.items.push(shot()); preview.sync();
  assert.equal($('testPreviewWindow').hidden, false); assert.equal(document.activeElement, $('prompt'));
  assert.match($('testPreviewSource').textContent, /内置浏览器/); assert.match($('testPreviewTime').textContent, /20:34:56/);
  const img = $('testPreviewImage').querySelector('img'), zoom = $('testPreviewZoom');
  time(Date.UTC(2026, 9, 21, 12, 35)); context.thread.items.push(shot('shot2', 2)); preview.sync();
  assert.equal($('testPreviewImage').querySelector('img'), img); assert.equal($('testPreviewZoom'), zoom); assert.equal(img.getAttribute('src'), image(2).previewUrl);
  assert.match($('testPreviewTime').textContent, /20:35:00/); assert.equal($('prompt').value, '聊天草稿'); assert.equal($('fileEditorText').value, '未保存文件');
  assert.equal(JSON.stringify(document.defaultView.localStorage).includes('/attachments/images'), false);
});

test('closing suppresses this request only; minimizing survives updates and the next request clears old content', t => {
  const { $, context, preview } = page(t); context.thread.items.push(shot()); preview.sync();
  $('testPreviewMinimize').click(); assert.equal($('testPreviewBody').hidden, true);
  context.thread.items.push(shot('shot2', 2)); preview.sync(); assert.equal($('testPreviewBody').hidden, true);
  $('testPreviewClose').click(); context.thread.items.push(shot('shot3', 3)); preview.sync(); assert.equal($('testPreviewWindow').hidden, true);
  context.thread.items.push(user('u2')); preview.sync(); assert.equal($('testPreviewImage').children.length, 0); assert.equal($('testPreviewTime').textContent, '');
  context.thread.items[1] = shot('shot1', 4); preview.sync(); assert.equal($('testPreviewImage').children.length, 0, 'late result in an earlier message range stays out');
  context.thread.items.push(shot('new-request', 5)); preview.sync(); assert.equal($('testPreviewWindow').hidden, false);
  assert.equal($('testPreviewBody').hidden, true, 'manual compact view survives new tasks');
  $('testPreviewMinimize').click(); assert.equal($('testPreviewBody').hidden, false);
});

test('pending new messages, new turns, projects and conversations never fall back to old screenshots', t => {
  const { $, context, preview } = page(t); context.thread.items.push(shot()); preview.sync();
  context.thread.items.push({ ...user('pending', null), pending: true }); preview.sync(); assert.equal($('testPreviewImage').children.length, 0); assert.match($('testPreviewStatus').textContent, /发送中/);
  context.thread.items.pop(); context.thread.turnId = 't2'; context.thread.latestTurnId = 't2'; context.thread.items.push(user('u2', 't2')); preview.sync(); assert.equal($('testPreviewImage').children.length, 0);
  context.thread.items.push(shot('new-turn', 2, 't2')); preview.sync(); assert.ok($('testPreviewImage').querySelector('img'));
  context.thread = { ...task(), id: 'thread2' }; preview.sync(); assert.equal($('testPreviewImage').children.length, 0);
  context.thread.items.push(shot()); context.cwd = '/another-project'; preview.sync(); assert.equal($('testPreviewImage').children.length, 0);
});

test('disconnect, approvals, failure and interruption retain the same picture with truthful status', t => {
  const { $, context, preview } = page(t); context.thread.items.push(shot()); preview.sync();
  const img = $('testPreviewImage').querySelector('img'), time = $('testPreviewTime').textContent;
  context.live = false; preview.sync(); assert.match($('testPreviewStatus').textContent, /连接待同步.*保留/); assert.equal($('testPreviewWindow').dataset.state, 'stale');
  context.live = true; context.thread.requests = [{ id: 'approval' }]; preview.sync(); assert.match($('testPreviewStatus').textContent, /等待确认/);
  context.thread.requests = []; context.thread.busy = false; context.thread.completion = 'failed'; preview.sync(); assert.match($('testPreviewStatus').textContent, /任务未完成/);
  context.thread.completion = 'interrupted'; preview.sync(); assert.match($('testPreviewStatus').textContent, /已停止/);
  context.thread.completion = 'completed'; preview.sync(); assert.match($('testPreviewStatus').textContent, /已结束/);
  assert.equal($('testPreviewImage').querySelector('img'), img); assert.equal($('testPreviewTime').textContent, time);
});

test('history stays closed until requested and does not invent capture times or browser identities', t => {
  const thread = task(); thread.busy = false; thread.completion = 'completed'; thread.items.push({ ...shot(), surface: undefined });
  const { $, preview } = page(t, thread); assert.equal($('testPreviewWindow').hidden, true);
  $('testPreviewToggle').click(); assert.equal($('testPreviewWindow').hidden, false); assert.match($('testPreviewTime').textContent, /拍摄时间未记录/); assert.equal($('testPreviewSource').textContent, '工具返回图片');
  preview.sync(); assert.equal($('testPreviewTime').textContent.includes('20:34'), false);
});

test('large view, download, image failures and independent theme use the existing authenticated image viewer', t => {
  const { $, context, preview, document, dom } = page(t); context.thread.items.push(shot()); preview.sync();
  const themes = createModuleThemeControls({ root: document.documentElement, storage: dom.window.localStorage }); t.after(() => themes.dispose());
  const toggle = document.querySelector('[data-module-theme-toggle=testPreview]'); toggle.click(); assert.equal($('testPreviewWindow').dataset.theme, 'light');
  $('testPreviewZoom').click(); const dialog = document.querySelector('dialog'); assert.equal(dialog.open, true); assert.equal(dialog.querySelector('a').getAttribute('href'), image(1).previewUrl);
  dialog.querySelector('button').click(); assert.ok(dialog.querySelector('.original-size'));
  dialog.close(); assert.equal($('testPreviewDownload').getAttribute('href'), image(1).previewUrl);
  const img = $('testPreviewImage').querySelector('img'); img.dispatchEvent(new dom.window.Event('error')); assert.equal($('testPreviewZoom').disabled, true); assert.match($('testPreviewStatus').textContent, /已失效/);
  context.thread.items.push(shot('recovered', 2)); preview.sync(); assert.equal($('testPreviewZoom').disabled, false); assert.equal(img.hidden, false); assert.equal($('testPreviewWindow').dataset.theme, 'light');
  $('testPreviewZoom').click(); context.thread.items.push(user('u2')); preview.sync(); assert.equal(dialog.open, false); assert.equal($('testPreviewImage').children.length, 0);
});

test('unsafe image URLs and HTML metadata remain inert, and missing images show an explicit empty state', t => {
  const { $, context, preview, document } = page(t); context.thread.items.push({ ...shot(), surface: { kind: 'browser', label: '<img src=x onerror=bad()>' }, attachments: [image(1), { kind: 'image', previewUrl: 'file:///private/secret.png' }] }); preview.sync();
  assert.equal($('testPreviewSource').querySelector('img'), null); assert.match($('testPreviewSource').textContent, /<img/); assert.equal(document.querySelectorAll('img').length, 1);
  context.thread.items.push({ ...shot('unavailable'), attachments: [{ kind: 'image', unavailable: true }] }); preview.sync(); assert.match($('testPreviewStatus').textContent, /保留上一张/);
  context.thread = { ...task(), id: 'another-thread' }; context.thread.items.push({ ...shot(), attachments: [{ kind: 'image', previewUrl: '//external.test/tracker.png' }] }); preview.sync(); assert.equal($('testPreviewImage').children.length, 0); assert.match($('testPreviewStatus').textContent, /不可预览/);
  $('testPreviewToggle').click(); assert.equal($('testPreviewZoom').disabled, true);
});
