import { createImageAttachment } from './interactions.js';
import { projectPath } from './task-results.js';

export const executionTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'activitySummary', 'activityPlan']);
export const statusLabel = status => ({ pending: '待执行', inProgress: '进行中', completed: '已完成', failed: '失败', interrupted: '已中断', declined: '已拒绝', approved: '已批准', denied: '已拒绝' })[status] || status || '';
export const activityFailed = item => ['failed', 'declined', 'denied'].includes(item.status) || (typeof item.exitCode === 'number' && item.exitCode !== 0);

// Group only adjacent activity. A reply, file change or subtask stays at its
// original position and starts a new segment, even within the same turn.
export function executionLayout(items) {
  const blocks = []; let turn = 'history', preceding = 'start', section = null;
  for (const item of items) {
    turn = item.turnId || (item.type === 'userMessage' ? item.id : turn);
    if (executionTypes.has(item.type)) {
      if (!section || section.turnId !== turn) {
        section = { key: JSON.stringify([turn, preceding]), turnId: turn, items: [] };
        blocks.push(section);
      }
      section.items.push(item);
    } else { section = null; blocks.push({ item }); }
    preceding = item.id;
  }
  return blocks;
}

export function activityTitle(item) {
  if (item.type !== 'commandExecution') return item.title || '执行记录';
  const actions = (item.actions || []).map(action => {
    if (action.type === 'read') return `读取 ${action.name || action.path?.split('/').at(-1) || '文件'}`;
    if (action.type === 'listFiles') return `列出目录${action.path ? ` ${action.path}` : ''}`;
    if (action.type === 'search') return `搜索${action.query ? ` ${action.query}` : '文件内容'}`;
    return '执行命令';
  });
  return [...new Set(actions)].join(' · ') || '执行命令';
}

