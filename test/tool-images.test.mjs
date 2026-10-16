import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { Workspace } from '../lib/workspace.mjs';
import { ImagePreviews } from '../lib/image-previews.mjs';
import { toolResultContent } from '../lib/tool-results.mjs';
import { renderActivity } from '../public/execution-view.js';

const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5L0AAAAASUVORK5CYII=';
const picture = { type: 'image', mimeType: 'image/png', data };
const idOf = image => image.previewUrl.split('/').at(-1);

test('tool images recover from native history, stream safely and survive later status-only updates', async t => {
  const workspace = new Workspace(new EventEmitter(), '/project');
  t.after(() => { for (const timer of workspace.timers.values()) clearTimeout(timer); });
  const native = { id: 'shot', type: 'mcpToolCall', server: 'cua_repl', tool: 'js', status: 'completed', arguments: { private: 'tool argument' }, result: {
    content: [{ type: 'text', text: 'Screenshot captured' }, picture], structuredContent: { copy: data },
    _meta: { private: 'tool metadata', 'codex/toolSurface': { kind: 'browserUse', browserFamily: 'opera', browserId: 'internal' } },
  } };
  const raw = { id: 'thread', turns: [{ id: 'turn', status: 'inProgress', items: [native] }] };
  let thread = workspace.importThread(raw), image = thread.items[0].attachments[0];
  assert.deepEqual((await workspace.context.images.read(idOf(image))).bytes, Buffer.from(data, 'base64'));
  assert.deepEqual(thread.items[0].surface, { kind: 'browser', label: 'Opera' });
  assert.match(thread.items[0].text, /Screenshot captured/);
  assert.doesNotMatch(JSON.stringify(thread), new RegExp(`${data.slice(0, 20)}|tool argument|tool metadata|browserId`));
  const emit = item => workspace.notification({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item } });
  emit(native);
  assert.equal(thread.items.length, 1); assert.equal(thread.items[0].attachments[0].previewUrl, image.previewUrl);
  emit({ id: 'shot', type: 'mcpToolCall', server: 'cua_repl', tool: 'js', status: 'failed', error: { message: 'Later tool failure' } });
  assert.equal(thread.items[0].status, 'failed'); assert.equal(thread.items[0].attachments[0].previewUrl, image.previewUrl);
  raw.turns[0].items = [{ id: 'shot', type: 'mcpToolCall', server: 'cua_repl', tool: 'js', status: 'failed' }];
  thread = workspace.importThread(raw);
  assert.equal(thread.items[0].attachments[0].previewUrl, image.previewUrl);
  emit({ id: 'next', type: 'mcpToolCall', server: 'cua_repl', tool: 'js', status: 'completed' });
  assert.equal(thread.items.at(-1).attachments, undefined);
  emit({ id: 'dynamic', type: 'dynamicToolCall', tool: 'capture', status: 'completed', success: true, contentItems: [{ type: 'inputText', text: 'Dynamic screenshot' }, { type: 'inputImage', imageUrl: `data:image/png;base64,${data}` }] });
  assert.equal(thread.items.at(-1).attachments[0].previewUrl, image.previewUrl);
  assert.doesNotMatch(thread.items.at(-1).text, /data:image/);
  const fresh = new Workspace(new EventEmitter(), '/project').importThread({ id: 'fresh', turns: [{ id: 'turn', status: 'completed', items: [native] }] });
  assert.ok(fresh.items[0].attachments[0].previewUrl);
});

test('tool previews bound image counts and bytes and never turn remote URLs or resource paths into reads', async () => {
  const images = new ImagePreviews();
  const result = toolResultContent({ result: { content: [
    { type: 'resource', resource: { uri: 'file:///private/secret.png', mimeType: 'image/png', blob: data } },
    ...Array(17).fill(picture),
  ] } }, images);
  assert.equal(result.attachments.length, 16); assert.equal(result.omittedImages, 2);
  assert.equal(images.entries.size, 1); assert.equal(images.dataBytes, `data:image/png;base64,${data}`.length);
  assert.doesNotMatch(result.text, /secret|iVBOR/);
  const invalid = toolResultContent({ result: { content: [
    { type: 'inputImage', imageUrl: 'https://example.com/tracker.png' },
    { type: 'inputImage', imageUrl: 'file:///private/secret.png' },
    { type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' },
    { type: 'image', mimeType: 'image/png', data: 'A'.repeat(14_000_001) },
    { type: 'resource', resource: { uri: 'file:///private/secret.png', mimeType: 'image/png' } },
  ] } }, images);
  assert.ok(invalid.attachments.every(image => image.unavailable)); assert.equal(images.entries.size, 1);
  assert.doesNotMatch(invalid.text, /https:|file:|PHN2Zz4|A{100}/);
  const malformed = toolResultContent({ result: { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('not a raster').toString('base64') }] } }, images);
  await assert.rejects(images.read(idOf(malformed.attachments[0])), { status: 415 });
  const capped = new ImagePreviews(); capped.dataBytes = 100 * 1024 * 1024;
  assert.equal(toolResultContent({ result: { content: [picture] } }, capped).attachments[0].unavailable, true);
  const text = toolResultContent({ result: { content: [{ type: 'text', text: 'x'.repeat(100_005) }] } }, images);
  assert.equal(text.text.length, 100_000); assert.equal(text.outputTruncated, true);
});

test('tool thumbnails keep DOM and selection stable, and use the existing zoom, download and error viewer', () => {
  const dom = new JSDOM('<article></article>'), document = dom.window.document, element = document.querySelector('article');
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const item = { type: 'mcpToolCall', title: 'cua_repl / js', status: 'completed', text: 'Captured',
    surface: { kind: 'browser', label: '<img src=x onerror=alert(1)>' },
    attachments: [{ kind: 'image', name: '工具图片 1', previewUrl: '/api/attachments/images/12345678-1234-1234-1234-123456789abc' }], omittedImages: 2 };
  renderActivity(element, item);
  const thumb = element.querySelector('.attachment-image img'), details = element.querySelector('details');
  assert.ok(thumb); assert.equal(details.contains(thumb), false); assert.equal(details.open, false);
  assert.equal(element.querySelectorAll('img').length, 1); assert.match(element.textContent, /另有 2 张未展示/);
  const range = document.createRange(); range.selectNodeContents(element.querySelector('.activity-output')); document.getSelection().addRange(range);
  renderActivity(element, { ...item, durationMs: 200, status: 'failed' });
  assert.equal(element.querySelector('.attachment-image img'), thumb); assert.equal(document.getSelection().toString(), 'Captured');
  const button = element.querySelector('.attachment-image-button'); button.focus(); button.click();
  const dialog = document.querySelector('dialog'); assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('a').getAttribute('href'), item.attachments[0].previewUrl);
  assert.equal(dialog.querySelector('a').download, '工具图片 1');
  dialog.querySelector('button').click(); assert.ok(dialog.querySelector('.original-size'));
  dialog.querySelector('button[aria-label="关闭图片预览"]').click(); assert.equal(document.activeElement, button);
  thumb.dispatchEvent(new dom.window.Event('error')); assert.equal(button.hidden, true); assert.match(element.textContent, /图片已失效/);
  dom.window.close();
});
