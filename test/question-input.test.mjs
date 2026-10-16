import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { Workspace } from '../lib/workspace.mjs';
import { createQuestionCard } from '../public/permissions.js';
import { threadDisplayState } from '../public/interactions.js';
import { asyncQuestionId, questionReplies } from '../lib/question-input.mjs';

const questions = [
  { id: 'color', header: '颜色', question: '选择虚构页面的颜色', isOther: true, options: [{ label: '蓝色', description: '第一项建议' }, { label: '银色', description: '第二项建议' }] },
  { id: 'note', header: '备注', question: '补充说明', isSecret: true, options: null },
];
test('native question replies preserve async work, validate answers, support explicit skips and reject stale replies', t => {
  const bridge = new EventEmitter(), calls = [];
  bridge.respond = (id, value) => calls.push({ id, value }); bridge.request = async () => ({ thread: {} });
  const space = new Workspace(bridge, '/project');
  t.after(() => { for (const timer of space.timers.values()) clearTimeout(timer); });
  const thread = space.importThread({ id: 'one', cwd: '/project', turns: [] }, { busy: true, turnId: 'turn' });
  const offer = (id, isBlocking = false) => {
    const message = { id, method: 'item/tool/requestUserInput', params: { threadId: 'one', turnId: 'turn', itemId: id, questions, isBlocking } };
    space.serverRequest(message); space.serverRequest(message); assert.equal(thread.requests.length, 1);
    return thread.requests[0].key;
  };
  const key = offer('async');
  assert.deepEqual(threadDisplayState(thread), { key: 'running', label: '运行中 · 可回复', rank: 5 });
  assert.throws(() => space.respond({ key, answers: { color: '蓝色' } }), /所有问题/);
  assert.throws(() => space.respond({ key, answers: { color: '蓝色', unknown: 'extra' }, skipped: ['note'] }), /未知问题/);
  assert.equal(calls.length, 0);
  space.respond({ key, answers: { color: '自定义银蓝色' }, skipped: ['note'] });
  assert.deepEqual(calls, [{ id: 'async', value: { answers: { color: { answers: ['自定义银蓝色'] } } } }]);
  assert.equal(thread.busy, true); assert.equal(thread.turnId, 'turn');
  assert.throws(() => space.respond({ key, decision: 'skip' }), /已结束/);
  const blocking = offer('blocking', true); assert.equal(threadDisplayState(thread).key, 'waiting');
  space.respond({ key: blocking, decision: 'skip' }); assert.deepEqual(calls.at(-1), { id: 'blocking', value: { answers: {} } });
  const expired = offer('expired');
  space.notification({ method: 'serverRequest/resolved', params: { threadId: 'different', requestId: 'expired' } }); assert.equal(thread.requests.length, 1);
  space.notification({ method: 'serverRequest/resolved', params: { threadId: 'one', requestId: 'expired' } });
  assert.throws(() => space.respond({ key: expired, answers: { color: '蓝色', note: '迟到的回答' } }), /已结束/);
  assert.equal(calls.length, 2);
});

test('question cards require explicit submission, offer inert choices/free text and skip without treating a default as an answer', t => {
  const dom = new JSDOM('<body></body>'); t.after(() => dom.window.close());
  const { document } = dom.window, calls = [];
  const request = { key: 'q', params: { isBlocking: false, questions: structuredClone(questions) } };
  request.params.questions[0].question = '<img src=x onerror=alert(1)>选择颜色';
  const card = createQuestionCard(request, (_, value) => calls.push(value), { doc: document }); document.body.append(card);
  assert.equal(card.querySelector('img'), null); assert.equal(card.querySelector('[type=radio]').checked, true); assert.equal(calls.length, 0);
  assert.match(card.textContent, /任务可以继续/); assert.equal(card.querySelector('[name=note]').type, 'password');
  const custom = card.querySelector('[name=color]'); custom.value = '海蓝'; custom.dispatchEvent(new dom.window.Event('input'));
  const skip = card.querySelectorAll('.question-skip input')[1]; skip.click();
  card.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  assert.deepEqual(calls[0], { answers: { color: '海蓝' }, skipped: ['note'] });
  card.querySelector('.request-actions [type=button]').click(); assert.deepEqual(calls[1], { decision: 'skip' });
  const older = createQuestionCard(request, () => {}, { doc: document, allowSkip: false });
  assert.equal(older.querySelector('.question-skip'), null); assert.equal(older.querySelector('.request-actions [type=button]'), null);
});

