import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createGitSubmit } from '../public/git-submit.js';
const wait = () => new Promise(resolve => setTimeout(resolve, 5));
test('Git dialog can read another sidebar project without switching context or mixing drafts', async t => {
  const dom = new JSDOM('<div class="breadcrumb"></div>', { url: 'http://localhost' });
  const old = { window: globalThis.window, document: globalThis.document }; Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  t.after(() => { Object.assign(globalThis, old); dom.window.close(); });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  const reads = [];
  const control = createGitSubmit({ getContext: () => ({ cwd: '/active' }), api: async (route, body) => {
    assert.equal(body, undefined); const cwd = new URL(route, 'http://localhost').searchParams.get('cwd'); reads.push(cwd);
    return { cwd, files: [], head: 'head', branch: 'main', ahead: 0 };
  } });
  await control.show();
  const message = document.querySelector('[data-ui=message]'); message.value = 'Active project note'; message.dispatchEvent(new window.Event('input'));
  await control.show('/other'); assert.equal(message.value, ''); assert.equal(document.querySelector('[data-ui=project]').textContent, '/other');
  message.value = 'Other project note'; message.dispatchEvent(new window.Event('input'));
  await control.show(); assert.equal(message.value, 'Active project note');
  assert.deepEqual(reads, ['/active', '/other', '/active']);
});

test('project menu opens Git dialog, safely previews, preserves failed drafts and retries push separately', async t => {
  const dom = new JSDOM('<div class="breadcrumb"><span>project</span></div>', { url: 'http://localhost' });
  const old = { window: globalThis.window, document: globalThis.document }; Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  t.after(() => { Object.assign(globalThis, old); dom.window.close(); });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')); };
  let confirmed = false; dom.window.confirm = () => confirmed;
  const state = { cwd: '/test', head: 'abc12345', version: 'v1', branch: 'main', tracking: 'origin/main', ahead: 0, behind: 0, blocked: '', pushBlocked: '', files: [{ path: '<img onerror=x>.txt', status: ' M' }] }, calls = [];
  let failing = true;
  const control = createGitSubmit({ getContext: () => ({ cwd: '/test' }), api: async (url, body) => {
    if (!body) return url.includes('/diff?') ? { diff: '+<img onerror=x>' } : structuredClone(state);
    calls.push(body); if (failing) throw Object.assign(new Error('state changed'), { status: 409 });
    if (body.action === 'push') return { pushed: true, committed: false, commit: state.head };
    state.files = []; state.ahead = 1; state.head = 'new12345'; state.version = 'v2';
    return { committed: true, pushed: false, commit: state.head, pushError: 'network failed' };
  } });
  const $ = name => document.querySelector(`[data-ui="${name}"]`);
  assert.equal(document.querySelector('.project-actions-menu').parentElement.className, 'breadcrumb');
  await control.show(); assert.equal(document.getElementById('gitSubmitDialog').open, true);
  $('files').querySelector('button').click(); await wait(); assert.equal($('diff').querySelector('img'), null); assert.match($('diff').textContent, /<img/);
  $('all').click(); $('message').value = 'my note'; $('message').dispatchEvent(new window.Event('input'));
  $('commit-push').click(); await wait(); assert.equal(calls.length, 0);
  confirmed = true; $('commit-push').click(); await wait(); assert.equal($('message').value, 'my note'); assert.equal($('files').querySelector('input').checked, true); assert.match($('status').textContent, /state changed/);
  failing = false; $('commit-push').click(); await wait(); await wait(); assert.equal($('message').value, ''); assert.match($('status').textContent, /本地已提交.*network failed/);
  $('push').click(); await wait(); assert.equal(calls.at(-1).action, 'push'); assert.equal(calls.at(-1).head, 'new12345'); assert.match($('status').textContent, /推送成功/);
});
