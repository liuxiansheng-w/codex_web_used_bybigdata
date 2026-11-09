import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { JSDOM } from 'jsdom';
import { ProjectFiles } from '../lib/project-files.mjs';
import { createFileTree } from '../public/file-tree.js';

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-web-tree-refresh-')));
  const cwd = path.join(base, 'project'); await mkdir(cwd);
  return { base, cwd, files: new ProjectFiles() };
}

test('directory versions detect external creation, rename and removal, with independent nested versions', async () => {
  const { base, cwd, files } = await fixture(); await mkdir(path.join(cwd, 'nested'));
  const root = await files.list({ cwd }), initial = await files.list({ cwd, path: 'nested' });
  assert.match(initial.version, /^[a-f0-9]{64}$/);
  assert.equal((await files.list({ cwd, path: 'nested', ifVersion: initial.version })).unchanged, true);
  await writeFile(path.join(cwd, 'nested/new.txt'), 'fixture');
  assert.equal((await files.list({ cwd, ifVersion: root.version })).unchanged, true);
  const created = await files.list({ cwd, path: 'nested', ifVersion: initial.version });
  assert.deepEqual(created.entries.map(entry => entry.name), ['new.txt']);
  await rename(path.join(cwd, 'nested/new.txt'), path.join(cwd, 'nested/renamed.txt'));
  const renamed = await files.list({ cwd, path: 'nested', ifVersion: created.version });
  assert.deepEqual(renamed.entries.map(entry => entry.name), ['renamed.txt']);
  await rename(path.join(cwd, 'nested/renamed.txt'), path.join(base, 'removed.txt'));
  assert.deepEqual((await files.list({ cwd, path: 'nested', ifVersion: renamed.version })).entries, []);
});

test('directory version hits preserve visibility, pagination and path protections', async () => {
  const { base, cwd, files } = await fixture();
  await writeFile(path.join(cwd, '.visible-hidden.txt'), 'fixture'); await writeFile(path.join(cwd, '.env'), 'fictional secret');
  await Promise.all(Array.from({ length: 215 }, (_, index) => writeFile(path.join(cwd, `file-${String(index).padStart(3, '0')}.txt`), 'fixture')));
  const first = await files.list({ cwd }); assert.equal(first.entries.length, 200);
  const second = await files.list({ cwd, offset: 200, ifVersion: first.version });
  assert.equal(second.unchanged, undefined); assert.equal(second.entries.length, 15); assert.equal(second.version, first.version);
  const shown = await files.list({ cwd, showHidden: true, ifVersion: first.version });
  assert.equal(shown.unchanged, undefined);
  assert.ok(shown.entries.some(entry => entry.name === '.visible-hidden.txt'));
  assert.ok(!shown.entries.some(entry => entry.name === '.env'));
  await mkdir(path.join(base, 'outside')); await symlink(path.join(base, 'outside'), path.join(cwd, 'link'));
  for (const relative of ['../outside', 'link', '.env']) await assert.rejects(files.list({ cwd, path: relative, ifVersion: first.version }));
});