test('native async message questions survive history, steer the pinned turn and continue ended turns without changing permissions', async t => {
  const bridge = new EventEmitter(), calls = []; bridge.ready = true;
  bridge.request = async (method, params) => { calls.push({ method, params }); return method === 'turn/start' ? { turn: { id: 'continued', status: 'inProgress' } } : { thread: {} }; };
  const space = new Workspace(bridge, '/project'); t.after(() => { for (const timer of space.timers.values()) clearTimeout(timer); });
  const raw = { id: 'one', cwd: '/project', turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'q', type: 'agentMessage', text: '', delivery: 'async', questions: [{ title: '虚构配色？', options: ['蓝色', '银色'] }] }] }] };
  const thread = space.importThread(raw); space.resumed.add('one');
  assert.equal(thread.items[0].questions[0].question, '虚构配色？'); assert.equal(thread.requests.length, 1);
  assert.equal(threadDisplayState(thread).key, 'running');
  const key = thread.requests[0].key, id = asyncQuestionId('q', 0);
  await space.respond({ key, answers: { [id]: '银色' } });
  assert.equal(calls[0].method, 'turn/steer'); assert.equal(calls[0].params.expectedTurnId, 'turn');
  const text = calls[0].params.input[0].text;
  assert.deepEqual(questionReplies(text), [{ questionItemId: id, question: '虚构配色？', answer: '银色' }]);
  assert.equal(thread.requests.length, 0); assert.equal(thread.items[0].questionState, 'resolved'); assert.equal(thread.busy, true);
  assert.throws(() => space.respond({ key, decision: 'skip' }), /已结束/);
  const history = structuredClone(raw); history.turns[0].items.push({ id: 'reply', type: 'userMessage', content: [{ type: 'text', text }] });
  const resumed = new Workspace(bridge, '/project'); t.after(() => { for (const timer of resumed.timers.values()) clearTimeout(timer); });
  const recovered = resumed.importThread(history); assert.equal(recovered.requests.length, 0); assert.match(recovered.items[1].text, /回答：银色/); assert.ok(!recovered.items[1].text.includes('<send_user'));
  // A later question can also be answered after its turn completes.
  raw.turns[0].status = 'completed'; raw.turns[0].items[0].id = 'after';
  const ended = space.importThread(raw); const endedKey = ended.requests[0].key;
  await space.respond({ key: endedKey, answers: { [asyncQuestionId('after', 0)]: '自填答案' } });
  const continuation = calls.at(-1); assert.equal(continuation.method, 'turn/start');
  assert.deepEqual(Object.keys(continuation.params).sort(), ['input', 'threadId']);
  assert.equal(ended.busy, true); assert.equal(ended.turnId, 'continued');
  raw.turns[0].items[0].id = 'skip'; const skipped = space.importThread(raw), before = calls.length;
  await space.respond({ key: skipped.requests[0].key, decision: 'skip' });
  assert.equal(calls.length, before, 'dismissing an async question does not invent a user message');
  assert.equal(skipped.requests.length, 0);
});

test('answering a historical question rechecks the native latest turn before continuing', async t => {
  const bridge = new EventEmitter(), calls = []; bridge.ready = true;
  const raw = { id: 'foreign', cwd: '/project', turns: [{ id: 'old', status: 'completed', items: [{ id: 'q', type: 'agentMessage', text: '', delivery: 'async', questions: [{ title: '虚构问题？', options: ['蓝色'] }] }] }] };
  const latest = structuredClone(raw); latest.turns.push({ id: 'newer', status: 'completed', items: [] });
  bridge.request = async (method, params) => { calls.push({ method, params }); return { thread: method === 'thread/read' ? latest : raw }; };
  const space = new Workspace(bridge, '/project'); t.after(() => { for (const timer of space.timers.values()) clearTimeout(timer); });
  space.permissions.resolve = async () => ({ sandboxPolicy: {}, approvalPolicy: 'on-request' });
  const thread = space.importThread(raw), key = thread.requests[0].key;
  await assert.rejects(space.respond({ key, answers: { [asyncQuestionId('q', 0)]: '蓝色' } }), /其他客户端更新/);
  assert.deepEqual(calls.map(call => call.method), ['thread/resume', 'thread/read']);
  assert.equal(space.threads.get('foreign').requests.length, 0);
  assert.equal(space.threads.get('foreign').latestTurnId, 'newer');
});
