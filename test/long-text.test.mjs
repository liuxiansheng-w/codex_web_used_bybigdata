import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createComposerTools } from '../public/composer.js';
import { ContextStore, attachmentInput } from '../lib/context.mjs';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
async function setup(t, handle) {
  const dom = new JSDOM(html, { url: 'http://localhost' }), { window } = dom, { document } = window;
  const saved = Object.fromEntries(['window', 'document', 'Option', 'File', 'Blob', 'FileReader'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window, document, Option: window.Option, File: window.File, Blob: window.Blob, FileReader: window.FileReader });
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {} });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { if (this.open) { this.open = false; this.dispatchEvent(new window.Event('close')); } };
  const $ = id => document.getElementById(id), calls = [], notices = [], context = { cwd: '/project', thread: null };
  let savedDrafts = 0;
  const controller = createComposerTools({
    api: async (route, body, options) => { calls.push({ route, body }); return handle ? handle(route, body, options) : { id: `file-${calls.length}`, name: body.name, kind: 'file' }; },
    notice: message => notices.push(message), getContext: () => context, onChange: () => {}, onDraftChange: () => savedDrafts++,
  });
  const settle = async check => { for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Long-text operation did not settle'); };
  const paste = text => {
    const event = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: () => text } });
    $('prompt').dispatchEvent(event); return event;
  };
  const input = text => { $('prompt').value = text; $('prompt').dispatchEvent(new window.Event('input')); };
  t.after(() => { controller.reset(); Object.assign(globalThis, saved); window.close(); });
  return { controller, $, document, context, calls, notices, paste, input, settle, get savedDrafts() { return savedDrafts; } };
}

test('long paste preserves every UTF-8 byte in a real file, leaves instructions intact and sends only its reference', async t => {
  const store = new ContextStore();
  const env = await setup(t, (route, body) => { assert.equal(route, '/api/attachments/upload'); return store.upload(body); });
  const { $, controller, paste, input, settle, calls } = env;
  input('检查附件末尾的记录');
  assert.equal(paste('a'.repeat(4999)).defaultPrevented, false);
  const content = '<script>neverExecute()</script>\r\n' + '中文🙂\t行\r\n'.repeat(18000) + '\nEND-完整尾部';
  assert.equal(paste(content).defaultPrevented, true);
  assert.equal(controller.uploading, true); assert.equal(controller.canSend, false);
  input('上传期间继续编辑说明');
  await settle(() => !controller.uploading);
  assert.equal($('prompt').value, '上传期间继续编辑说明'); assert.equal(controller.canSend, true);
  const [file] = store.resolve(controller.payload().attachments);
  assert.equal(await readFile(file.path, 'utf8'), content);
  assert.equal(Buffer.from(calls[0].body.base64, 'base64').toString('utf8'), content);
  assert.equal(attachmentInput([file])[0].text.includes(file.path), true);
  assert.equal(JSON.stringify(controller.payload()).includes('完整尾部'), false);
  assert.equal(calls.length, 1); assert.ok(env.savedDrafts >= 2);
  document.querySelector('.pasted-text-open').click();
  assert.ok($('pastedTextPreview').value === content.slice(0, 50000).replace(/\r\n?/g, '\n'), 'textarea normalizes preview line endings; the attached file retains the original bytes');
  assert.match($('pastedTextDetails').textContent, /仅预览前 50,000/);
  assert.equal($('restorePastedText').disabled, true); assert.equal(document.querySelector('#pastedTextDialog script'), null);
  const draft = controller.snapshot(); controller.reset(); controller.restoreDraft(draft);
  assert.equal(controller.snapshot().files[0].pastedText, content);
  assert.deepEqual(controller.payload().attachments, [file.id]);
});

