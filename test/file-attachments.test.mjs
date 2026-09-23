import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { userMessagePresentation, attachmentProjectEntry, createFileAttachment } from '../public/interactions.js';
import { attachmentInput } from '../lib/context.mjs';

const file = { kind: 'file', name: '临时任务/保险/保险 LTV 报表.sql', path: '/project/临时任务/保险/保险 LTV 报表.sql' };
const wrapper = attachmentInput([file])[0].text;

test('historic local-file envelopes become cards while the prompt and native attachment input remain intact', () => {
  const prompt = '把子表改成一用户一行\nSELECT user_id, policy_id\nFROM demo_policies';
  const item = { text: prompt + '\n' + wrapper, attachments: [{ kind: 'image', name: 'image.png', previewUrl: '/api/attachments/images/00000000-0000-0000-0000-000000000000' }] };
  const saved = structuredClone(item), native = attachmentInput([file]);
  const result = userMessagePresentation(item);
  assert.equal(result.text, prompt); assert.deepEqual(result.attachments, [...item.attachments, file]);
  assert.deepEqual(item, saved); assert.deepEqual(attachmentInput([file]), native);
  assert.match(native[0].text, /本机路径/);
  assert.deepEqual(attachmentProjectEntry(result.attachments[1], '/project'), { cwd: '/project', path: '临时任务/保险/保险 LTV 报表.sql', kind: 'file' });
});

test('multiple file and folder envelopes support CRLF, quoted names and duplicate basenames', () => {
  const files = [file, { kind: 'file', name: '报告 "v2".sql', path: '/project/报告 "v2".sql' }, { kind: 'file', name: file.name, path: '/project/other/保险 LTV 报表.sql' }, { kind: 'folder', name: '资料', path: '/project/资料' }];
  const item = { text: '检查文件\r\n' + attachmentInput(files).map(part => part.text).join('\n').replaceAll('\n', '\r\n') + '\r\n' };
  const result = userMessagePresentation(item); assert.equal(result.text, '检查文件'); assert.deepEqual(result.attachments, files);
  const pending = { kind: 'file', name: '保险 LTV 报表.sql', projectRoot: '/project', projectPath: '临时任务/保险/保险 LTV 报表.sql', id: 'file-id' };
  assert.equal(userMessagePresentation({ text: wrapper, attachments: [pending] }).attachments.length, 1);
});

test('ordinary paths, fenced examples, incomplete or invalid envelopes stay in the message', () => {
  for (const text of [
    '请查看 /project/普通路径.sql',
    `示例\n\`\`\`text\n${wrapper}\n\`\`\``,
    `示例\n~~~text\n${wrapper}`,
    wrapper + '\n以上是格式示例',
    '用户附加的文件："a.sql"\n本机路径："javascript:alert(1)"',
    '用户附加的文件："a.sql"\n本机路径："//remote/share/a.sql"',
    '用户附加的文件："a.sql"\n本机路径："/project/a\\u0000.sql"',
    '用户附加的文件："a.sql"\n本机路径：/project/a.sql',
  ]) {
    const result = userMessagePresentation({ text }); assert.equal(result.text, text); assert.deepEqual(result.attachments, []);
  }
});

test('opening an attachment stays inside the selected project and rejects hidden or traversal paths', () => {
  for (const path of ['/project-other/a.sql', '/project/../a.sql', '/project/.env', '/project/a/../../b.sql', '/project/a\\b.sql', '/private/a.sql', 'https://example.test/a.sql']) assert.equal(attachmentProjectEntry({ ...file, path }, '/project'), null, path);
  assert.equal(attachmentProjectEntry({ kind: 'file', name: 'a.sql' }, '/project'), null);
});

test('file cards use the basename, escape text, keep paths collapsed and only open on click', t => {
  const dom = new JSDOM('<body></body>'); const old = globalThis.document; globalThis.document = dom.window.document;
  t.after(() => { globalThis.document = old; dom.window.close(); });
  let opened = 0; const card = createFileAttachment(file, { onOpen: () => opened++ }); document.body.append(card);
  assert.equal(card.querySelector('strong').textContent, '保险 LTV 报表.sql');
  assert.equal(card.querySelector('details').open, false); assert.equal(card.querySelector('code').textContent, file.path);
  assert.equal(opened, 0); card.querySelector('.attachment-file-main').click(); assert.equal(opened, 1);
  const unsafe = createFileAttachment({ kind: 'file', name: '<img onerror=alert(1)>.sql', path: '/project/<img onerror=alert(1)>.sql' });
  assert.equal(unsafe.querySelector('img'), null); assert.equal(unsafe.querySelector('strong').textContent, '<img onerror=alert(1)>.sql');
  assert.equal(unsafe.querySelector('.attachment-file-main').tagName, 'DIV');
});
