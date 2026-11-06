import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatFileLink, explicitFilePath } from '../public/project-paths.js';
import { ProjectFiles } from '../lib/project-files.mjs';

test('chat citations resolve current and registered project roots without changing chat context', () => {
  const context = { cwd: '/workspace/one', projects: ['/workspace/two', '/workspace/two/nested'] };
  assert.deepEqual(chatFileLink('a.sql:3', context), { cwd: '/workspace/one', path: 'a.sql', line: 3 });
  assert.deepEqual(chatFileLink('./docs/说明.md#L8', context), { cwd: '/workspace/one', path: 'docs/说明.md', line: 8 });
  assert.deepEqual(chatFileLink('/workspace/one/report.sql', context), { cwd: '/workspace/one', path: 'report.sql', line: 0 });
  assert.deepEqual(chatFileLink('/workspace/two/nested/保险%20报表/订单(v2).sql:204', context), { cwd: '/workspace/two/nested', path: '保险 报表/订单(v2).sql', line: 204, viewCwd: '/workspace/one' });
  assert.deepEqual(chatFileLink('/root.sql#L2', { cwd: '/', projects: [] }), { cwd: '/', path: 'root.sql', line: 2 });
  assert.deepEqual(chatFileLink('/workspace/one/sub/a.sql', { cwd: '/workspace/one', projects: ['/workspace/one/sub'] }), { cwd: '/workspace/one', path: 'sub/a.sql', line: 0 }, 'files already in the current project keep their original editing behavior');
});

test('unregistered absolute citations open a single read-only file without requiring a project', () => {
  const context = { cwd: '/workspace/one', projects: ['/workspace/two'] };
  assert.deepEqual(chatFileLink('/workspace/two-copy/private.sql', context), { cwd: '/', path: 'workspace/two-copy/private.sql', line: 0, viewCwd: context.cwd });
  assert.deepEqual(chatFileLink('/unknown/保险%20草稿(2).sql#L3', context), { cwd: '/', path: 'unknown/保险 草稿(2).sql', line: 3, viewCwd: context.cwd });
  assert.deepEqual(chatFileLink('/tmp/example.sql:2', context), { cwd: '/tmp', path: 'example.sql', line: 2, viewCwd: context.cwd });
  assert.deepEqual(chatFileLink('/var/folders/example.sql', context), { cwd: '/var', path: 'folders/example.sql', line: 0, viewCwd: context.cwd });
  assert.deepEqual(context.projects, ['/workspace/two']);
});

test('single-file opening validates the entire absolute path before selecting its root', () => {
  const context = { cwd: '/workspace/one', projects: ['/workspace/two'] };
  for (const target of ['../two/a.sql', '/workspace/two/../private.sql', '/workspace/two/.env', '/workspace/two/.ssh/key.sql', '/workspace/two/node_modules/a.sql', '/unknown/.env', '/unknown/.ssh/id_rsa.sql', '/unknown/.git/config.sql', '/unknown/node_modules/a.sql', '/unknown/待删除/a.sql', '/unknown/.codex/memories/MEMORY.md', '/unknown/../file.sql', 'file:///workspace/two/a.sql', 'javascript:bad.sql', '//host/a.sql', 'a.sql%00', 'a.sql%ZZ', 'a.sql:9999999999999999999']) assert.throws(() => chatFileLink(target, context), undefined, target);
  assert.deepEqual(chatFileLink('/workspace/two/AIdata/export.xlsx', context), { cwd: '/workspace/two', path: 'AIdata/export.xlsx', line: 0, viewCwd: context.cwd });
  assert.throws(() => chatFileLink('/workspace/two/AIdata/source.sql', context), /排除/);
  assert.equal(explicitFilePath('/unknown/AIdata/export.xlsx'), true);
  assert.equal(explicitFilePath('/unknown/AIdata/source.sql'), false);
  assert.equal(explicitFilePath('/unknown//source.sql'), false);
});

test('unregistered citations use the real file reader and retain ancestor and file symlink checks', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'lemon-single-file-')), root = await realpath(temporary);
  await mkdir(path.join(root, 'drafts'));
  await writeFile(path.join(root, 'drafts/example.sql'), '-- fictional preview only\nSELECT 1;\n');
  const files = new ProjectFiles(), context = { cwd: '/fictional-current-project', projects: [] };
  const entry = chatFileLink(`${root}/drafts/example.sql:2`, context), result = await files.read(entry);
  assert.equal(result.content, '-- fictional preview only\nSELECT 1;\n');
  assert.equal(entry.viewCwd, context.cwd); assert.equal(entry.line, 2);
  const aliasEntry = chatFileLink(`${temporary}/drafts/example.sql:2`, context);
  assert.equal((await files.read(aliasEntry)).content, result.content, 'standard temporary-directory aliases remain readable');
  await symlink(path.join(root, 'drafts'), path.join(root, 'shortcut'));
  await symlink(path.join(root, 'drafts/example.sql'), path.join(root, 'linked.sql'));
  await assert.rejects(files.read(chatFileLink(`${root}/shortcut/example.sql`, context)), /符号链接/);
  await assert.rejects(files.read(chatFileLink(`${root}/linked.sql`, context)), /符号链接/);
});
