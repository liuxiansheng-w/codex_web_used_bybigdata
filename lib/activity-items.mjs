// Public activity only. Never forward raw reasoning, tool arguments or credentials.
const text = (value, limit = 100_000) => typeof value === 'string' ? value.slice(0, limit) : '';
const duration = item => Number.isFinite(item.durationMs) && item.durationMs >= 0 ? { durationMs: item.durationMs } : {};

export function visibleActivity(item) {
  const base = { id: item.id, type: item.type };
  if (item.type === 'reasoning') {
    const summary = (Array.isArray(item.summary) ? item.summary : []).filter(part => typeof part === 'string').slice(0, 100).map(part => text(part, 2000));
    return summary.some(Boolean) ? { ...base, type: 'activitySummary', title: '工作摘要', summary, text: summary.join('\n\n') } : null;
  }
  if (item.type === 'commandExecution') return {
    ...base, title: text(item.command), text: text(item.aggregatedOutput), outputTruncated: (item.aggregatedOutput?.length || 0) > 100_000,
    cwd: text(item.cwd, 4000), status: item.status, exitCode: item.exitCode, ...duration(item),
    actions: (item.commandActions || []).slice(0, 50).map(action => ({ type: action.type, name: text(action.name, 1000), path: text(action.path, 4000), query: text(action.query, 2000) })),
  };
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return {
    ...base, title: `${item.server || item.namespace || '工具'} / ${item.tool}`, ...duration(item),
    text: text(item.error?.message || (item.result || item.contentItems ? JSON.stringify(item.result || item.contentItems, null, 2) : '')),
    status: item.success === false || item.result?.isError ? 'failed' : item.status,
  };
  if (item.type === 'webSearch') {
    const action = item.action || {}, type = action.type;
    return { ...base, title: ['openPage', 'open_page'].includes(type) ? '打开网页' : ['findInPage', 'find_in_page'].includes(type) ? '查找网页内容' : '搜索网页',
      text: text([action.query || item.query, ...(action.queries || []), action.url, action.pattern].filter(Boolean).join('\n')), status: item.status || 'completed' };
  }
  if (item.type === 'imageView') return { ...base, title: '查看图片', text: text(item.path, 4000), status: 'completed' };
  return null;
}

export function activityNotification(thread, method, params) {
  const turnId = params.turnId || thread.turnId || thread.latestTurnId;
  if (method === 'turn/plan/updated' && turnId) {
    const id = `activity-plan:${turnId}`, previous = thread.items.find(item => item.id === id);
    const plan = (Array.isArray(params.plan) ? params.plan : []).slice(0, 100).map(step => ({ step: text(step.step, 2000), status: ['pending', 'inProgress', 'completed'].includes(step.status) ? step.status : 'pending' }));
    const item = { id, turnId, type: 'activityPlan', title: '任务计划', steps: plan, text: text(params.explanation, 4000) };
    if (previous) Object.assign(previous, item); else thread.items.push(item);
    return true;
  }
  if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/summaryPartAdded') {
    if (!params.itemId || !Number.isInteger(params.summaryIndex) || params.summaryIndex < 0 || params.summaryIndex >= 100) return false;
    let item = thread.items.find(item => item.id === params.itemId);
    if (item && item.type !== 'activitySummary') return false;
    if (!item) { item = { id: params.itemId, turnId, type: 'activitySummary', title: '工作摘要', summary: [], text: '', status: 'inProgress' }; thread.items.push(item); }
    item.summary[params.summaryIndex] = text((item.summary[params.summaryIndex] || '') + text(params.delta, 2000), 2000);
    item.text = item.summary.filter(Boolean).join('\n\n');
    return true;
  }
  if (method === 'item/mcpToolCall/progress') {
    const item = thread.items.find(item => item.id === params.itemId && item.type === 'mcpToolCall');
    if (!item || item.status !== 'inProgress' || typeof params.message !== 'string') return false;
    const message = text(params.message, 2000);
    item.progress = [...(item.progress || []).filter(line => line !== message), message].slice(-30);
    return true;
  }
  if (method === 'item/fileChange/outputDelta') {
    const item = thread.items.find(item => item.id === params.itemId && item.type === 'fileChange');
    if (!item) return false;
    item.output = ((item.output || '') + text(params.delta)).slice(-100_000);
    return true;
  }
  return false;
}
