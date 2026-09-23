import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createEditorLayout, dockSplit } from '../public/editor-window.js';
import { threadDisplayState } from '../public/interactions.js';

test('session states distinguish pending approval, running, queues, idle and unverified history', () => {
  assert.equal(threadDisplayState(null).label, '未开始');
  assert.equal(threadDisplayState({ title: 'Historical' }).key, 'unknown');
  assert.equal(threadDisplayState({ busy: false }).label, '空闲');
  assert.equal(threadDisplayState({ busy: true, requests: [{ method: 'item/tool/requestUserInput' }] }).label, '待回复');
  assert.equal(threadDisplayState({ busy: true, requests: [{ method: 'item/fileChange/requestApproval' }] }).label, '待确认');
  assert.equal(threadDisplayState({ busy: true }).label, '运行中');
  assert.equal(threadDisplayState({ busy: false, queuePaused: true, queue: [{}, {}] }).label, '队列暂停 · 2');
  assert.equal(threadDisplayState({ busy: false, error: 'Connection dropped' }).label, '需检查');
  assert.equal(threadDisplayState({ busy: false, completion: 'completed' }).label, '已完成');
  assert.equal(threadDisplayState({ busy: true }, false).label, '待核实');
  assert.equal(threadDisplayState({ busy: true, runtimeStale: true }).label, '待核实');
  assert.equal(threadDisplayState({ busy: false, completion: 'completed' }, false).label, '待核实');
});

test('split geometry keeps both panes reachable across desktop, narrow and short containers', () => {
  for (const length of [280, 480, 739, 740, 1100, 3840]) for (const ratio of [-2, 0, .2, .56, .95, 2, NaN]) for (const stacked of [false, true]) {
    const split = dockSplit(length, ratio, stacked);
    assert.ok(Number.isFinite(split.size)); assert.ok(split.size >= split.min && split.size <= split.max);
    assert.ok(split.size > 0 && split.size < split.total); assert.equal(split.total, length - 8);
  }
});

test('dock drag, keyboard resize, cancellation and floating mode preserve buffers and persisted geometry', async t => {
  const dom = new JSDOM(await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), { url: 'http://localhost' });
  const { window } = dom, document = window.document, saved = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  Object.assign(globalThis, { window, document, localStorage: window.localStorage });
  t.after(() => { Object.assign(globalThis, saved); window.close(); });
  const $ = id => document.getElementById(id), container = $('workspacePanes'), pane = $('fileEditor'), divider = $('editorDivider');
  let width = 1200, height = 900, captured;
  container.getBoundingClientRect = () => ({ width, height });
  divider.setPointerCapture = id => { captured = id; }; divider.hasPointerCapture = id => captured === id; divider.releasePointerCapture = () => { captured = null; };
  const dispatch = (element, type, data = {}) => { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, data); element.dispatchEvent(event); };
  const pointer = (type, x, y = 0) => dispatch(divider, type, { pointerId: 1, button: 0, clientX: x, clientY: y });
  const size = () => parseFloat(container.style.getPropertyValue('--editor-split-size'));
  const layout = createEditorLayout({ container, divider, modeButton: $('editorLayoutToggle'), pane, handle: $('editorDragHandle'), maximize: $('editorMaximize'), reset: $('editorResetWindow'), resizeHandles: [] });
  pane.hidden = false; layout.show(); assert.equal(layout.mode, 'docked'); assert.equal(divider.hidden, false);
  assert.equal(divider.getAttribute('aria-orientation'), 'vertical'); assert.equal($('editorMaximize').hidden, true);
  const initial = size(); pointer('pointerdown', 400); pointer('pointermove', 520); assert.ok(Math.abs(size() - initial - 120) < .001);
  dispatch(document, 'keydown', { key: 'Escape' }); assert.equal(size(), initial); assert.equal(captured, null);
  pointer('pointerdown', 400); pointer('pointermove', 470); pointer('pointerup', 470); assert.ok(Math.abs(size() - initial - 70) < .001); assert.ok(Number(localStorage.getItem('codex-desk:editorSplit')) > .56);
  dispatch(divider, 'keydown', { key: 'ArrowRight' }); assert.ok(Math.abs(size() - initial - 80) < .001);
  dispatch(divider, 'keydown', { key: 'End' }); assert.equal(Number(divider.getAttribute('aria-valuenow')), Number(divider.getAttribute('aria-valuemax')));
  dispatch(divider, 'dblclick'); assert.equal(size(), initial);
  const text = $('fileEditorText'); text.value = 'unsaved file'; text.setSelectionRange(2, 5); text.scrollTop = 30;
  $('editorLayoutToggle').click(); assert.equal(layout.mode, 'floating'); assert.equal(divider.hidden, true); assert.equal($('editorMaximize').hidden, false); assert.ok(pane.style.width.endsWith('px')); assert.equal(localStorage.getItem('codex-desk:editorLayout'), 'floating');
  $('editorLayoutToggle').click(); assert.equal(layout.mode, 'docked'); assert.equal(pane.style.width, ''); assert.equal($('fileEditorText'), text); assert.equal(text.value, 'unsaved file'); assert.equal(text.selectionStart, 2); assert.equal(text.scrollTop, 30);
  width = 600; dispatch(window, 'resize'); assert.equal(divider.getAttribute('aria-orientation'), 'horizontal'); assert.equal(container.classList.contains('editor-stacked'), true);
  const verticalSize = size(); pointer('pointerdown', 0, 400); pointer('pointermove', 0, 340); assert.ok(Math.abs(size() - verticalSize + 60) < .001); dispatch(divider, 'pointercancel'); assert.equal(size(), verticalSize);
  pane.hidden = true; layout.hide(); assert.equal(divider.hidden, true); assert.equal(text.value, 'unsaved file');
});
