import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEventStream, prepareThread } from '../lib/event-stream.mjs';
import { applyThreadPatch } from '../public/interactions.js';

class Socket extends EventEmitter {
  frames = []; writableLength = 0; blocked = false; destroyed = false;
  write(frame) { this.frames.push(frame); this.writableLength += Buffer.byteLength(frame); return !this.blocked; }
  drain() { this.writableLength = 0; this.blocked = false; this.emit('drain'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  end() { this.emit('close'); }
}
const decode = frame => ({ event: frame.split('\n')[0].slice(7), data: JSON.parse(frame.split('\n')[1].slice(6)) });
const history = () => ({ id: 'one', revision: 1, busy: false, requests: [], items: [{ id: 'old', type: 'commandExecution', text: 'x'.repeat(16 * 1024 * 1024) }] });

test('16 MB history drains without disconnect; updates coalesce and only changed items are transmitted', t => {
  const res = new Socket(); res.blocked = true;
  const client = createEventStream(res, { delta: true }); t.after(() => client.close());
  const thread = history(); client.snapshot(true, [prepareThread(thread)]);
  assert.ok(res.writableLength > 8 * 1024 * 1024);
  for (let revision = 2; revision <= 100; revision++) {
    thread.revision = revision; thread.busy = true;
    thread.items[1] = { id: 'reply', type: 'agentMessage', text: `回复 ${revision}` };
    client.thread(prepareThread(thread));
  }
  assert.equal(res.destroyed, false);
  assert.equal(res.frames.length, 1, 'no extra full histories queued behind a blocked socket');
  res.drain();
  assert.equal(res.frames.length, 2);
  const patch = decode(res.frames[1]);
  assert.equal(patch.event, 'thread-patch'); assert.ok(res.frames[1].length < 1000);
  assert.equal(patch.data.baseRevision, 1); assert.equal(patch.data.thread.revision, 100);
  const restored = applyThreadPatch(decode(res.frames[0]).data.threads[0], patch.data);
  assert.deepEqual(restored, thread); assert.equal(res.destroyed, false);
  // Removal of a provisional message, reordering, final status, and approval
  // resolution must survive coalescing just like streamed text.
  thread.revision++; thread.busy = false; thread.items = [{ id: 'final', text: 'done' }, thread.items[0]];
  client.thread(prepareThread(thread));
  assert.deepEqual(applyThreadPatch(restored, decode(res.frames[2]).data), thread);
});

test('legacy pages still receive full state after backpressure; stalled and closed streams release pending work', async t => {
  const res = new Socket(); res.blocked = true; let closed = 0;
  const client = createEventStream(res, { stallMs: 30, onClose: () => closed++ }); t.after(() => client.close());
  const thread = { id: 'one', revision: 1, items: [] };
  client.snapshot(true, [prepareThread(thread)]);
  client.thread(prepareThread({ ...thread, revision: 2, busy: true }));
  client.connection({ connected: false }); client.connection({ connected: true });
  res.drain();
  assert.equal(decode(res.frames[1]).event, 'thread');
  assert.equal(decode(res.frames[1]).data.busy, true);
  assert.deepEqual(decode(res.frames[2]).data, { connected: true });
  res.blocked = true; client.thread(prepareThread(thread));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(res.destroyed, true); assert.equal(closed, 1);
  const count = res.frames.length; client.thread(prepareThread(thread)); res.drain();
  assert.equal(res.frames.length, count);
});

test('delta versions are independent for fast and slow tabs; corrupt baselines request a fresh snapshot', t => {
  const slow = new Socket(), fast = new Socket(); slow.blocked = true;
  const a = createEventStream(slow, { delta: true }), b = createEventStream(fast, { delta: true });
  t.after(() => { a.close(); b.close(); });
  const thread = { id: 'one', revision: 1, items: [{ id: 'msg', text: 'first' }] };
  a.snapshot(true, [prepareThread(thread)]); b.snapshot(true, [prepareThread(thread)]);
  for (let revision = 2; revision <= 4; revision++) {
    thread.revision = revision; thread.items[0].text = `changed ${revision}`;
    const prepared = prepareThread(thread); a.thread(prepared); b.thread(prepared);
  }
  slow.drain();
  assert.equal(decode(slow.frames[1]).data.baseRevision, 1);
  assert.equal(decode(fast.frames[3]).data.baseRevision, 3);
  assert.throws(() => applyThreadPatch(thread, decode(slow.frames[1]).data), /版本/);
  const first = decode(slow.frames[0]).data.threads[0];
  assert.equal(first.items[0].text, 'first', 'in-place mutation must not mutate the wire baseline');
  assert.throws(() => applyThreadPatch(first, { ...decode(slow.frames[1]).data, order: ['missing'] }), /缺失/);
});
