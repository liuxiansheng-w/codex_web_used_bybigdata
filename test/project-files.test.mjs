import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath, readFile, stat, chmod, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectFiles } from '../lib/project-files.mjs';
import { ContextStore, attachmentInput } from '../lib/context.mjs';

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'codex-file-tree-test-')));
  for (const name of ['src', '.git', 'node_modules', 'AIdata', '待删除', 'many']) await mkdir(path.join(root, name));
  await writeFile(path.join(root, 'README.md'), 'test-only file tree fixture');
  await writeFile(path.join(root, '.env'), 'TEST_ONLY=true');
  await writeFile(path.join(root, 'src', 'sample.txt'), 'attachment test fixture');
  await writeFile(path.join(root, 'src', '示例 图.png'), Buffer.from([137, 80, 78, 71]));
  await symlink(path.join(root, 'src'), path.join(root, 'link-inside'));
  await symlink(path.dirname(root), path.join(root, 'link-outside'));
  return root;
}

test('project tree lists only direct visible entries, folders first, without traversing excluded trees', async () => {
  const cwd = await fixture(), files = new ProjectFiles();
  const result = await files.list({ cwd });
  assert.deepEqual(result.entries.map(entry => entry.name), ['many', 'src', 'README.md']);
  assert.equal(result.cwd, cwd); assert.equal(result.nextOffset, null);
  assert.ok(result.entries.every(entry => !entry.path.includes('sample.txt')));
  const nested = await files.list({ cwd, path: 'src' });
  assert.ok(nested.entries.some(entry => entry.path === 'src/sample.txt'));
  assert.ok(nested.entries.some(entry => entry.path === 'src/示例 图.png'));
});

test('project tree denies traversal, hidden paths, excluded roots, symlinks, invalid offsets and missing entries', async () => {
  const cwd = await fixture(), files = new ProjectFiles(), context = new ContextStore();
  for (const relative of ['../', '../README.md', '/etc', 'src/../README.md', 'src//sample.txt', '.env', '.git', 'node_modules', 'AIdata', '待删除', 'link-inside/sample.txt', 'link-outside', 'src\\sample.txt', 'bad\0path']) {
    await assert.rejects(files.list({ cwd, path: relative }));
    await assert.rejects(files.attach(context, { cwd, path: relative }));
    await assert.rejects(files.read({ cwd, path: relative }));
    await assert.rejects(files.save({ cwd, path: relative, content: 'test', version: 'a'.repeat(64) }));
  }
  await assert.rejects(files.attach(context, { cwd, path: '' }), /请选择/);
  await assert.rejects(files.list({ cwd, path: 'missing' }), /刷新/);
  await assert.rejects(files.list({ cwd, path: 'README.md' }), /请选择文件夹/);
  for (const offset of [-1, 1.5, NaN, 10000]) await assert.rejects(files.list({ cwd, offset }), /分页/);
  assert.equal(context.files.size, 0);
});

test('text editor saves UTF-8 atomically while preserving BOM, CRLF, trailing newlines and ordinary mode', async () => {
  const cwd = await fixture(), files = new ProjectFiles(), relative = 'src/sample.txt';
  await writeFile(path.join(cwd, relative), '\uFEFF第一行\r\n第二行\r\n'); await chmod(path.join(cwd, relative), 0o640);
  const initial = await files.read({ cwd, path: relative });
  assert.equal(initial.content, '第一行\n第二行\n'); assert.equal(initial.newline, 'CRLF'); assert.equal(initial.bom, true);
  const saved = await files.save({ cwd, path: relative, version: initial.version, content: '已手动编辑\n第二行\n' });
  assert.notEqual(saved.version, initial.version); assert.equal(saved.content, '已手动编辑\n第二行\n');
  assert.equal(await readFile(path.join(cwd, relative), 'utf8'), '\uFEFF已手动编辑\r\n第二行\r\n');
  assert.equal((await stat(path.join(cwd, relative))).mode & 0o777, 0o640);
  const same = await files.save({ cwd, path: relative, version: saved.version, content: saved.content });
  assert.equal(same.version, saved.version, 'unchanged content does not rewrite the file');
  assert.ok(!(await files.list({ cwd, path: 'src' })).entries.some(entry => entry.name.includes('codex-edit')));
});

