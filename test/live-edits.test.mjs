import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { highlightFileLines } from '../public/vendor/markdown/document.js';
import { createLiveEdits, highlightPatchRows } from '../public/live-edits.js';
import { fileChangeLines } from '../public/execution-view.js';

test('file preview highlights common languages, balances multiline spans and keeps source inert', () => {
  const dom = new JSDOM('<body></body>'), { document } = dom.window;
  for (const [path, source, token] of [
    ['query.SQL', "SELECT 12, '示例' FROM demo; -- 注释", '.hljs-keyword'],
    ['task.py', 'def show():\n    """first\n    second"""\n    return 12', '.hljs-string'],
    ['view.mjs', 'export function show() {\n  return "<script>inert</script>";\n}', '.hljs-keyword'],
    ['view.ts', 'const count: number = 12;', '.hljs-keyword'],
    ['view.css', '.preview { color: red; }', '.hljs-selector-class'],
    ['data.json', '{"count":12}', '.hljs-attr'],
    ['view.html', '<img src=x onerror="bad()">', '.hljs-name'],
  ]) {
    const result = highlightFileLines(source, path), rows = result.lines.map(line => {
      const row = document.createElement('div'); row.innerHTML = line; return row;
    });
    assert.equal(rows.map(row => row.textContent).join('\n'), source, path);
    assert.ok(rows.some(row => row.querySelector(token)), path);
    assert.equal(rows.some(row => row.querySelector('img,script,iframe,[onerror]')), false, path);
  }
  const comment = highlightFileLines('/* start\nstill comment\n*/\nconst x = 2;', 'a.js');
  const row = document.createElement('div'); row.innerHTML = comment.lines[1];
  assert.equal(row.querySelector('.hljs-comment').textContent, 'still comment');
  assert.equal(highlightFileLines('<script>literal</script>', 'notes.txt').lines[0], '&lt;script&gt;literal&lt;/script&gt;');
  const long = highlightFileLines('x'.repeat(100001), 'a.js'); assert.equal(long.limited, true); assert.equal(long.lines[0].length, 100001);
  dom.window.close();
});

test('diff highlighting separates old/new multiline state and resets across hunk gaps', () => {
  const rows = fileChangeLines('@@ -1,3 +1,3 @@\n-/* old comment\n+const title = "new";\n unchanged\n-*/\n+return 2;\n@@ -90,0 +90,1 @@\n+const next = 3;').rows;
  const { html } = highlightPatchRows(rows, 'a.js'), dom = new JSDOM('<body></body>');
  const rendered = rows.map((row, index) => {
    const el = dom.window.document.createElement('div'); el.innerHTML = html.get(index) || ''; return el;
  });
  assert.equal(rendered[2].querySelector('.hljs-keyword')?.textContent, 'const');
  assert.equal(rendered[5].querySelector('.hljs-keyword')?.textContent, 'return');
  assert.equal(rendered.at(-1).querySelector('.hljs-keyword')?.textContent, 'const');
  dom.window.close();
});