const views = new WeakMap();
const update = (node, value = '') => { const content = String(value ?? ''); if (node.textContent !== content) node.textContent = content; };
const durationLabel = ms => !Number.isFinite(ms) || ms < 0 ? '' : ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`;

// Render the patch supplied by the runtime. Never apply it to an editor buffer
// or infer that an in-progress/failed operation has written its proposed text.
export function fileChangeLines(value) {
  const source = String(value || ''), text = source.slice(0, 200_000), lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const truncated = source.length > text.length || lines.length > 3000;
  let oldLine = null, newLine = null, oldLeft = 0, newLeft = 0, known = false, added = 0, removed = 0;
  const rows = lines.slice(0, 3000).map(content => {
    const hunk = content.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldLeft = Number(hunk[2] ?? 1); newLeft = Number(hunk[4] ?? 1); known = true;
      return { kind: 'hunk', text: content };
    }
    const prefix = content[0];
    if (oldLine !== null && (oldLeft > 0 || newLeft > 0)) {
      if (prefix === '+' && newLeft > 0) { added++; newLeft--; return { kind: 'add', newLine: newLine++, text: content.slice(1) }; }
      if (prefix === '-' && oldLeft > 0) { removed++; oldLeft--; return { kind: 'remove', oldLine: oldLine++, text: content.slice(1) }; }
      if (prefix === ' ' && oldLeft > 0 && newLeft > 0) { oldLeft--; newLeft--; return { kind: 'context', oldLine: oldLine++, newLine: newLine++, text: content.slice(1) }; }
    }
    return { kind: 'meta', text: content };
  });
  return { rows, added, removed, known: known && !truncated, truncated };
}

function renderFileChanges(view, item, { state, cwd, onOpenFile }) {
  const document = view.files.ownerDocument;
  const node = (tag, className, parent) => { const value = document.createElement(tag); value.className = className; parent?.append(value); return value; };
  const changes = Array.isArray(item.changes) ? item.changes : [];
  update(view.title, `修改文件${changes.length ? ` · ${changes.length}` : ''}`);
  update(view.fileHint, ({
    running: '正在修改 · 实时展示本次差异，完成后同步已打开的文件',
    completed: '已应用的修改记录 · 点击文件名查看当前磁盘内容',
    waiting: '等待审批 · 以下是待确认的修改',
    failed: '修改未成功完成 · 以下差异不代表全部已写入',
    interrupted: '修改已中断 · 写入结果需核对',
    unknown: '状态待同步 · 保留最后收到的修改内容',
  })[state] || '等待文件修改结果');
  const selected = changes.slice(0, view.fileLimit), keys = new Set(selected.map((change, index) => `${index}:${change.path}`));
  for (const [key, file] of view.fileViews) if (!keys.has(key)) { file.el.remove(); view.fileViews.delete(key); }
  for (const [index, change] of selected.entries()) {
    const key = `${index}:${change.path}`; let file = view.fileViews.get(key);
    if (!file) {
      const el = node('details', 'file-change-file', view.files); el.open = true;
      const heading = node('summary', 'file-change-heading', el);
      file = { el, kind: node('span', 'file-change-kind', heading), path: node('button', 'file-change-path', heading), counts: node('span', 'file-change-counts', heading), rows: [], limit: 160 };
      file.path.type = 'button';
      file.scroller = node('div', 'file-diff-scroll', el); file.scroller.tabIndex = 0; file.scroller.setAttribute('role', 'region');
      file.lines = node('div', 'file-diff-lines', file.scroller);
      file.hint = node('p', 'file-diff-hint', el);
      file.more = node('button', 'text-button file-diff-more', el); file.more.type = 'button';
      file.more.onclick = () => { file.limit += 160; file.paint(); };
      file.path.onclick = async event => {
        event.preventDefault(); event.stopPropagation();
        if (!file.entry || !file.onOpenFile || file.opening) return;
        file.opening = true;
        try { await file.onOpenFile(file.entry); }
        catch (error) { update(view.fileFeedback, error.message); view.fileFeedback.hidden = false; }
        finally { file.opening = false; }
      };
      file.paint = () => {
        const data = file.parsed, visible = data.rows.slice(0, file.limit);
        while (file.rows.length > visible.length) file.rows.pop().el.remove();
        for (const [rowIndex, row] of visible.entries()) {
          let entry = file.rows[rowIndex];
          if (!entry) {
            const el = node('div', 'file-diff-line', file.lines);
            entry = { el, old: node('span', 'file-diff-number', el), next: node('span', 'file-diff-number', el), sign: node('span', 'file-diff-sign', el), code: node('span', 'file-diff-code', el) };
            entry.old.setAttribute('aria-hidden', 'true'); entry.next.setAttribute('aria-hidden', 'true'); file.rows.push(entry);
          }
          entry.el.dataset.kind = row.kind;
          update(entry.old, row.oldLine); update(entry.next, row.newLine);
          update(entry.sign, row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : '');
          const code = row.text || ' ';
          if (code !== entry.codeText) {
            if (entry.codeText && code.startsWith(entry.codeText)) entry.code.firstChild?.appendData(code.slice(entry.codeText.length));
            else update(entry.code, code);
          }
          entry.codeText = code;
        }
        file.more.hidden = visible.length >= data.rows.length;
        update(file.more, `展开更多（还剩 ${data.rows.length - visible.length} 行）`);
        update(file.hint, !data.rows.length ? '运行时尚未提供文本差异。' : data.truncated ? '差异较长，此处最多展示前 3,000 行 / 200,000 字符。' : '');
        file.hint.hidden = !!data.rows.length && !data.truncated;
      };
      view.fileViews.set(key, file);
    }
    const path = projectPath(change.path, cwd), target = change.movePath ? projectPath(change.movePath, cwd) : path;
    const destination = item.status === 'completed' ? target : path;
    file.entry = destination && path && target && change.kind !== 'delete' && (change.kind !== 'add' || item.status === 'completed') ? { cwd, path: destination } : null;
    file.onOpenFile = onOpenFile;
    file.path.disabled = !file.entry || !onOpenFile;
    const label = path || String(change.path || '未提供路径');
    update(file.path, change.movePath ? `${label} → ${target || change.movePath}` : label);
    file.path.title = file.path.disabled ? String(change.path || '') : `在编辑器打开当前磁盘版本：${destination}`;
    file.path.setAttribute('aria-label', file.path.title);
    update(file.kind, change.movePath ? '重命名' : ({ add: '新增', delete: '删除' })[change.kind] || '编辑');
    file.scroller.setAttribute('aria-label', `${label} 的修改差异，左侧旧行号，右侧新行号`);
    if (!file.parsed || file.diff !== change.diff) {
      file.diff = change.diff; file.parsed = fileChangeLines(change.diff);
      update(file.counts, file.parsed.known ? `+${file.parsed.added}  −${file.parsed.removed}` : '差异预览');
      file.paint();
    }
  }
  update(view.fileOverflow, !changes.length ? item.text || '等待运行时返回文件路径和修改内容…' : '');
  view.fileOverflow.hidden = !!changes.length;
  view.filesMore.hidden = changes.length <= selected.length;
  update(view.filesMore, `展开更多文件（另有 ${changes.length - selected.length} 个文件）`);
  view.filesMore.onclick = () => { view.fileLimit += 12; renderFileChanges(view, item, { state, cwd, onOpenFile }); };
  const output = String(item.output || '');
  view.fileLog.hidden = !output;
  if (output !== view.lastOutput) {
    if (view.lastOutput && output.startsWith(view.lastOutput)) view.log.append(document.createTextNode(output.slice(view.lastOutput.length)));
    else update(view.log, output);
    view.lastOutput = output;
  }
}

const markerText = state => ({ completed: '✓', failed: '!', interrupted: 'Ⅱ', waiting: 'Ⅱ', unknown: '·' })[state] || '';
export function activityState(item, { live = true, waiting = false, active = true } = {}) {
  if (activityFailed(item)) return 'failed';
  if (item.status === 'completed') return 'completed';
  if (item.status === 'interrupted') return 'interrupted';
  if (item.status === 'inProgress') {
    if (item.turnStatus && item.turnStatus !== 'inProgress') return item.turnStatus === 'interrupted' ? 'interrupted' : 'unknown';
    if (!live || !active) return 'unknown';
    return waiting ? 'waiting' : 'running';
  }
  return 'pending';
}

const groupViews = new WeakMap();
export function renderExecutionGroup(group, { items, active, interrupted = false, live = true, waiting = false }) {
  let view = groupViews.get(group);
  if (!view) {
    const document = group.ownerDocument, summary = group.firstElementChild || group.appendChild(document.createElement('summary'));
    summary.classList.add('execution-heading'); summary.replaceChildren();
    const span = className => { const element = document.createElement('span'); element.className = className; summary.append(element); return element; };
    view = { marker: span('execution-indicator'), title: span('execution-label'), count: span('execution-count'), status: span('execution-status'), flow: span('execution-flow') };
    view.marker.setAttribute('aria-hidden', 'true'); view.flow.setAttribute('aria-hidden', 'true'); update(view.title, '执行过程'); groupViews.set(group, view);
  }
  const failures = items.filter(activityFailed).length, running = items.findLast(item => item.status === 'inProgress');
  const state = active ? !live ? 'unknown' : waiting ? 'waiting' : 'running' : interrupted ? 'interrupted' : failures ? 'failed' : 'finished';
  const label = active ? !live ? '状态待同步' : waiting ? '等待你处理' : `进行中${running ? ` · ${activityTitle(running)}` : ''}` : interrupted ? '已中断' : '已结束';
  group.dataset.executionState = state;
  group.classList.toggle('has-failures', !!failures);
  update(view.marker, markerText(state)); update(view.count, `· ${items.length} 项`);
  update(view.status, `· ${label}${failures ? ` · ${failures} 项需查看` : ''}`);
}

export function renderActivity(element, item, { live = true, waiting = false, active = true, animate = false, cwd, onOpenFile } = {}) {
  let view = views.get(element);
  const document = element.ownerDocument;
  const motion = animate && live && document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches !== true;
  const node = (tag, className, parent) => { const value = document.createElement(tag); value.className = className; parent?.append(value); return value; };
  const narrative = ['activitySummary', 'activityPlan'].includes(item.type);
  if (!view || view.type !== item.type) {
    element.replaceChildren(); element.className = `tool activity${narrative ? ' activity-narrative' : ''}`;
    const details = narrative ? node('div', 'activity-body', element) : node('details', 'activity-details', element);
    const heading = node(narrative ? 'div' : 'summary', 'activity-heading', details);
    view = { type: item.type, details, marker: node('span', 'activity-marker', heading), title: node('span', 'tool-title', heading), status: node('span', 'activity-status', heading), duration: node('span', 'activity-duration', heading) };
    view.marker.setAttribute('aria-hidden', 'true');
    if (motion && active && (!item.turnStatus || item.turnStatus === 'inProgress')) element.classList.add('activity-enter');
    element.addEventListener('animationend', event => { if (event.animationName === 'execution-enter') element.classList.remove('activity-enter'); if (event.animationName === 'execution-complete') view.marker.classList.remove('just-completed'); });
    if (item.type === 'fileChange') {
      element.classList.add('file-change-activity'); details.open = true;
      view.fileHint = node('p', 'file-change-hint', details);
      view.files = node('div', 'file-change-files', details); view.fileViews = new Map(); view.fileLimit = 12;
      view.fileOverflow = node('p', 'file-diff-hint', details);
      view.filesMore = node('button', 'text-button file-diff-more', details); view.filesMore.type = 'button';
      view.fileFeedback = node('p', 'file-change-feedback', details); view.fileFeedback.hidden = true; view.fileFeedback.setAttribute('role', 'status');
      view.fileLog = node('details', 'file-change-log', details); update(node('summary', '', view.fileLog), '执行输出');
      view.log = node('pre', 'activity-log', view.fileLog);
    } else if (narrative) {
      view.text = node('div', 'activity-narrative-text', details);
      view.steps = node('ol', 'activity-steps', details);
    } else {
      view.hint = node('div', 'activity-hint', element);
      view.progress = node('div', 'activity-progress', element);
      view.surface = node('div', 'activity-surface', element);
      view.images = node('div', 'activity-images', element);
      view.imageHint = node('div', 'activity-image-hint', element);
      view.meta = node('div', 'activity-meta', details);
      view.command = node('pre', 'activity-command', details);
      view.outputLabel = node('div', 'activity-output-label', details);
      view.output = node('pre', 'activity-output', details);
      view.log = node('pre', 'activity-log', details);
    }
    views.set(element, view);
  }
  if (item.type !== 'fileChange') update(view.title, activityTitle(item));
  const turnEnded = item.turnStatus && item.turnStatus !== 'inProgress';
  const state = activityState(item, { live, waiting, active });
  if (motion && view.state === 'running' && state === 'completed') view.marker.classList.add('just-completed');
  if (state !== 'completed') view.marker.classList.remove('just-completed');
  view.state = state; element.dataset.executionState = state; update(view.marker, markerText(state));
  update(view.status, item.status === 'inProgress' && turnEnded ? '已结束，状态未返回' : item.status === 'inProgress' && state === 'unknown' ? '状态待同步' : item.status === 'inProgress' && waiting ? '等待你处理' : activityFailed(item) ? statusLabel(['declined', 'denied'].includes(item.status) ? item.status : 'failed') : statusLabel(item.status));
  update(view.duration, durationLabel(item.durationMs));
  element.classList.toggle('has-failures', activityFailed(item));
  if (item.type === 'fileChange') {
    renderFileChanges(view, item, { state, cwd, onOpenFile });
    return;
  }
  if (narrative) {
    update(view.text, item.text); view.text.hidden = !item.text;
    const steps = item.steps || [];
    while (view.steps.children.length > steps.length) view.steps.lastElementChild.remove();
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index], row = view.steps.children[index] || node('li', '', view.steps);
      row.dataset.status = step.status;
      update(row, `${turnEnded && step.status === 'inProgress' ? '未确认完成' : statusLabel(step.status)} · ${step.step}`);
    }
    view.steps.hidden = !steps.length;
    return;
  }
  const command = item.type === 'commandExecution' ? item.title || item.command || '' : '';
  const attachments = item.attachments || [];
  update(view.surface, item.surface ? `${item.surface.label} · ${item.surface.kind === 'browser' ? '浏览器操作' : '电脑操作'}` : ''); view.surface.hidden = !item.surface;
  const imageSignature = JSON.stringify(attachments);
  if (view.imageSignature !== imageSignature) {
    view.images.replaceChildren(...attachments.map(attachment => createImageAttachment(attachment, { document })));
    view.imageSignature = imageSignature;
  }
  view.images.hidden = !attachments.length;
  update(view.imageHint, attachments.length ? `此步骤返回的图片 · 点击放大${item.omittedImages ? ` · 另有 ${item.omittedImages} 张未展示` : ''}` : '');
  view.imageHint.hidden = !attachments.length;
  update(view.hint, command); view.hint.title = command; view.hint.hidden = !command;
  update(view.command, command); view.command.hidden = !command;
  update(view.meta, [item.cwd && `目录：${item.cwd}`, item.exitCode != null && `退出码：${item.exitCode}`].filter(Boolean).join(' · ')); view.meta.hidden = !view.meta.textContent;
  const progress = (item.progress || []).join('\n');
  update(view.progress, item.progress?.at(-1)); view.progress.hidden = !item.progress?.length;
  update(view.log, [progress, item.output].filter(Boolean).join('\n')); view.log.hidden = !view.log.textContent;
  update(view.outputLabel, `输出${item.outputTruncated ? '（内容过长，已截断）' : ''}`);
  const output = item.text || (item.status === 'inProgress' ? '等待输出…' : '本步骤没有文本输出');
  // Keep the same output node, scroll and selected text during streamed appends.
  if (output !== view.lastOutput) {
    if (view.lastOutput && output.startsWith(view.lastOutput)) view.output.append(document.createTextNode(output.slice(view.lastOutput.length)));
    else update(view.output, output);
  }
  view.lastOutput = output;
}