test('text editor rejects outdated versions, parallel saves and replaced files without losing external changes', async () => {
  const cwd = await fixture(), files = new ProjectFiles(), relative = 'src/sample.txt';
  const initial = await files.read({ cwd, path: relative });
  await writeFile(path.join(cwd, relative), 'external change');
  await assert.rejects(files.save({ cwd, path: relative, version: initial.version, content: 'my change' }), { status: 409 });
  assert.equal(await readFile(path.join(cwd, relative), 'utf8'), 'external change');
  const latest = await files.read({ cwd, path: relative });
  const results = await Promise.allSettled(['first editor', 'second editor'].map(content => files.save({ cwd, path: relative, version: latest.version, content })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const current = await files.read({ cwd, path: relative });
  await writeFile(path.join(cwd, 'replacement.txt'), current.content); await rename(path.join(cwd, 'replacement.txt'), path.join(cwd, relative));
  await assert.rejects(files.save({ cwd, path: relative, version: current.version, content: 'stale edit' }), { status: 409 });
});

test('text editor refuses binary, non-UTF8, mixed newline, oversized, hard-linked and read-only files', async () => {
  const cwd = await fixture(), files = new ProjectFiles();
  for (const [name, content, status] of [['binary.bin', Buffer.from([0, 1, 2]), 415], ['invalid.txt', Buffer.from([255]), 415], ['mixed.txt', 'a\r\nb\n', 415], ['huge.txt', 'a'.repeat(1024 * 1024 + 1), 413]]) {
    await writeFile(path.join(cwd, name), content); await assert.rejects(files.read({ cwd, path: name }), { status });
  }
  await chmod(path.join(cwd, 'README.md'), 0o444);
  const readOnly = await files.read({ cwd, path: 'README.md' }); assert.equal(readOnly.writable, false);
  await assert.rejects(files.save({ cwd, path: 'README.md', version: readOnly.version, content: 'no' }), { status: 403 });
  await link(path.join(cwd, 'src/sample.txt'), path.join(cwd, 'hardlink.txt'));
  const linked = await files.read({ cwd, path: 'hardlink.txt' }); assert.equal(linked.writable, false);
  await assert.rejects(files.save({ cwd, path: 'hardlink.txt', version: linked.version, content: 'no' }), { status: 403 });
  await assert.rejects(files.save({ cwd, path: 'README.md', content: 'no' }), /版本/);
});

test('project file references preserve native attachment input, deduplicate and never copy or expose file bytes', async () => {
  const cwd = await fixture(), files = new ProjectFiles(), context = new ContextStore();
  const file = await files.attach(context, { cwd, path: 'src/sample.txt' });
  const duplicate = await files.attach(context, { cwd, path: 'src/sample.txt' });
  assert.equal(duplicate.id, file.id); assert.equal(context.files.size, 1);
  assert.equal(context.root, null, 'no upload or file copying');
  assert.equal(file.projectRoot, cwd); assert.equal(file.projectPath, 'src/sample.txt');
  assert.equal(file.name, 'src/sample.txt'); assert.equal(file.kind, 'file');
  assert.ok(!('path' in file)); assert.ok(!JSON.stringify(file).includes('attachment test fixture'));
  const input = attachmentInput(context.resolve([file.id]));
  assert.match(input[0].text, /src\/sample.txt/);
  const folder = await files.attach(context, { cwd, path: 'src' }); assert.equal(folder.kind, 'folder');
  const image = await files.attach(context, { cwd, path: 'src/示例 图.png' });
  assert.equal(image.kind, 'image');
  assert.equal(attachmentInput(context.resolve([image.id]))[1].type, 'localImage');
});

test('large directories paginate without duplicates', async () => {
  const cwd = await fixture(), files = new ProjectFiles();
  await Promise.all(Array.from({ length: 203 }, (_, index) => writeFile(path.join(cwd, 'many', `file-${index}.txt`), '')));
  const first = await files.list({ cwd, path: 'many' });
  assert.equal(first.entries.length, 200); assert.equal(first.nextOffset, 200);
  const second = await files.list({ cwd, path: 'many', offset: first.nextOffset });
  assert.equal(second.entries.length, 3); assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.path)).size, 203);
});
