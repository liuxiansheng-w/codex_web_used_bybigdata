import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatLink, linkedThread, createChatNavigation } from '../public/chat-navigation.js';
import { createSlashCommands } from '../public/slash-commands.js';
import { createProjectList } from '../public/project-list.js';
import { ThreadMemories } from '../lib/thread-memories.mjs';
import { Workspace } from '../lib/workspace.mjs';

test('chat URLs contain only a validated thread id, and browser history respects rejected navigation', async () => {
  const dom = new JSDOM('', { url: 'http://localhost:4318/?appearance=dark' }), win = dom.window;
  let active = 'one', rejected = false;
  const nav = createChatNavigation({ win, current: () => active, notify: assert.fail, select: async id => { if (rejected) return false; active = id; return true; }, reset: () => { active = null; return true; } });
  assert.equal(nav.initial, undefined); nav.write('one'); nav.write('two');
  assert.equal(linkedThread(win.location.href), 'two'); assert.equal(new URL(win.location.href).searchParams.get('appearance'), 'dark');
  assert.equal(linkedThread('http://localhost/?thread=../../secret'), null); assert.throws(() => chatLink(win.location.href, '/private/secret'));
  rejected = true; win.history.replaceState({}, '', '/?thread=three'); win.dispatchEvent(new win.PopStateEvent('popstate')); await Promise.resolve(); await Promise.resolve();
  assert.equal(linkedThread(win.location.href), 'one'); assert.equal(active, 'one'); dom.window.close();
});

test('slash selector supports filtering, keyboard, dismissal and IME without submitting a prompt', async () => {
  const dom = new JSDOM('<form><textarea></textarea></form>'), win = dom.window, input = win.document.querySelector('textarea'), calls = [];
  createSlashCommands({ input, commands: [{ name: 'files', label: '文件', run: () => calls.push('files') }, { name: 'browser', label: '浏览器', run: () => calls.push('browser') }] });
  let submitted = 0; input.addEventListener('keydown', () => submitted++);
  const type = value => { input.value = value; input.dispatchEvent(new win.Event('input')); };
  const key = (value, props = {}) => input.dispatchEvent(new win.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...props }));
  type('/'); key('ArrowDown'); key('Enter'); await Promise.resolve();
  assert.deepEqual(calls, ['browser']); assert.equal(submitted, 0); assert.equal(input.value, '');
  type('/f'); key('Enter', { isComposing: true }); assert.deepEqual(calls, ['browser']);
  key('Escape'); assert.equal(win.document.querySelector('[role=listbox]').hidden, true); key('Enter'); assert.equal(input.value, '/f');
  type('/files/path.sql'); assert.equal(win.document.querySelector('[role=listbox]').hidden, true);
  type('/unknown'); assert.equal(win.document.querySelector('[role=listbox]').hidden, true); dom.window.close();
});

test('project sorting preserves drafts and newer local order when an earlier server load finishes', async t => {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/' });
  const win = dom.window, originals = { document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage };
  Object.assign(globalThis, { document: win.document, window: win, localStorage: win.localStorage }); t.after(() => { Object.assign(globalThis, originals); win.close(); });
  win.localStorage.setItem('codex-desk:projects', JSON.stringify(['/a', '/b'])); let resolve, selected = 0; const saves = [];
  const list = createProjectList({ api: assert.fail, onSelect: () => selected++, getContext: () => ({ cwd: '/a' }), getTabs: () => [{ cwd: '/a', dirty: true }], notice: assert.fail, remote: { load: () => new Promise(done => { resolve = done; }), save: async value => saves.push(value) } });
  const handle = win.document.querySelector('.project-drag[data-cwd="/b"]'); handle.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(list.list(), ['/b', '/a']); assert.equal(selected, 0); assert.match(win.document.getElementById('projectList').textContent, /1 个文件未保存/);
  resolve({ projects: ['/a', '/b', '/c'] }); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(list.list(), ['/b', '/a', '/c']); assert.deepEqual(JSON.parse(win.localStorage.getItem('codex-desk:projects')), ['/b', '/a', '/c']);
});

test('per-chat memory overrides are versioned, capped by global settings, and do not edit global config', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'lemon-thread-memory-')); let enabled = true; const applied = [];
  const memories = new ThreadMemories(stateDir, { snapshot: async () => ({ settings: { enabled, use: true, generate: true } }) });
  assert.deepEqual(await memories.config('a'), {});
  let result = await memories.update({ threadId: 'a', revision: 0, use: false, contribute: true }, async settings => applied.push(settings));
  assert.deepEqual(result.effective, { use: false, contribute: true }); assert.equal((await memories.read('b')).use, null);
  await assert.rejects(memories.update({ threadId: 'a', revision: 0, use: true, contribute: true }, assert.fail), /其他页面/);
  enabled = false; result = await memories.status('a'); assert.deepEqual(result.effective, { use: false, contribute: false });
  assert.deepEqual(await memories.config('a'), { 'memories.use_memories': false, 'memories.generate_memories': false }); assert.equal(applied.length, 1);
  const modes = []; await memories.refreshContribution('a', async value => modes.push(value)); assert.deepEqual(modes, [false]); enabled = true; await memories.refreshContribution('a', async value => modes.push(value)); assert.deepEqual(modes, [false, true]); await memories.refreshContribution('a', async value => modes.push(value)); assert.equal(modes.length, 2, 'unchanged policy must not override native exclusion repeatedly');
});

test('conversation path uses native metadata and refuses guessed or relative paths', async () => {
  const bridge = new EventEmitter(); let file = '/private/tmp/native-rollout.jsonl'; const calls = [];
  bridge.request = async (method, params) => { calls.push({ method, params }); return { thread: { id: params.threadId, path: file } }; };
  const workspace = new Workspace(bridge, '/private/tmp'); assert.equal((await workspace.conversationPath('a')).path, file);
  assert.deepEqual(calls[0], { method: 'thread/read', params: { threadId: 'a', includeTurns: false } });
  file = 'relative.jsonl'; await assert.rejects(workspace.conversationPath('a'), /尚无可用/); await assert.rejects(workspace.conversationPath('../a'), /编号无效/);
});
