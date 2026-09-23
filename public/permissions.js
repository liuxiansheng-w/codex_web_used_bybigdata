import { permissionPresets } from './permission-presets.js';
import { positionPopover } from './interactions.js';
const $ = id => document.getElementById(id);
const batchMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
const requestIdentity = request => JSON.stringify([request.method, request.params]);

// Reuse individual, authenticated responses. A batch is a fixed snapshot of
// visible requests, never a permission mode or a subscription to future requests.
export function createApprovalBatch({ api, getThread, isConnected = () => true, onChange = () => {}, onComplete = () => {} }) {
  const states = new Map(); let batch = null;
  const status = key => states.get(key) || {};
  function view() {
    const thread = getThread();
    if (batch && (!isConnected() || thread?.id !== batch.threadId)) batch.cancelled = true;
    const candidates = (thread?.requests || []).filter(request => batchMethods.has(request.method) && !status(request.key).done);
    return { candidates, busy: !!batch, batch: batch?.threadId === thread?.id ? batch : null, disabled: !isConnected() || !!batch || candidates.some(request => status(request.key).pending) };
  }
  async function respond(request, payload, fromBatch = false) {
    const thread = getThread(), current = thread?.requests?.find(item => item.key === request.key);
    if (!isConnected() || !current || requestIdentity(current) !== requestIdentity(request) || status(request.key).done || status(request.key).pending || batch && !fromBatch) return { skipped: true };
    states.set(request.key, { pending: true }); onChange();
    try {
      await api('/api/respond', { ...payload, key: request.key }, { signal: AbortSignal.timeout(20000) });
      states.set(request.key, { done: true }); return { approved: true };
    } catch (error) {
      if (error.status === 409) { states.set(request.key, { done: true }); return { skipped: true }; }
      states.set(request.key, { error: error.name === 'TimeoutError' ? '审批结果尚未确认，请稍后核对请求状态。' : error.message || '审批提交失败，请核对状态后重试。' });
      return { failed: true, stop: !error.status || [401, 403].includes(error.status) || error.status >= 500 };
    } finally { onChange(); }
  }
  async function approveAll() {
    const { candidates, disabled } = view(); if (disabled || !candidates.length) return;
    const snapshot = candidates.map(request => ({ ...request, params: structuredClone(request.params) }));
    const run = batch = { threadId: getThread().id, total: snapshot.length, processed: 0, approved: 0, failed: 0, skipped: 0, cancelled: false };
    onChange();
    try {
      for (const request of snapshot) {
        view(); if (run.cancelled) break;
        const result = await respond(request, { decision: 'accept' }, true);
        run.processed++; if (result.approved) run.approved++; else if (result.failed) run.failed++; else run.skipped++;
        onChange(); if (result.stop) break;
      }
    } finally {
      batch = null; onChange();
      if (getThread()?.id === run.threadId) onComplete(`已允许 ${run.approved} 项${run.failed ? `，${run.failed} 项提交失败` : ''}${run.skipped ? `，${run.skipped} 项已结束或变化` : ''}${run.processed < run.total ? `，剩余 ${run.total - run.processed} 项未提交` : ''}。`);
    }
  }
  return { status, view, respond, approveAll };
}

const icons = {
  'workspace-write': '<path d="M8 12V5a2 2 0 0 1 4 0v7M12 6a2 2 0 0 1 4 0v6m0-4a2 2 0 0 1 4 0v7a7 7 0 0 1-14 0l-2-4a2 2 0 0 1 3-2l1 3Z"/>',
  'auto-review': '<path d="M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  'danger-full-access': '<path d="M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6Z"/><path d="M12 7v6m0 3v.2"/>',
  'read-only': '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
};