test('long streamed previews stick to the bottom on first display, append, tab choice and resize; manual reading pauses', async t => {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { pretendToBeVisual: true });
  const saved = { window: globalThis.window, document: globalThis.document };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  t.after(() => { Object.assign(globalThis, saved); dom.window.close(); });
  const $ = id => dom.window.document.getElementById(id), body = $('liveEditsBody');
  let top = 0, height = 150, resize;
  dom.window.ResizeObserver = class { constructor(fn) { resize = fn; } observe() {} };
  Object.defineProperties(body, {
    clientHeight: { get: () => height },
    scrollHeight: { get: () => $('liveEditsLines').children.length * 22 },
    scrollTop: { get: () => top, set: value => { top = Math.max(0, Math.min(value, body.scrollHeight - height)); } },
  });
  const item = { id: 'edit', type: 'fileChange', turnId: 'turn', status: 'inProgress', changes: [] };
  const thread = { id: 'demo', cwd: '/project', turnId: 'turn', busy: true, items: [item], requests: [] };
  const preview = createLiveEdits({ storage: { getItem: () => 'true', setItem() {} }, getContext: () => ({ thread, live: true }) });
  const patch = (path, count) => ({ path, kind: 'add', diff: `@@ -0,0 +1,${count} @@\n` + Array.from({ length: count }, (_, index) => `+SELECT ${index}, 'demo';`).join('\n') });
  const bottom = () => body.scrollHeight - height;
  item.changes = [patch('a.sql', 80)]; preview.sync();
  assert.equal(top, bottom()); assert.ok(top > 0); assert.ok($('liveEditsLines').querySelector('.hljs-keyword'));
  item.changes[0] = patch('a.sql', 90); preview.sync(); assert.equal(top, bottom());
  body.scrollTop -= 120; body.dispatchEvent(new dom.window.Event('scroll'));
  const reading = top; assert.equal($('liveEditsScroll').getAttribute('aria-pressed'), 'false');
  item.changes = [patch('a.sql', 100), patch('b.sql', 70)]; preview.sync();
  assert.equal(top, reading); assert.equal($('liveEditsTabs').querySelector('[aria-selected=true]').textContent, 'a.sql');
  $('liveEditsScroll').click(); assert.equal(top, bottom());
  item.changes[1] = patch('b.sql', 85); preview.sync();
  assert.equal($('liveEditsTabs').querySelector('[aria-selected=true]').textContent, 'b.sql'); assert.equal(top, bottom());
  $('liveEditsTabs').querySelector('[role=tab]').click();
  assert.equal($('liveEditsFollow').getAttribute('aria-pressed'), 'false'); assert.equal($('liveEditsScroll').getAttribute('aria-pressed'), 'true'); assert.equal(top, bottom());
  item.changes[0] = patch('a.sql', 110); preview.sync(); assert.equal(top, bottom());
  height = 90; resize(); assert.equal(top, bottom());
  const text = $('liveEditsLines').querySelector('.hljs-keyword'), range = dom.window.document.createRange(); range.selectNodeContents(text); dom.window.getSelection().addRange(range);
  const beforeSelection = top; item.changes[0] = patch('a.sql', 120); preview.sync();
  assert.equal(top, beforeSelection); assert.equal(dom.window.getSelection().toString(), 'SELECT');
  dom.window.getSelection().removeAllRanges(); dom.window.document.dispatchEvent(new dom.window.Event('selectionchange')); assert.equal(top, bottom());
  body.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -100 })); const wheelTop = top;
  item.changes[0] = patch('a.sql', 130); preview.sync(); assert.equal(top, wheelTop); assert.equal($('liveEditsScroll').getAttribute('aria-pressed'), 'false');
  body.scrollTop = body.scrollHeight; body.dispatchEvent(new dom.window.Event('scroll')); assert.equal($('liveEditsScroll').getAttribute('aria-pressed'), 'true');
  item.changes[0] = patch('a.sql', 140); preview.sync(); assert.equal(top, bottom());
});

test('directory reveals the active path, preserves disclosures and distinguishes same-name, hidden and moved files', async t => {
  const { $, document, item, thread, preview, file, treeFile, tab } = await directoryPreview(t);
  item.changes = [file('/project/src/view.js'), file('/project/test/view.js')]; preview.sync();
  assert.equal($('liveEditsProject').textContent, 'project'); assert.equal($('liveEditsProject').title, '/project');
  assert.equal(treeFile('/project/test/view.js').getAttribute('aria-current'), 'true');
  const folder = treeFile('/project/src/view.js').closest('details'), sibling = treeFile('/project/test/view.js');
  folder.open = false; item.changes[1].diff += '\n+const second = 2;'; preview.sync();
  assert.equal(folder.open, false, 'streaming does not reopen a manually collapsed folder');
  assert.equal(treeFile('/project/test/view.js'), sibling, 'directory nodes survive patch updates');
  tab('src/view.js').click(); assert.equal(folder.open, true); assert.equal(treeFile('/project/src/view.js').getAttribute('aria-current'), 'true');
  item.changes.push(file('/project/.config/theme.js'), file('/elsewhere/view.js')); preview.sync();
  assert.equal(treeFile('/project/test/view.js'), sibling);
  assert.equal(treeFile('/project/.config/theme.js').closest('details').querySelector('summary').textContent, '.config');
  assert.match(treeFile('/elsewhere/view.js').parentElement.parentElement.parentElement.parentElement.textContent, /项目外/);
  item.changes[0].movePath = '/project/client/new.js'; preview.sync();
  assert.equal(treeFile('/project/src/view.js').title, '/project/client/new.js');
  assert.equal(treeFile('/project/src/view.js').closest('details').querySelector('summary').textContent, 'client');
  assert.equal(tab('client/new.js').textContent, 'new.js');
  const old = treeFile('/project/test/view.js');
  thread.id = 'other'; thread.cwd = '/different'; item.changes = [file('/different/next.js')]; preview.sync();
  assert.equal(old.isConnected, false); assert.equal($('liveEditsProject').textContent, 'different');
  assert.equal(document.querySelectorAll('#liveEditsTree button').length, 1);
});

