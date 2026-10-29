import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createDraftJournal } from '../public/draft-journal.js';
import { createDraftStore } from '../public/interactions.js';
import { createSubmissionState } from '../public/submission-state.js';
import { MessageSubmissions } from '../lib/message-submissions.mjs';
import { createMessageRenderer } from '../public/message-renderer.js';
import { taskResult, completedChangeSummaries } from '../public/task-results.js';
import { currentRequest } from '../public/message-timing.js';
import { liveEditFiles } from '../public/live-edits.js';
import { Workspace } from '../lib/workspace.mjs';
import { prepareThread } from '../lib/event-stream.mjs';

function browser(t) { const dom = new JSDOM('<main></main>', { url: 'https://fictional.test' }); t.after(() => dom.window.close()); return dom.window; }

test('independent windows preserve different drafts and concurrent versions of the same draft, with no attachment cache', t => {
  const window = browser(t), storage = window.localStorage;
  const a = createDraftStore({ storage }), b = createDraftStore({ storage });
  a.save('/p', 'one', { text: 'temporary', context: { files: [{ secret: 'attachment body' }] } }); assert.equal(storage.length, 0);
  storage.setItem('codex-desk:persistDrafts', 'true');
  a.save('/p', 'one', { text: 'A', model: 'm', context: { files: [{ secret: 'attachment body' }] } });
  b.save('/p', 'two', { text: 'B', model: 'm', context: {} });
  b.save('/p', 'one', { text: 'concurrent B', model: 'm', context: {} });
  a.save('/p', 'one', { text: 'later A', model: 'm', context: {} });
  const loaded = createDraftStore({ storage });
  assert.equal(loaded.read('/p', 'two').text, 'B'); assert.equal(loaded.read('/p', 'one').text, 'later A');
  assert.deepEqual(loaded.versions('/p', 'one').map(record => record.value.text).sort(), ['concurrent B', 'later A']);
  a.clear('/p', 'one', 'later A');
  assert.equal(createDraftStore({ storage }).read('/p', 'one').text, 'concurrent B', 'sending in one window cannot delete another window draft');
  assert.doesNotMatch([...Array(storage.length)].map((_, i) => storage.getItem(storage.key(i))).join(''), /attachment body|secret/);
  loaded.clearSaved(); assert.equal(storage.length, 1);
});

test('legacy prompts and editor drafts migrate without losing content and storage errors preserve old versions', t => {
  const window = browser(t), storage = window.localStorage;
  storage.setItem('codex-desk:persistDrafts', 'true');
  storage.setItem('codex-desk:promptDrafts', JSON.stringify([[JSON.stringify(['/p', 'one']), { text: 'legacy', model: 'm', context: { files: ['do-not-cache'] } }]]));
  const draft = { cwd: '/p', path: 'a.txt', baseline: 'disk', content: 'edit', version: 'v' };
  storage.setItem('codex-desk:editorDrafts', JSON.stringify([draft]));
  assert.equal(createDraftStore({ storage }).read('/p', 'one').text, 'legacy');
  const errors = [], journal = createDraftJournal({ storage, name: 'editorDrafts', limit: 1, onError: message => errors.push(message) });
  assert.deepEqual(journal.latest().map(record => record.value), [draft]);
  journal.put(JSON.stringify(['/p', 'a.txt']), { ...draft, content: 'new content' });
  assert.equal(journal.latest()[0].value.content, 'edit'); assert.equal(errors.length, 1);
  assert.doesNotMatch([...Array(storage.length)].map((_, i) => storage.getItem(storage.key(i))).join(''), /do-not-cache/);
});

test('receipts deduplicate simultaneous and later retries, reject changed bodies and cannot replay across server restarts', async () => {
  const receipts = new MessageSubmissions({ limit: 1 }), id = randomUUID(), body = { submissionId: id, submissionEpoch: receipts.epoch, text: 'original' };
  let calls = 0, finish;
  const operation = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const a = receipts.run('send', body, operation), b = receipts.run('send', { ...body }, operation);
  await Promise.resolve(); assert.equal(calls, 1); assert.equal(receipts.get(id, receipts.epoch).state, 'pending');
  finish({ threadId: 'one' }); assert.deepEqual(await a, await b);
  assert.deepEqual(await receipts.run('send', body, operation), { threadId: 'one' }); assert.equal(calls, 1);
  assert.throws(() => receipts.run('send', { ...body, text: 'different' }, operation), /内容已变化/);
  assert.throws(() => receipts.run('send', { ...body, submissionEpoch: 'old-server' }, operation), /服务已重启/);
  assert.throws(() => receipts.run('send', { ...body, submissionId: randomUUID() }, operation), /凭据已满/);
  assert.equal(receipts.get(id, receipts.epoch).state, 'accepted', 'receipt is never evicted to make an old id executable again');
});

