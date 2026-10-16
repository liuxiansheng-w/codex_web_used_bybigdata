import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { describeMcpForm, validateMcpForm, mcpFormSchema } from '../public/mcp-form-schema.js';
import { renderMcpFields } from '../public/mcp-form-fields.js';
import { Workspace } from '../lib/workspace.mjs';

const schema = { type: 'object', required: ['target', 'region'], properties: {
  region: { type: 'string', default: 'east', oneOf: [{ const: 'east', title: '华东', description: '上海与周边' }, { const: 'north', title: '华北' }] },
  target: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', format: 'uri' }, 'x-openai-input': { type: 'resource', options: [{ uri: 'resource://report/one', name: '报表一', description: '确认后交给插件' }, { uri: 'file:///private/example.txt', name: '本机示例' }] } },
  note: { type: 'string', default: '第一行\n第二行' },
  tags: { type: 'array', items: { type: 'string', maxLength: 20 }, uniqueItems: true, default: ['初稿'] },
  date: { type: 'string', format: 'date', default: '2026-10-13' },
  count: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
} };

test('extended forms validate native choices, resources, free lists and metadata schema before replying', t => {
  const bridge = new EventEmitter(), replies = []; bridge.respond = (id, value) => replies.push({ id, value });
  const workspace = new Workspace(bridge, '/project'), thread = workspace.importThread({ id: 'form', turns: [] });
  t.after(() => { for (const timer of workspace.timers.values()) clearTimeout(timer); });
  for (const mode of ['openai/form', 'openaiForm', 'form']) {
    const params = { threadId: 'form', serverName: 'demo', mode, requestedSchema: mode === 'form' ? { type: 'object', properties: {} } : schema, ...(mode === 'form' ? { _meta: { 'openai/elicitation': { requestedSchema: schema } } } : {}) };
    const before = replies.length;
    workspace.serverRequest({ id: mode, method: 'mcpServer/elicitation/request', params });
    const key = thread.requests.at(-1).key;
    assert.equal(replies.length, before, 'no automatic authorization');
    assert.throws(() => workspace.respond({ key, decision: 'accept', content: {} }), /填写/);
    assert.throws(() => workspace.respond({ key, decision: 'accept', content: { region: 'east', target: ['resource://not-offered'] } }), /多选/);
    assert.throws(() => workspace.respond({ key, decision: 'accept', content: { region: 'east', target: ['resource://report/one'], count: 1.5 } }), /数值/);
    const content = { region: 'north', target: ['resource://report/one'], tags: ['本地草稿'], note: '说明', date: '2026-10-13' };
    workspace.respond({ key, decision: 'accept', content });
    assert.deepEqual(replies.at(-1).value, { action: 'accept', content });
    assert.throws(() => workspace.respond({ key, decision: 'accept', content }), /已结束/);
  }
  workspace.serverRequest({ id: 'unsupported', method: 'mcpServer/elicitation/request', params: { threadId: 'form', serverName: 'demo', mode: 'openai/form', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } } });
  const key = thread.requests.at(-1).key;
  assert.throws(() => workspace.respond({ key, decision: 'accept', content: {} }), /暂不支持/);
  workspace.respond({ key, decision: 'decline' }); assert.equal(replies.at(-1).value.action, 'decline');
});

test('extended form inputs preserve defaults and typed content without fetching resources or submitting automatically', () => {
  const dom = new JSDOM('<form></form>'), doc = dom.window.document, parent = doc.querySelector('form');
  const form = renderMcpFields(parent, schema, { extended: true });
  assert.equal(form.supported, true); assert.equal(doc.querySelector('textarea[name=note]').value, '第一行\n第二行');
  assert.equal(doc.querySelector('input[name=date]').type, 'date'); assert.equal(doc.querySelector('input[name=count]').value, '2');
  assert.match(parent.textContent, /华东|上海与周边|报表一|确认后交给插件/);
  assert.equal(parent.querySelectorAll('img,iframe,a').length, 0);
  assert.throws(() => form.read(), /多选/);
  parent.querySelector('input[value="resource://report/one"]').click();
  assert.deepEqual(form.read(), { region: 'east', target: ['resource://report/one'], note: '第一行\n第二行', tags: ['初稿'], date: '2026-10-13', count: 2 });
  const add = [...parent.querySelectorAll('button')].find(button => button.textContent === '添加一项'); add.click();
  const rows = parent.querySelectorAll('.mcp-list input'); rows[1].value = '定稿';
  assert.deepEqual(form.read().tags, ['初稿', '定稿']);
  rows[1].value = '初稿'; assert.throws(() => form.read(), /多选/);
  parent.querySelectorAll('.mcp-list button')[1].click(); assert.deepEqual(form.read().tags, ['初稿']);
  dom.window.close();
});

test('forms reject unsupported semantics, forged fields and missing metadata schemas rather than accept partial input', () => {
  for (const bad of [
    { type: 'object', properties: { nested: { type: 'object' } } },
    { type: 'object', properties: { token: { type: 'string', pattern: '(a+)+$' } } },
    { ...schema, allOf: [{}] },
    { type: 'object', properties: { resources: { ...schema.properties.target, 'x-openai-input': { ...schema.properties.target['x-openai-input'], userOptions: { kind: 'file' } } } } },
  ]) {
    assert.equal(describeMcpForm(bad, { extended: true }).supported, false);
    assert.throws(() => validateMcpForm(bad, {}, { extended: true }), /暂不支持/);
  }
  assert.throws(() => validateMcpForm(schema, { region: 'east', target: ['resource://report/one'], extra: 'forged' }, { extended: true }), /未声明/);
  const resolved = mcpFormSchema({ mode: 'form', requestedSchema: { type: 'object', properties: {} }, _meta: { 'openai/elicitation': {} } });
  assert.equal(describeMcpForm(resolved.schema, resolved).supported, false);
  const dangerous = JSON.parse('{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string"}}}');
  assert.throws(() => validateMcpForm(dangerous, {}), /填写/);
  const dom = new JSDOM('<form></form>');
  renderMcpFields(dom.window.document.querySelector('form'), { type: 'object', properties: { choice: { type: 'string', oneOf: [{ const: '<script>text</script>', title: '<img src=x onerror=alert(1)>', description: '<iframe>' }] } } }, { extended: true });
  assert.equal(dom.window.document.querySelector('img,script,iframe'), null); dom.window.close();
  const confirmation = { version: 1, field: 'confirmed', presentation: { title: '核对操作内容', destructive: true, fields: [{ label: '对象', value: '模拟对象 <img src=x>' }] } };
  const confirmSchema = { type: 'object', required: ['confirmed'], properties: { confirmed: { type: 'boolean', title: '我已核对' } } };
  const confirmDom = new JSDOM('<form></form>'), confirmParent = confirmDom.window.document.querySelector('form');
  const form = renderMcpFields(confirmParent, confirmSchema, { confirmation });
  assert.match(confirmParent.textContent, /核对操作内容|模拟对象 <img src=x>|破坏性/); assert.equal(confirmParent.querySelector('img'), null);
  assert.deepEqual(form.read(), { confirmed: false }); confirmParent.querySelector('input').click(); assert.deepEqual(form.read(), { confirmed: true });
  assert.equal(describeMcpForm(confirmSchema, { confirmation: { ...confirmation, field: 'unknown' } }).supported, false); confirmDom.window.close();
});