export function createPermissionControl({ onChange, notice }) {
  let availability = null, blocked = false, plan = false, confirmed = false;
  const rows = new Map();
  const allowed = id => availability?.find(p => p.id === id)?.enabled ?? ['workspace-write', 'read-only'].includes(id);

  function closeMenu(focus = false) {
    $('permissionMenu').hidden = true; $('permissionButton').setAttribute('aria-expanded', 'false');
    if (focus) $('permissionButton').focus();
  }
  function render() {
    const mode = $('mode').value;
    const selected = permissionPresets.find(p => p.id === mode) || permissionPresets[0];
    $('permissionLabel').textContent = plan ? '只读 · 计划模式' : selected.title;
    $('permissionIcon').innerHTML = icons[plan ? 'read-only' : mode];
    $('permissionButton').classList.toggle('full-access', mode === 'danger-full-access' && !plan);
    $('permissionButton').disabled = blocked || plan;
    $('permissionButton').title = plan ? '计划模式强制只读；关闭计划模式后可选择审批权限。' : `${selected.description}。下条消息生效。`;
    $('fullAccessNotice').hidden = mode !== 'danger-full-access' || plan;
    for (const preset of permissionPresets) {
      const row = rows.get(preset.id);
      row.disabled = !allowed(preset.id);
      row.setAttribute('aria-checked', String(mode === preset.id));
      row.querySelector('.permission-check').hidden = mode !== preset.id;
      row.querySelector('small').textContent = availability?.find(p => p.id === preset.id)?.reason || preset.description;
    }
  }
  function choose(mode) {
    if (blocked || plan || !allowed(mode)) return;
    if (mode === 'danger-full-access' && !confirmed) {
      closeMenu(); $('fullAccessAcknowledged').checked = false; $('confirmFullAccess').disabled = true;
      $('fullAccessDialog').showModal(); $('cancelFullAccess').focus(); return;
    }
    if (mode !== 'danger-full-access') confirmed = false;
    $('mode').value = mode; render(); closeMenu(true); onChange();
  }
  for (const preset of permissionPresets) {
    const row = document.createElement('button'); row.type = 'button'; row.dataset.mode = preset.id;
    row.className = `permission-row${preset.id === 'danger-full-access' ? ' permission-danger' : ''}${preset.id === 'read-only' ? ' permission-extra' : ''}`;
    row.setAttribute('role', 'menuitemradio');
    // Labels here are fixed application strings, never model or user content.
    row.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[preset.id]}</svg><span><strong>${preset.title}</strong><small></small></span><span class="permission-check" aria-hidden="true">✓</span>`;
    row.addEventListener('click', () => choose(preset.id));
    rows.set(preset.id, row); $('permissionOptions').append(row);
  }
  $('permissionButton').addEventListener('click', () => {
    if (blocked || plan) return;
    const open = $('permissionMenu').hidden;
    $('permissionMenu').hidden = !open; $('permissionButton').setAttribute('aria-expanded', String(open));
    if (open) {
      $('addMenu').hidden = true; $('addButton').setAttribute('aria-expanded', 'false');
      positionPopover($('permissionButton'), $('permissionMenu'));
      (rows.get($('mode').value)?.disabled ? [...rows.values()].find(r => !r.disabled) : rows.get($('mode').value))?.focus();
    }
  });
  document.addEventListener('click', e => { if (!e.target.closest('.permission-control')) closeMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('permissionMenu').hidden) { e.preventDefault(); closeMenu(true); } });
  $('permissionMenu').addEventListener('focusout', e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) closeMenu(); });
  $('permissionOptions').addEventListener('keydown', e => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); const enabled = [...rows.values()].filter(row => !row.disabled);
    if (!enabled.length) return;
    const index = enabled.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? enabled.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
    enabled[next].focus();
  });
  function cancel() { $('fullAccessDialog').close(); $('permissionButton').focus(); }
  $('closeFullAccess').addEventListener('click', cancel); $('cancelFullAccess').addEventListener('click', cancel);
  $('fullAccessAcknowledged').addEventListener('change', () => { $('confirmFullAccess').disabled = !$('fullAccessAcknowledged').checked; });
  $('fullAccessForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!$('fullAccessAcknowledged').checked || blocked || plan || !allowed('danger-full-access')) return;
    confirmed = true; $('fullAccessDialog').close(); choose('danger-full-access');
  });
  render();
  return {
    setAvailability(value) { availability = value?.options || null; render(); },
    setBusy(value, planning = false) { blocked = value; plan = planning; if (blocked || plan) closeMenu(); render(); },
    beforeSend() { if ($('mode').value === 'danger-full-access' && !confirmed && !plan) { choose('danger-full-access'); return false; } return true; },
    payload() { return { mode: $('mode').value, fullAccessConfirmed: confirmed && $('mode').value === 'danger-full-access' }; },
    restore(thread) {
      confirmed = false;
      const previous = thread.mode || 'workspace-write';
      $('mode').value = previous === 'danger-full-access' ? 'workspace-write' : previous;
      if (previous === 'danger-full-access') notice('这条会话曾使用完全访问权限。本页已恢复请求批准，如需继续完全访问，请重新选择并确认。');
      closeMenu(); render();
    },
    reset() { confirmed = false; $('mode').value = 'workspace-write'; $('fullAccessDialog').close(); closeMenu(); render(); },
  };
}