async function setup(t, { paged = false, legacy = false } = {}) {
  const f = await fixture();
  await mkdir(path.join(f.cwd, 'src/nested'), { recursive: true });
  await mkdir(path.join(f.cwd, 'other')); await mkdir(path.join(f.cwd, 'untouched/child'), { recursive: true });
  await writeFile(path.join(f.cwd, 'original.txt'), 'root fixture');
  await writeFile(path.join(f.cwd, 'src/nested/original.txt'), 'nested fixture');
  if (paged) {
    await mkdir(path.join(f.cwd, 'many'));
    await Promise.all(Array.from({ length: 215 }, (_, index) => writeFile(path.join(f.cwd, 'many', `file-${String(index).padStart(3, '0')}.txt`), 'fixture')));
  }
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { pretendToBeVisual: true, url: 'http://localhost/' });
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); globalThis.document = previous; });
  const $ = id => document.getElementById(id), calls = [];
  let poll, hidden = false, visible = true, hook = async () => {};
  dom.window.setInterval = (fn, ms) => { assert.equal(ms, 2000); poll = fn; return 1; };
  dom.window.clearInterval = () => {};
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  $('projectFileTree').getClientRects = () => visible ? [{}] : [];
  const api = async route => {
    const url = new URL(route, 'http://localhost');
    assert.equal(url.pathname, '/api/project/files', 'refresh must not invoke model, SQL, search or write APIs');
    const request = { cwd: url.searchParams.get('cwd'), path: url.searchParams.get('path') || '', offset: Number(url.searchParams.get('offset')), showHidden: url.searchParams.get('showHidden') === '1', ifVersion: legacy ? '' : url.searchParams.get('ifVersion') || '' };
    calls.push(request); await hook(request);
    const result = await f.files.list(request);
    if (legacy) delete result.version;
    return result;
  };
  const tree = createFileTree({ api, onOpen() {}, onAttach() {}, hasAttachment: () => false, notice: message => assert.fail(message) });
  const until = async predicate => { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) assert.fail('file tree did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); } };
  const leaf = relative => document.querySelector(`[data-file-path="${relative}"]`);
  const folder = relative => document.querySelector(`[data-focus-key="${encodeURIComponent(relative)}"]`);
  tree.setProject(f.cwd); await until(() => leaf('original.txt'));
  $('prompt').value = 'keep chat draft'; $('fileEditorText').value = 'keep editor draft';
  return { ...f, tree, $, calls, poll: () => poll(), until, leaf, folder, window: dom.window,
    setHidden: value => { hidden = value; }, setVisible: value => { visible = value; }, setHook: value => { hook = value; } };
}

test('visible tree synchronizes nested external changes without stealing focus, drafts or expanded folders', async t => {
  const f = await setup(t);
  await f.tree.setActive({ cwd: f.cwd, path: 'src/nested/original.txt' });
  f.folder('other').click(); await f.poll();
  f.$('fileEditorText').focus();
  await writeFile(path.join(f.cwd, 'src/nested/new.txt'), 'fixture'); await f.poll();
  assert.ok(f.leaf('src/nested/new.txt')); assert.equal(document.activeElement, f.$('fileEditorText'));
  assert.equal(f.$('prompt').value, 'keep chat draft'); assert.equal(f.$('fileEditorText').value, 'keep editor draft');
  assert.equal(f.folder('other').getAttribute('aria-expanded'), 'true');
  assert.equal(f.leaf('src/nested/original.txt').getAttribute('aria-current'), 'true');
  await rename(path.join(f.cwd, 'src/nested/new.txt'), path.join(f.cwd, 'src/nested/renamed.txt')); await f.poll();
  assert.equal(f.leaf('src/nested/new.txt'), null); assert.ok(f.leaf('src/nested/renamed.txt'));
  await rename(path.join(f.cwd, 'src/nested/renamed.txt'), path.join(f.base, 'removed.txt')); await f.poll();
  assert.equal(f.leaf('src/nested/renamed.txt'), null);
  assert.ok(!f.calls.some(request => request.path.startsWith('untouched')));
  const node = f.leaf('src/nested/original.txt'); await f.poll(); assert.equal(f.leaf('src/nested/original.txt'), node);
  assert.ok(f.calls.some(request => request.ifVersion));
});

test('manual refresh and cached-folder reopening preserve expanded paths instead of collapsing the tree', async t => {
  const f = await setup(t); await f.tree.setActive({ cwd: f.cwd, path: 'src/nested/original.txt' });
  f.folder('other').click(); await f.poll();
  await mkdir(path.join(f.cwd, 'src/nested/new-folder'));
  f.$('refreshFiles').click(); await f.until(() => f.folder('src/nested/new-folder'));
  assert.equal(f.folder('other').getAttribute('aria-expanded'), 'true');
  f.folder('src').click(); await writeFile(path.join(f.cwd, 'src/nested/collapsed.txt'), 'fixture');
  f.folder('src').click(); await f.until(() => f.leaf('src/nested/collapsed.txt'));
  assert.equal(f.folder('src/nested').getAttribute('aria-expanded'), 'true');
});

