import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEditorChanges } from '../public/file-editor.js';

test('three-way sync combines separated edits, insertions and deletions without touching line endings', () => {
  const base = 'alpha\nbeta\ngamma\ndelta\nomega\n';
  assert.equal(mergeEditorChanges(base, 'ALPHA\nbeta\ngamma\ndelta\nomega\n', 'alpha\nbeta\ngamma\nDELTA\nomega\n'), 'ALPHA\nbeta\ngamma\nDELTA\nomega\n');
  assert.equal(mergeEditorChanges(base, 'alpha\nbeta\ngamma\nLOCAL\ndelta\nomega\n', 'REMOTE\nalpha\nbeta\ngamma\ndelta\nomega\n'), 'REMOTE\nalpha\nbeta\ngamma\nLOCAL\ndelta\nomega\n');
  assert.equal(mergeEditorChanges(base, 'alpha\ngamma\ndelta\nomega\n', 'alpha\nbeta\ngamma\nDELTA\nomega\n'), 'alpha\ngamma\nDELTA\nomega\n');
  assert.equal(mergeEditorChanges('a\r\nb\r\nc', 'A\r\nb\r\nc', 'a\r\nb\r\nC'), 'A\r\nb\r\nC');
});

test('identical edits converge; overlap, competing inserts and ambiguous duplicate deletion stay unresolved', () => {
  const base = 'one\ntwo\nthree\nfour\n';
  assert.equal(mergeEditorChanges(base, 'ONE\ntwo\nthree\nfour\n', 'ONE\ntwo\nthree\nFOUR\n'), 'ONE\ntwo\nthree\nFOUR\n');
  assert.equal(mergeEditorChanges(base, 'LOCAL\ntwo\nthree\nfour\n', 'REMOTE\ntwo\nthree\nfour\n'), null);
  assert.equal(mergeEditorChanges(base, 'one\nLOCAL\ntwo\nthree\nfour\n', 'one\nREMOTE\ntwo\nthree\nfour\n'), null);
  assert.equal(mergeEditorChanges('X\nX\n', 'X\n', 'Y\nX\n'), null);
  for (const text of ['', 'text without newline', 'a\r\nb\n']) {
    assert.equal(mergeEditorChanges(text, text, 'disk'), 'disk');
    assert.equal(mergeEditorChanges(text, 'draft', text), 'draft');
    assert.equal(mergeEditorChanges(text, 'same', 'same'), 'same');
  }
});

test('separated generated changes retain both sides and are symmetric across many edit positions', () => {
  const lines = Array.from({ length: 70 }, (_, i) => `unique line ${i}\n`), base = lines.join('');
  for (let i = 0; i < 30; i++) {
    const ours = [...lines], theirs = [...lines], expected = [...lines];
    ours[i] = expected[i] = `local ${i}\n`; theirs[69 - i] = expected[69 - i] = `disk ${i}\n`;
    assert.equal(mergeEditorChanges(base, ours.join(''), theirs.join('')), expected.join(''));
    assert.equal(mergeEditorChanges(base, theirs.join(''), ours.join('')), expected.join(''));
  }
  const large = 'unchanged\n'.repeat(140000);
  assert.equal(mergeEditorChanges(large, 'local\n' + large, large + 'disk\n'), 'local\n' + large + 'disk\n');
});
