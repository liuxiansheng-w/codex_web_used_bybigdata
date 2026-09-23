import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createFileTree } from '../public/file-tree.js';
const entry = (path, kind = 'file') => ({ path, name: path.split('/').at(-1), kind });
async function setup(t, respond) {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { pretendToBeVisual: true });
  const previous = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { dom.window.close(); globalThis.document = previous; });
  const calls = [], tree = createFileTree({ api: async route => {
    const url = new URL(route, 'http://localhost'), request = { cwd: url.searchParams.get('cwd'), path: url.searchParams.get('path') || '', offset: Number(url.searchParams.get('offset')) };
    calls.push(request); return respond(request);
  }, onOpen() {}, onAttach() {}, hasAttachment: () => false, notice: text => assert.fail(text) });
  const $ = id => document.getElementById(id), current = () => document.querySelector('.file-main[aria-current=true]')?.dataset.filePath;
  const until = async fn => { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(setImmediate); } assert.fail('reveal did not settle'); };
  return { tree, $, calls, current, until, window: dom.window };
}

test('active file reveal pages only its ancestors and preserves editor focus, search intent and manual collapse', async t => {
  const file = 'QSC/保险 报表/订单.sql';
  const { tree, $, calls, current, window } = await setup(t, async ({ path, offset }) => {
    if (!path) return { entries: offset ? [entry('QSC', 'folder')] : [entry('unrelated', 'folder')], nextOffset: offset ? null : 200 };
    if (path === 'QSC') return { entries: [entry('QSC/保险 报表', 'folder')], nextOffset: null };
    if (path === 'QSC/保险 报表') return { entries: [entry(file)], nextOffset: null };
    assert.fail('must not traverse unrelated directories');
  });
  tree.setProject('/project'); $('prompt').value = '草稿'; $('prompt').focus();
  assert.equal(await tree.setActive({ cwd: '/project', path: file }), true);
  assert.equal(current(), file); assert.equal(document.activeElement, $('prompt'));
  assert.deepEqual(calls.map(({path,offset}) => [path,offset]), [['',0],['',200],['QSC',0],['QSC/保险 报表',0]]);
  assert.equal(document.querySelectorAll('.file-main[aria-expanded=true]').length, 2);
  $('collapseFiles').click(); const count = calls.length;
  await tree.setActive({ cwd: '/project', path: file });
  assert.equal(document.querySelectorAll('.file-main[aria-expanded=true]').length, 0);
  assert.equal(calls.length, count, 'unchanged file edits must not reopen manually collapsed directories');
  await tree.setActive({ cwd: '/project', path: file }, {force: true}); assert.equal(current(), file);
  $('fileSearch').value = 'not this file';
  await tree.setActive({ cwd: '/project', path: file }); assert.equal($('fileSearch').value, 'not this file');
  await tree.setActive({ cwd: '/project', path: file }, {force: true}); assert.equal($('fileSearch').value, '');
  assert.equal(calls.length, count, 'revealing cached paths must not refetch every directory');
});

test('late directory responses cannot reselect an old file or leak across projects', async t => {
  let release;
  const { tree, calls, current, until } = await setup(t, async ({cwd, path}) => {
    if (cwd === '/two') return { entries: [entry('new.sql')], nextOffset: null };
    if (!path) return { entries: [entry('slow', 'folder'), entry('b.sql')], nextOffset: null };
    if (path === 'slow') return new Promise(resolve => { release = () => resolve({ entries: [entry('slow/a.sql')], nextOffset: null }); });
    assert.fail(path);
  });
  tree.setProject('/one'); const old = tree.setActive({cwd:'/one',path:'slow/a.sql'}); await until(() => release);
  await tree.setActive({cwd:'/one',path:'b.sql'}); assert.equal(current(),'b.sql');
  tree.setProject('/two'); await tree.setActive({cwd:'/two',path:'new.sql'});
  release(); await old; assert.equal(current(),'new.sql');
  assert.equal(document.querySelector('[data-file-path="slow/a.sql"]'),null);
  assert.equal(calls.filter(call=>call.path==='slow').length,1);
});

test('reveal refreshes a stale parent once for a newly created file and fails without inventing hidden files', async t => {
  let entries = [entry('old.sql')];
  const { tree, $, calls, current, until } = await setup(t, async () => ({ entries, nextOffset: null }));
  tree.setProject('/project'); await until(() => $('projectFileTree').textContent.includes('old.sql'));
  entries = [...entries,entry('new.sql')];
  await tree.setActive({cwd:'/project',path:'new.sql'}); assert.equal(current(),'new.sql'); assert.equal(calls.length,2);
  assert.equal(await tree.setActive({cwd:'/project',path:'missing.sql'}),false);
  assert.match($('projectFileTree').textContent,/定位文件失败/); assert.equal(current(),undefined);
  assert.equal(document.querySelector('[data-file-path="missing.sql"]'),null);
});
