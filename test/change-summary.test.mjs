import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { completedChangeSummaries, createChangeSummary } from '../public/task-results.js';

const change = (id, path, diff, extra = {}) => ({ id, turnId: 'done', type: 'fileChange', status: 'completed', changes: [{ path, diff, kind: 'update', ...extra }] });
const thread = items => ({ cwd: '/project', latestTurnId: 'done', completion: 'completed', busy: false, items });

test('file summaries deduplicate paths, count patch content and exclude rejected or outside files', () => {
  const first = change('one', '/project/a.txt', '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1,2 @@\n-old\n+new\n+++literal pluses');
  const second = change('two', 'a.txt', '@@ -2 +2 @@\n---literal minuses\n+next');
  const result = completedChangeSummaries(thread([first, first, second, { ...change('rejected', 'no.txt', ''), status: 'declined' }, change('external', '/private/secret', ''), change('hidden', '.env', '')]));
  assert.equal(result.length, 1); assert.equal(result[0].changes.length, 2); assert.equal(result[0].files.length, 1);
  assert.deepEqual({ added: result[0].files[0].added, removed: result[0].files[0].removed }, { added: 3, removed: 2 });
  assert.equal(completedChangeSummaries({ ...thread([first]), busy: true, turnId: 'done' }).length, 0);
  assert.equal(completedChangeSummaries({ ...thread([first]), busy: true, turnId: 'next', latestTurnId: 'next', turnTimings: [{ id: 'done', status: 'completed' }] }).length, 1, 'starting an empty new turn must keep the previous completed card');
  assert.equal(completedChangeSummaries(thread([{ ...first, status: 'failed' }])).length, 0);
});

test('history cards stay in their own turn, include confirmed edits on interruption and label missing counts', () => {
  const old = change('old', 'old.txt', ''), renamed = change('rename', 'before.txt', '@@ -1 +1 @@\n-a\n+b', { movePath: '/project/after.txt' });
  const latest = { ...change('latest', 'last.txt', '', { kind: 'delete' }), turnId: 'next' };
  const result = completedChangeSummaries({ ...thread([old, renamed, latest]), latestTurnId: 'next', completion: 'interrupted', turnTimings: [{ id: 'done', status: 'completed' }] });
  assert.deepEqual(result.map(turn => turn.key), ['done', 'next']);
  assert.equal(result[0].files[0].known, false); assert.equal(result[0].files[1].path, 'after.txt');
  assert.equal(result[1].files[0].kind, 'delete');
  const invalid = change('bad-rename', 'a.txt', '', { movePath: '../outside.txt' });
  assert.equal(completedChangeSummaries(thread([invalid])).length, 0);
});

test('file card keeps nodes on updates, opens files and routes deleted files to review without writes', async t => {
  const dom = new JSDOM('<main></main>'), original = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = original; dom.window.close(); });
  const actions = [], card = createChangeSummary({ onOpen: file => actions.push(['open', file.path]), onReview: summary => actions.push(['review', summary.changes.length]) });
  document.querySelector('main').append(card.el);
  const data = completedChangeSummaries(thread([change('one', 'safe<img>.txt', '@@ -1 +1 @@\n-a\n+b'), change('two', 'deleted.txt', '', { kind: 'delete' })]))[0];
  card.update(data); const first = card.el.querySelector('.change-summary-path'); first.focus();
  card.update(structuredClone(data)); assert.equal(card.el.querySelector('.change-summary-path'), first); assert.equal(document.activeElement, first);
  assert.equal(card.el.querySelector('img'), null); assert.match(card.el.textContent, /已编辑 2 个文件/); assert.match(card.el.textContent, /行数未提供/);
  first.click(); await Promise.resolve(); card.el.querySelectorAll('.change-summary-path')[1].click(); await Promise.resolve(); card.el.querySelector('.change-summary-review').click(); await Promise.resolve();
  assert.deepEqual(actions, [['open', 'safe<img>.txt'], ['review', 1], ['review', 2]]);
});