test('a runtime failure after dispatch remains uncertain and retrying its receipt never starts another operation', async () => {
  const receipts = new MessageSubmissions(), id = randomUUID(), body = { submissionId: id, submissionEpoch: receipts.epoch, text: 'one' }; let calls = 0;
  const operation = () => { calls++; receipts.attempting(id); receipts.attach(id, 'one'); throw new Error('transport disconnected'); };
  await assert.rejects(receipts.run('send', body, operation));
  assert.deepEqual(receipts.get(id, receipts.epoch), { state: 'unknown', threadId: 'one', message: 'transport disconnected' });
  await assert.rejects(receipts.run('send', body, operation)); assert.equal(calls, 1);
});

test('Workspace starts only one native task if the first successful HTTP acknowledgement is lost', async t => {
  const bridge = new EventEmitter(); bridge.ready = true; let starts = 0, threads = 0;
  bridge.request = async (method, params) => {
    if (method === 'thread/start') return { thread: { id: 'fictional-' + (++threads), cwd: '/private/tmp', turns: [] }, model: 'mock' };
    if (method === 'turn/start') { starts++; const turn = { id: 'turn', status: 'inProgress' }; bridge.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn } }); return { turn }; }
    throw new Error('Unexpected mocked method: ' + method);
  };
  const workspace = new Workspace(bridge, '/private/tmp'); t.after(() => { for (const timer of workspace.timers.values()) clearTimeout(timer); });
  workspace.permissions.resolve = async () => ({ approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } }); workspace.catalog.input = async () => []; workspace.ensureTitle = async () => {};
  const body = { cwd: '/private/tmp', mode: 'read-only', text: 'fictional only', submissionId: randomUUID(), submissionEpoch: workspace.submissions.epoch };
  const first = await workspace.send(body), retry = await workspace.send(body);
  assert.deepEqual(first, retry); assert.equal(starts, 1); assert.equal(threads, 1);
});

test('client recovery uses GET only and explicit retry keeps the original body after a draft changes', async () => {
  const calls = [], epoch = 'server-one'; let state = 'notFound';
  const client = createSubmissionState({ getEpoch: () => epoch, api: async (route, body) => { calls.push([route, body]); if (!body) return { state, threadId: state === 'accepted' ? 'one' : null }; if (calls.length === 1) throw new Error('response lost'); return { threadId: 'one' }; } });
  const record = client.begin('/p', null, '/api/send', { text: 'fixed snapshot' }, {});
  await assert.rejects(client.send(record)); await client.check(record); assert.equal(calls.filter(([, body]) => body).length, 1);
  assert.throws(() => client.begin('/p', null, '/api/send', { text: 'new draft' }, {}), /核对/);
  await client.send(record); assert.deepEqual(calls[0][1], calls[2][1]);
  state = 'accepted'; await client.check(record); assert.equal(record.result.threadId, 'one');
});

test('reply updates keep code nodes, scroll and selected text, then apply the newest content after selection ends', t => {
  const window = browser(t), document = window.document, el = document.createElement('article'); document.querySelector('main').append(el);
  const copies = [], renderer = createMessageRenderer({ document, onCopy: text => copies.push(text), onOpenFile: () => {} }); t.after(() => renderer.dispose());
  renderer.update(el, { type: 'agentMessage', text: 'Heading\n\n```js\nconst a = 1;\n```\n\nfirst' });
  const code = el.querySelector('code'), pre = el.querySelector('pre'); pre.scrollLeft = 50;
  renderer.update(el, { type: 'agentMessage', text: 'Heading\n\n```js\nconst a = 1;\n```\n\nsecond' });
  assert.equal(el.querySelector('code'), code); assert.equal(pre.scrollLeft, 50);
  const range = document.createRange(); range.selectNodeContents(code); document.getSelection().addRange(range);
  renderer.update(el, { type: 'agentMessage', text: 'Heading\n\n```js\nconst a = 2;\n```\n\nnewest' });
  assert.equal(document.getSelection().toString(), 'const a = 1;'); assert.equal(code.textContent, 'const a = 1;'); assert.equal(el.querySelector('.reply-refresh').hidden, false);
  el.querySelector('.copy-response').click(); assert.match(copies[0], /const a = 1/);
  document.getSelection().removeAllRanges(); document.dispatchEvent(new window.Event('selectionchange'));
  assert.equal(el.querySelector('code'), code); assert.equal(code.textContent, 'const a = 2;'); assert.equal(el.querySelector('.reply-refresh').hidden, true);
});

