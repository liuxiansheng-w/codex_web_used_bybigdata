export const executionTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'activitySummary', 'activityPlan']);
export const statusLabel = status => ({ pending: '待执行', inProgress: '进行中', completed: '已完成', failed: '失败', interrupted: '已中断', declined: '已拒绝', approved: '已批准', denied: '已拒绝' })[status] || status || '';
export const activityFailed = item => ['failed', 'declined', 'denied'].includes(item.status) || (typeof item.exitCode === 'number' && item.exitCode !== 0);

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

export function renderActivity(element, item) {
  let view = views.get(element);
  const document = element.ownerDocument;
  const node = (tag, className, parent) => { const value = document.createElement(tag); value.className = className; parent?.append(value); return value; };
  const narrative = ['activitySummary', 'activityPlan'].includes(item.type);
  if (!view || view.type !== item.type) {
    element.replaceChildren(); element.className = `tool activity${narrative ? ' activity-narrative' : ''}`;
    const details = narrative ? node('div', 'activity-body', element) : node('details', 'activity-details', element);
    const heading = node(narrative ? 'div' : 'summary', 'activity-heading', details);
    view = { type: item.type, details, title: node('span', 'tool-title', heading), status: node('span', 'activity-status', heading), duration: node('span', 'activity-duration', heading) };
    if (narrative) {
      view.text = node('div', 'activity-narrative-text', details);
      view.steps = node('ol', 'activity-steps', details);
    } else {
      view.hint = node('div', 'activity-hint', element);
      view.progress = node('div', 'activity-progress', element);
      view.meta = node('div', 'activity-meta', details);
      view.command = node('pre', 'activity-command', details);
      view.outputLabel = node('div', 'activity-output-label', details);
      view.output = node('pre', 'activity-output', details);
      view.log = node('pre', 'activity-log', details);
    }
    views.set(element, view);
  }
  update(view.title, activityTitle(item));
  const turnEnded = item.turnStatus && item.turnStatus !== 'inProgress';
  update(view.status, item.status === 'inProgress' && turnEnded ? '已结束，状态未返回' : activityFailed(item) ? statusLabel(['declined', 'denied'].includes(item.status) ? item.status : 'failed') : statusLabel(item.status));
  update(view.duration, durationLabel(item.durationMs));
  element.classList.toggle('has-failures', activityFailed(item));
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
