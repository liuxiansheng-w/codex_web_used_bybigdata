const validTime = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime());

export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return '不到 1 秒';
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return [hours ? `${hours} 小时` : '', minutes % 60 ? `${minutes % 60} 分钟` : '', seconds % 60 ? `${seconds % 60} 秒` : ''].filter(Boolean).join(' ');
}

export function messageClock(item, now = Date.now()) {
  if (!validTime(item.timestamp)) return { text: '时间未记录', title: '这条历史消息没有可用的时间记录。', datetime: null };
  const date = new Date(item.timestamp), today = new Date(now), clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const sameDay = date.toDateString() === today.toDateString();
  const prefix = sameDay ? '' : date.getFullYear() === today.getFullYear() ? `${date.getMonth() + 1}月${date.getDate()}日 ` : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} `;
  const source = { observed: '本机记录时间', turnStart: '本轮开始时间（历史未提供逐条发送时间）', turnEnd: '本轮结束时间（历史未提供逐条回复时间）', history: '消息记录时间', native: '消息时间' }[item.timestampSource] || '消息时间';
  return { text: prefix + clock, title: `${source}：${date.toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' })}`, datetime: date.toISOString() };
}

export function turnDuration(thread, turnId, live = true, now = Date.now()) {
  const timing = thread?.turnTimings?.find(turn => turn.id === turnId);
  if (!timing) return null;
  const ended = ['completed', 'interrupted', 'failed'].includes(timing.status);
  if (!ended && (!live || thread.runtimeStale || !thread.busy || thread.turnId !== turnId)) return { text: '耗时待同步', title: '恢复连接后核对本轮耗时。' };
  const elapsed = ended ? timing.durationMs : validTime(timing.startedAt) ? Math.max(0, now - timing.startedAt) : null;
  const formatted = formatDuration(elapsed);
  if (!formatted) return null;
  const suffix = timing.status === 'interrupted' ? ' · 已停止' : timing.status === 'failed' ? ' · 未完成' : '';
  return { text: `${ended ? '用时' : '已用时'}${timing.estimated ? '约' : ''} ${formatted}${suffix}`, title: '本轮从开始到结束的总耗时，包含工具执行和等待确认时间。' };
}

export function renderMessageTimes(thread, elements, live = true, now = Date.now()) {
  const lastReplies = new Map();
  for (const item of thread?.items || []) if (item.type === 'agentMessage' && item.turnId) lastReplies.set(item.turnId, item.id);
  for (const item of thread?.items || []) {
    if (!['userMessage', 'agentMessage', 'plan'].includes(item.type)) continue;
    const element = elements.get(item.id); if (!element) continue;
    let time = element.querySelector('.message-time');
    if (!time) { time = document.createElement('time'); time.className = 'message-time'; element.append(time); }
    const clock = messageClock(item, now);
    if (time.textContent !== clock.text) time.textContent = clock.text;
    time.title = clock.title;
    if (clock.datetime) time.setAttribute('datetime', clock.datetime); else time.removeAttribute('datetime');
    const duration = element.querySelector('.turn-duration');
    if (!duration) continue;
    const info = item.type === 'agentMessage' && lastReplies.get(item.turnId) === item.id ? turnDuration(thread, item.turnId, live, now) : null;
    duration.hidden = !info;
    if (info) { if (duration.textContent !== info.text) duration.textContent = info.text; duration.title = info.title; }
  }
}