test('results, review summaries and popup use the same question boundary and retain ordinary hidden configuration changes', () => {
  const change = (id, path) => ({ id, turnId: 'same', type: 'fileChange', status: 'completed', changes: [{ path, diff: '@@ -1 +1 @@\n-a\n+b' }] });
  const thread = { cwd: '/p', completion: 'completed', latestTurnId: 'same', busy: false, items: [{ id: 'u1', turnId: 'same', type: 'userMessage' }, change('old', 'old.txt'), { id: 'u2', turnId: 'same', type: 'userMessage' }, change('new', '.github/workflows/ci.yml'), change('secret', '.env.production')] };
  assert.equal(currentRequest(thread).user.id, 'u2');
  assert.deepEqual(taskResult(thread).artifacts.map(file => file.path), ['.github/workflows/ci.yml']);
  assert.equal(liveEditFiles(thread).find(file => file.path === '.github/workflows/ci.yml').item.id, 'new');
  assert.deepEqual(completedChangeSummaries(thread).map(summary => summary.files.map(file => file.path)), [['old.txt'], ['.github/workflows/ci.yml']]);
  thread.items.push({ id: 'pending', type: 'userMessage', pending: true }); assert.equal(taskResult(thread).changes.length, 0);
});

test('streaming a long managed history serializes only changed items and does not rescan historic output text', t => {
  const bridge = new EventEmitter(), workspace = new Workspace(bridge, '/p'); t.after(() => { for (const timer of workspace.timers.values()) clearTimeout(timer); });
  const thread = workspace.importThread({ id: 'one', cwd: '/p', turns: [] }); let serializations = 0;
  thread.busy = true; thread.turnId = thread.latestTurnId = 'turn';
  thread.items.push({ id: 'history', type: 'commandExecution', text: 'x'.repeat(4 * 1024 * 1024), toJSON() { serializations++; return { id: this.id, type: this.type, text: this.text }; } });
  workspace.changed(thread); prepareThread(thread); assert.equal(serializations, 1);
  for (let i = 0; i < 100; i++) { workspace.notification({ method: 'item/agentMessage/delta', params: { threadId: 'one', turnId: 'turn', itemId: 'answer', delta: 'x' } }); prepareThread(thread); }
  assert.equal(serializations, 1); assert.equal(thread.items.at(-1).text.length, 100);
});

test('refresh preserves only opaque submission metadata and cannot replay the missing original message body', async t => {
  const storage = browser(t).sessionStorage, calls = [], api = async (route, body) => { calls.push({ route, body }); if (body) throw new Error('lost response'); return { state: 'accepted', threadId: 'one' }; };
  const first = createSubmissionState({ storage, api, getEpoch: () => 'server-epoch' });
  const record = first.begin('/p', null, '/api/send', { text: 'private body', attachments: ['private-attachment'], fullAccessConfirmed: true }, { draftText: 'private body' });
  await assert.rejects(first.send(record));
  assert.doesNotMatch(storage.getItem('lemon:pendingSubmissions:v1'), /private body|private-attachment|fullAccessConfirmed/);
  const restored = createSubmissionState({ storage, api, getEpoch: () => 'new-epoch' }), pending = restored.get('/p', null);
  assert.equal(pending.snapshot, null); assert.equal(pending.body.submissionEpoch, 'server-epoch');
  await assert.rejects(restored.send(pending), /只支持核对/); assert.equal(calls.length, 1);
  await restored.check(pending); assert.equal(calls.at(-1).body, undefined); assert.equal(pending.result.threadId, 'one');
  restored.forget(pending); assert.equal(storage.getItem('lemon:pendingSubmissions:v1'), null);
});
