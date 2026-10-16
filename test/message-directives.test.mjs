import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { markdown } from '../public/markdown.js';

const render = text => JSDOM.fragment(markdown(text));
const citation = path => `:codex-file-citation{path=${JSON.stringify(path)} purpose="source" artifact_kind="workbook" sheet="Sheet1" range="A1:AA2"}`;
const followup = (prompt, label = '查看明细') => `:codex-followup[${label}]{prompt=${JSON.stringify(prompt)}}`;

test('native citations and followups render readable controls with quoted values preserved', () => {
  const path = '/project/AIdata/20260924/报表 (2).xlsx', prompt = '查看 `use_state`："待确认"，保留 {日期} 和换行\n下一步';
  const fragment = render(`完整结果见：${citation(path)}\n\n- ${followup(prompt)}\n- :${followup('进一步统计')}`);
  const file = fragment.querySelector('.file-citation');
  assert.equal(file.dataset.fileLink, path); assert.equal(file.querySelector('.file-citation-name').textContent, '报表 (2).xlsx');
  assert.equal(file.querySelector('.file-citation-location').textContent, 'Sheet1 · A1:AA2');
  assert.equal(file.querySelector('.file-citation-type').textContent, 'XLSX');
  assert.deepEqual([...fragment.querySelectorAll('[data-followup-prompt]')].map(button => button.dataset.followupPrompt), [prompt, '进一步统计']);
  assert.doesNotMatch(fragment.textContent, /codex-file-citation|codex-followup|\/project\/|artifact_kind|prompt=/);
});

test('code, escaped markers, malformed and partial directives remain inert', () => {
  const text = citation('/project/a.xlsx'), action = followup('test');
  for (const example of [`\`${text}\``, `\`\`${action} with \`inline\`\`\``, `\`\`\`\`md\n${text}\n\`\`\`\n${action}\n\`\`\`\``, `~~~md\n${action}\n~~~`, `\\${text}`, text.slice(0, -1), ':codex-file-citation{path="a.xlsx" path="b.xlsx"}', ':codex-followup[x]{prompt="ok"onclick="bad"}', ':codex-followup[x]{prompt=""}']) {
    assert.equal(render(example).querySelectorAll('button,a').length, 0, example);
  }
  assert.equal(render(text).querySelectorAll('.file-citation').length, 1, 'a completed streaming directive becomes one control');
});

test('message directives cannot inject markup, nested actions, protocols or traversal', () => {
  for (const path of ['javascript:alert(1)', 'https://example.test/report.xlsx', '//remote/report.xlsx', '../secret.xlsx', '/project/../secret.xlsx', '/project/secret\n.xlsx', 'file:///etc/report.xlsx']) assert.equal(render(citation(path)).querySelectorAll('button').length, 0, path);
  const path = '/project/a" autofocus onfocus="bad & <img>.xlsx';
  const fragment = render(`${citation(path)} ${followup(':codex-file-citation{path="/nested.xlsx"} <script>bad</script>', '<img src=x onerror=bad>')}`);
  assert.equal(fragment.querySelectorAll('button').length, 2);
  assert.equal(fragment.querySelectorAll('img,script,[onclick],[onfocus],[autofocus]').length, 0);
  assert.equal(fragment.querySelector('.file-citation').dataset.fileLink, path);
  assert.equal(fragment.querySelector('.message-followup').dataset.followupPrompt, ':codex-file-citation{path="/nested.xlsx"} <script>bad</script>');
});
