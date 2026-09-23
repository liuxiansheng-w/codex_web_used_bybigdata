import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ImagePreviews, userMessageContent } from '../lib/image-previews.mjs';
import { ContextStore, attachmentInput } from '../lib/context.mjs';
import { Workspace } from '../lib/workspace.mjs';
import { createApplication } from '../server.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5L0AAAAASUVORK5CYII=', 'base64');
const idOf = attachment => attachment.previewUrl.split('/').at(-1);
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ningmeng-images-'));
  const filename = path.join(cwd, '截图 image.png'); await writeFile(filename, png);
  return { cwd, filename };
}

test('uploads expose authenticated opaque previews while the model still receives the native image', async () => {
  const context = new ContextStore();
  const uploaded = await context.upload({ name: '截图.png', base64: png.toString('base64') });
  assert.equal(uploaded.kind, 'image'); assert.match(uploaded.previewUrl, /^\/api\/attachments\/images\/[0-9a-f-]{36}$/);
  assert.equal(uploaded.path, undefined); assert.doesNotMatch(JSON.stringify(uploaded), /base64|\/private\/|\/var\//);
  const file = context.resolve([uploaded.id])[0];
  assert.equal(attachmentInput([file])[1].type, 'localImage');
  const image = await context.images.read(idOf(uploaded));
  assert.equal(image.contentType, 'image/png'); assert.deepEqual(image.bytes, png);
});

test('image wrapper cleanup preserves the prompt, original name, ordinary text and non-image attachment instructions', () => {
  const images = new ImagePreviews(), file = { kind: 'image', name: '截图 "v2".png', path: '/private/tmp/photo.png' };
  const input = attachmentInput([file]);
  for (const content of [
    [{ type: 'text', text: '看一下这些字段' }, ...input],
    [{ type: 'text', text: `看一下这些字段\n${input[0].text}` }, input[1]],
  ]) {
    const result = userMessageContent(content, images);
    assert.equal(result.text, '看一下这些字段'); assert.equal(result.attachments[0].name, file.name);
    assert.doesNotMatch(JSON.stringify(result), /本机路径|\/private\/tmp|base64/);
  }
  const ordinary = '本机路径只是说明，不应删除。\n用户附加的文件："other.txt"\n本机路径："/tmp/other.txt"';
  assert.equal(userMessageContent([{ type: 'text', text: ordinary }, input[1]], images).text, ordinary);
  assert.equal(userMessageContent([input[1]], images).text, '');
});

test('fresh history imports and live image events restore previews without requiring the original upload registry', async t => {
  const { filename } = await fixture(); const bridge = new EventEmitter();
  const workspace = new Workspace(bridge, '/private/tmp');
  t.after(() => { for (const timer of workspace.timers.values()) clearTimeout(timer); });
  const content = [{ type: 'text', text: '历史截图' }, ...attachmentInput([{ kind: 'image', name: '原图.png', path: filename }])];
  const thread = workspace.importThread({ id: 'history', turns: [{ id: 'turn', status: 'completed', items: [{ id: 'message', type: 'userMessage', content }] }] });
  assert.equal(thread.items[0].text, '历史截图');
  const attachment = thread.items[0].attachments[0];
  assert.equal(attachment.name, '原图.png'); assert.deepEqual((await workspace.context.images.read(idOf(attachment))).bytes, png);
  bridge.emit('notification', { method: 'item/completed', params: { threadId: thread.id, item: { id: 'live', type: 'userMessage', content } } });
  assert.equal(thread.items[1].attachments[0].previewUrl, attachment.previewUrl);
});

test('previews validate image bytes, bound file reads, and fail clearly for missing files or unsupported remote images', async () => {
  const { cwd, filename } = await fixture(); const images = new ImagePreviews();
  const data = images.describe({ type: 'image', url: `data:image/png;base64,${png.toString('base64')}` });
  assert.deepEqual((await images.read(idOf(data))).bytes, png);
  for (const url of ['https://untrusted.example/tracking.png', 'file:///etc/hosts', 'data:image/svg+xml;base64,PHN2Zz4=']) assert.equal(images.describe({ type: 'image', url }).previewUrl, undefined);
  await assert.rejects(images.read('unknown'), { status: 404 });
  const missing = images.describe({ type: 'localImage', path: path.join(cwd, 'missing.png') });
  await assert.rejects(images.read(idOf(missing)), { status: 404 });
  await writeFile(filename, '<svg onload="alert(1)"></svg>');
  const fake = images.describe({ type: 'localImage', path: filename });
  await assert.rejects(images.read(idOf(fake)), { status: 415 });
  await writeFile(filename, Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(images.read(idOf(fake)), { status: 413 });
  const folder = path.join(cwd, 'directory.png'); await mkdir(folder);
  await assert.rejects(images.read(idOf(images.describe({ type: 'localImage', path: folder }))), { status: 404 });
});

test('image HTTP routes require the existing session and reject cross-site reads and arbitrary filesystem paths', async t => {
  class Mock extends EventEmitter {
    ready = true; async start() {} close() {}
    async request(method) {
      if (method === 'account/read') return { requiresOpenaiAuth: false };
      if (method === 'model/list') return { data: [] };
      if (method === 'configRequirements/read') return { requirements: null };
      throw new Error(`Unexpected ${method}`);
    }
  }
  const { cwd, filename } = await fixture();
  const app = createApplication({ bridge: new Mock(), cwd }); await app.start(0); t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const root = await fetch(base), cookie = root.headers.get('set-cookie').split(';')[0];
  const boot = await (await fetch(base + '/api/bootstrap', { headers: { cookie } })).json();
  const headers = { cookie, origin: base, 'content-type': 'application/json', 'x-codex-csrf': boot.csrf };
  const upload = await fetch(base + '/api/attachments/upload', { method: 'POST', headers, body: JSON.stringify({ name: '截图.png', base64: png.toString('base64') }) });
  assert.equal(upload.status, 200); const image = await upload.json();
  app.bridge.ready = false; // Viewing an existing attachment does not require the model connection.
  assert.equal((await fetch(base + image.previewUrl)).status, 401);
  assert.equal((await fetch(base + image.previewUrl, { headers: { cookie, origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + image.previewUrl, { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 403);
  const response = await fetch(base + image.previewUrl, { headers: { cookie } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal((await fetch(base + '/api/attachments/images/00000000-0000-0000-0000-000000000000', { headers: { cookie } })).status, 404);
  app.bridge.ready = true;
  assert.equal((await fetch(base + '/api/attachments/images?path=' + encodeURIComponent(filename), { headers: { cookie } })).status, 404);
});