test('closed tabs stay closed through streaming and reopen from the directory; close and keyboard navigation preserve the reader', async t => {
  const { $, document, window, item, thread, preview, file, treeFile, tab, close } = await directoryPreview(t);
  item.changes = [file('/project/src/a.js'), file('/project/src/b.js'), file('/project/test/c.js')]; preview.sync();
  tab('src/a.js').click(); $('liveEditsScroll').click(); $('liveEditsBody').scrollTop = 85;
  const code = $('liveEditsLines').querySelector('.live-edit-code'), range = document.createRange(); range.selectNodeContents(code); window.getSelection().addRange(range);
  const selected = window.getSelection().toString(); close('test/c.js').click();
  assert.equal($('liveEditsTabs').querySelector('[aria-selected=true]').title, 'src/a.js');
  assert.equal($('liveEditsBody').scrollTop, 85); assert.equal(window.getSelection().toString(), selected);
  assert.equal($('liveEditsLines').querySelector('.live-edit-code'), code);
  window.getSelection().removeAllRanges();
  item.changes[2].diff += '\n+const changed = 3;'; preview.sync();
  assert.equal(tab('test/c.js'), undefined); assert.equal(treeFile('/project/test/c.js').querySelector('small').hidden, false);
  $('liveEditsFollow').click(); assert.notEqual($('liveEditsTabs').querySelector('[aria-selected=true]').title, 'test/c.js');
  tab('src/a.js').click(); tab('src/a.js').focus(); tab('src/a.js').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal($('liveEditsTabs').querySelector('[aria-selected=true]').title, 'src/b.js');
  close('src/b.js').focus(); close('src/b.js').click();
  assert.equal($('liveEditsTabs').querySelector('[aria-selected=true]').title, 'src/a.js');
  assert.equal(document.activeElement, tab('src/a.js'));
  tab('src/a.js').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  assert.equal($('liveEditsTabs').children.length, 0); assert.equal($('liveEditsLines').textContent, '');
  assert.match($('liveEditsStatus').textContent, /已关闭/);
  item.changes[0].diff += '\n+const updated = 9;'; preview.sync();
  $('liveEditsToggle').click(); $('liveEditsToggle').click();
  assert.equal($('liveEditsTabs').children.length, 0, 'closing and reopening the window keeps manual tab choices');
  treeFile('/project/src/a.js').click(); assert.match($('liveEditsLines').textContent, /updated/);
  assert.equal(treeFile('/project/src/a.js').querySelector('small').hidden, true);
  assert.equal($('liveEditsScroll').getAttribute('aria-pressed'), 'false'); assert.equal($('liveEditsBody').scrollTop, 85);
  treeFile('/project/test/c.js').click(); treeFile('/project/src/b.js').click();
  assert.deepEqual([...$('liveEditsTabs').querySelectorAll('[role=tab]')].map(button => button.title), ['src/a.js', 'src/b.js', 'test/c.js']);
  close('src/a.js').click(); thread.turnId = 'next'; item.turnId = 'next'; preview.sync();
  assert.equal($('liveEditsTabs').children.length, 3, 'closed choices are scoped to one turn');
});