test('auto-refresh pauses for hidden panels and filename searches, then checks on focus and visibility', async t => {
  const f = await setup(t), initial = f.calls.length;
  f.setHidden(true); await f.poll(); assert.equal(f.calls.length, initial);
  f.setHidden(false); f.setVisible(false); await f.poll(); assert.equal(f.calls.length, initial);
  f.setVisible(true); f.$('fileSearch').value = 'original'; await f.poll(); assert.equal(f.calls.length, initial);
  f.$('fileSearch').value = '';
  await writeFile(path.join(f.cwd, 'focus.txt'), 'fixture'); f.window.dispatchEvent(new f.window.Event('focus'));
  await f.until(() => f.leaf('focus.txt'));
  await writeFile(path.join(f.cwd, 'visible.txt'), 'fixture'); document.dispatchEvent(new f.window.Event('visibilitychange'));
  await f.until(() => f.leaf('visible.txt'));
  f.window.dispatchEvent(new f.window.Event('pagehide'));
  await writeFile(path.join(f.cwd, 'restored-page.txt'), 'fixture');
  f.window.dispatchEvent(new f.window.Event('pageshow')); await f.until(() => f.leaf('restored-page.txt'));
});

test('auto-refresh rebuilds every previously loaded page and preserves scroll and keyboard focus', async t => {
  const f = await setup(t, { paged: true }); await f.tree.setActive({ cwd: f.cwd, path: 'many/file-214.txt' });
  const viewport = f.$('projectFileTree').parentElement; viewport.scrollTop = 83; viewport.scrollLeft = 7;
  f.leaf('many/file-214.txt').focus();
  await writeFile(path.join(f.cwd, 'many/aaa-new.txt'), 'fixture'); await f.poll();
  assert.ok(f.leaf('many/aaa-new.txt')); assert.ok(f.leaf('many/file-214.txt'));
  assert.equal(document.querySelector('ul[aria-label="many"]').querySelectorAll('.file-leaf').length, 216);
  assert.equal(viewport.scrollTop, 83); assert.equal(viewport.scrollLeft, 7);
  assert.equal(document.activeElement, f.leaf('many/file-214.txt'));
});

test('failed refresh preserves visible files and recovers; late reads cannot leak into a different project', async t => {
  const f = await setup(t); await f.tree.setActive({ cwd: f.cwd, path: 'src/nested/original.txt' });
  f.setHook(async request => { if (request.path === 'src/nested') throw new Error('fixture permission error'); });
  await f.poll(); assert.ok(f.leaf('src/nested/original.txt')); assert.match(f.$('projectFileTree').textContent, /fixture permission error/);
  f.setHook(async () => {}); await f.poll(); assert.doesNotMatch(f.$('projectFileTree').textContent, /fixture permission error/);
  let release;
  f.setHook(async request => { if (request.path === 'src/nested') await new Promise(resolve => { release = resolve; }); });
  const pending = f.poll(); await f.until(() => release);
  const other = path.join(f.base, 'second'); await mkdir(other); await writeFile(path.join(other, 'second.txt'), 'fixture');
  f.tree.setProject(other); await f.until(() => f.leaf('second.txt')); release(); await pending;
  assert.ok(f.leaf('second.txt')); assert.equal(f.leaf('src/nested/original.txt'), null);
});

test('new frontend remains compatible with an older running backend without directory versions', async t => {
  const f = await setup(t, { legacy: true }); await f.tree.setActive({ cwd: f.cwd, path: 'src/nested/original.txt' });
  await writeFile(path.join(f.cwd, 'src/nested/legacy.txt'), 'fixture'); await f.poll();
  assert.ok(f.leaf('src/nested/legacy.txt'));
  const node = f.leaf('src/nested/legacy.txt'); await f.poll(); assert.equal(f.leaf('src/nested/legacy.txt'), node);
});