test('failed upload retains text, blocks sending and retries exactly on request; short attachment can be restored', async t => {
  let fail = true;
  const { $, controller, paste, settle, calls, input } = await setup(t, async (_, body) => {
    if (fail) throw new Error('连接暂时不可用');
    return { id: 'retry-file', name: body.name, kind: 'file' };
  });
  const content = '完整文本🙂'.repeat(1000);
  paste(content); await settle(() => !controller.uploading);
  assert.equal(controller.canSend, false); assert.equal(controller.snapshot().files[0].pastedText, content);
  assert.match(document.querySelector('.pasted-text-chip').textContent, /原文已保留/);
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(calls.length, 1);
  fail = false; document.querySelector('.pasted-text-retry').click(); await settle(() => !controller.uploading);
  assert.equal(calls.length, 2); assert.equal(calls[0].body.base64, calls[1].body.base64);
  assert.equal(controller.canSend, true); assert.match(controller.messageText(), /读取附加的完整长文本/);
  input('额外说明'); document.querySelector('.pasted-text-open').click(); $('restorePastedText').click();
  assert.equal($('prompt').value, '额外说明\n\n' + content);
  assert.deepEqual(controller.payload().attachments, []); assert.equal($('pastedTextDialog').open, false);
});

test('over-limit input and attachment quota keep text intact and offer explicit conversion', async t => {
  const { $, controller, paste, input, settle, notices } = await setup(t);
  assert.equal($('prompt').hasAttribute('maxlength'), false);
  const content = '长'.repeat(100001); input(content);
  assert.equal(controller.canSend, false); assert.equal($('promptTextWarning').hidden, false);
  assert.equal($('promptLength').dataset.over, 'true');
  $('convertPromptText').click(); input('转换时写下的新说明'); await settle(() => !controller.uploading);
  assert.equal(controller.snapshot().files[0].pastedText, content); assert.equal($('prompt').value, '转换时写下的新说明');
  controller.restoreDraft({ files: Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: 'file', kind: 'file' })) });
  input('before-after'); $('prompt').setSelectionRange(7, 7);
  paste(content); assert.equal($('prompt').value, 'before-' + content + 'after'); assert.equal(controller.canSend, false);
  assert.match(notices.at(-1), /最多添加 30/);
});

test('removed or switched drafts reject late uploads without resurrecting attachments', async t => {
  const pending = [];
  const { $, controller, paste, context, settle } = await setup(t, (_, body, options) => new Promise(resolve => pending.push({ resolve, body, signal: options.signal })));
  paste('first'.repeat(1000)); await settle(() => pending.length === 1);
  document.querySelector('.pasted-text-chip button[aria-label]').click();
  assert.equal(pending[0].signal.aborted, true); assert.equal(controller.uploading, false);
  pending[0].resolve({ id: 'removed', name: 'removed.txt', kind: 'file' }); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(controller.snapshot().files.length, 0);
  paste('second'.repeat(1000)); await settle(() => pending.length === 2);
  const draft = controller.snapshot(); controller.reset(); context.cwd = '/another-project';
  pending[1].resolve({ id: 'late', name: 'late.txt', kind: 'file' }); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal($('contextChips').children.length, 0);
  context.cwd = '/project'; controller.restoreDraft(draft);
  assert.equal(controller.snapshot().files[0].pastedText, 'second'.repeat(1000));
  assert.equal(controller.snapshot().files[0].pasteState, 'error');
  assert.equal(controller.canSend, false); assert.deepEqual(controller.payload().attachments, []);
});

test('oversized paste stays recoverable without uploading; independent pastes finish out of order safely', async t => {
  const pending = [];
  const { controller, paste, settle, calls } = await setup(t, (_, body) => new Promise(resolve => pending.push({ resolve, body })));
  const oversized = '大'.repeat(3500000); paste(oversized);
  assert.equal(calls.length, 0); assert.equal(controller.snapshot().files[0].pastedText, oversized);
  assert.equal(controller.canSend, false); assert.match(document.querySelector('.pasted-text-chip').textContent, /超过 10 MB/);
  controller.reset();
  paste('A'.repeat(5000)); paste('B'.repeat(5001)); await settle(() => pending.length === 2);
  pending[1].resolve({ id: 'second', name: pending[1].body.name, kind: 'file' });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(controller.canSend, false);
  pending[0].resolve({ id: 'first', name: pending[0].body.name, kind: 'file' }); await settle(() => !controller.uploading);
  assert.deepEqual(controller.payload().attachments, ['first', 'second']); assert.equal(controller.canSend, true);
});