test('a new question in the same turn clears earlier files, tab choices and late updates', async t => {
  const { $, item, thread, preview, file, treeFile, close, tab } = await directoryPreview(t);
  thread.items.unshift({ id: 'u1', type: 'userMessage', turnId: 'turn', timestamp: 1000 });
  item.changes = [file('/project/previous.js')]; preview.sync(); close('previous.js').click();
  const oldTree = treeFile('/project/previous.js');
  thread.items.push({ id: 'u2', type: 'userMessage', turnId: 'turn', timestamp: 2000 }); preview.sync();
  assert.equal(oldTree.isConnected, false); assert.equal($('liveEditsTabs').children.length, 0);
  assert.equal($('liveEditsLines').textContent, ''); assert.match($('liveEditsStatus').textContent, /等待本次提问/);
  item.changes[0].diff += '\n+const latePrevious = true;'; preview.sync();
  assert.equal(treeFile('/project/previous.js'), undefined, 'late updates to the earlier item remain in its original display range');
  thread.items.push({ id: 'edit2', type: 'fileChange', turnId: 'turn', status: 'inProgress', changes: [file('/project/previous.js'), file('/project/current.js')] }); preview.sync();
  assert.ok(tab('previous.js'), 'new question can edit the same path without inheriting a closed tab');
  assert.ok(tab('current.js')); assert.doesNotMatch($('liveEditsLines').textContent, /latePrevious/);
  $('liveEditsClose').click(); $('liveEditsToggle').click();
  assert.equal($('liveEditsTabs').children.length, 2); assert.doesNotMatch($('liveEditsLines').textContent, /latePrevious/);
});

test('completed content remains while open, but idle reopening and pending requests wait without old files', async t => {
  const { $, item, thread, preview, file } = await directoryPreview(t);
  thread.items.unshift({ id: 'u1', type: 'userMessage', turnId: 'turn' });
  item.changes = [file('/project/previous.js')]; preview.sync();
  thread.busy = false; thread.latestTurnId = 'turn'; thread.turnId = null; thread.completion = 'completed'; item.status = 'completed'; preview.sync();
  assert.equal($('liveEditsTabs').children.length, 1, 'completion does not take away the preview being read');
  $('liveEditsClose').click(); $('liveEditsToggle').click();
  assert.equal($('liveEditsTabs').children.length, 0); assert.equal($('liveEditsTree').querySelector('button'), null);
  assert.equal($('liveEditsLines').textContent, ''); assert.match($('liveEditsStatus').textContent, /等待新任务/);
  thread.items.push({ id: 'u2', type: 'userMessage', pending: true }); thread.busy = true; preview.sync();
  assert.equal($('liveEditsTabs').children.length, 0);
  thread.turnId = 'next'; preview.sync(); assert.equal($('liveEditsTabs').children.length, 0);
  Object.assign(thread.items.at(-1), { pending: false, turnId: 'next' });
  thread.items.push({ id: 'edit2', type: 'fileChange', turnId: 'next', status: 'inProgress', changes: [file('/project/current.js')] }); preview.sync();
  assert.equal($('liveEditsTabs').querySelector('[role=tab]').textContent, 'current.js');
  assert.equal($('liveEditsTree').querySelectorAll('button').length, 1);
});

async function directoryPreview(t) {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { pretendToBeVisual: true });
  const saved = { window: globalThis.window, document: globalThis.document }, { window } = dom;
  Object.assign(globalThis, { window, document: window.document });
  t.after(() => { Object.assign(globalThis, saved); window.close(); });
  const document = window.document, $ = id => document.getElementById(id);
  const item = { id: 'edit', type: 'fileChange', turnId: 'turn', status: 'inProgress', changes: [] };
  const thread = { id: 'demo', cwd: '/project', turnId: 'turn', busy: true, items: [item], requests: [] };
  const preview = createLiveEdits({ storage: { getItem: () => 'true', setItem() {} }, getContext: () => ({ thread, live: true }) });
  return { $, document, window, item, thread, preview,
    file: path => ({ path, kind: 'add', diff: '@@ -0,0 +1 @@\n+const value = 1;' }),
    treeFile: path => [...document.querySelectorAll('#liveEditsTree button')].find(button => button.dataset.path === path),
    tab: path => [...document.querySelectorAll('#liveEditsTabs [role=tab]')].find(button => button.title === path),
    close: path => [...document.querySelectorAll('#liveEditsTabs .live-edit-tab-close')].find(button => button.title === `关闭 ${path}`),
  };
}
