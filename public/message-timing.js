const validTime = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime());

// A native turn can include several user messages (turn/steer). Keep their
// display ranges separate without changing the runtime's turn or task state.
export function requestSegments(thread) {
  const segments = [], byTurn = new Map(); let fallback;
  for (const item of thread?.items || []) {
    const turnId = item.turnId || null;
    if (item.type === 'userMessage') {
      const previous = turnId && byTurn.get(turnId);
      const segment = { key: JSON.stringify([turnId, item.id]), turnId, user: item, items: [], followup: !!previous?.user, next: null };
      if (previous) previous.next = segment;
      segments.push(segment); fallback = segment; if (turnId) byTurn.set(turnId, segment);
    } else if (turnId) {
      let segment = byTurn.get(turnId);
      if (!segment) {
        segment = { key: JSON.stringify([turnId, null]), turnId, user: null, items: [], followup: false, next: null };
        segments.push(segment); byTurn.set(turnId, segment);
      }
      segment.items.push(item);
    } else {
      if (!fallback) { fallback = { key: 'history', turnId: null, user: null, items: [], followup: false, next: null }; segments.push(fallback); }
      fallback.items.push(item);
    }
  }
  return segments;
}

export function currentRequest(thread, segments = requestSegments(thread)) {
  const pending = segments.findLast(segment => segment.user?.pending);
  if (pending) return pending;
  const turnId = thread?.busy ? thread.turnId : thread?.latestTurnId || thread?.turnId;
  return (!turnId && !thread?.busy ? segments.at(-1) : segments.findLast(segment => segment.turnId === turnId)) || { key: JSON.stringify([turnId || null, null]), turnId, user: null, items: [], followup: false, next: null };
}

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

export function requestDuration(thread, segment = currentRequest(thread), live = true, now = Date.now()) {
  if (!segment || segment.user?.pending) return null;
  if (!segment.followup && !segment.next) return turnDuration(thread, segment.turnId, live, now);
  const timing = thread?.turnTimings?.find(turn => turn.id === segment.turnId);
  const ended = ['completed', 'interrupted', 'failed'].includes(timing?.status);
  const start = segment.followup ? segment.user?.timestamp : validTime(timing?.startedAt) ? timing.startedAt : segment.user?.timestamp;
  if (!validTime(start)) return null;
  let end, prefix, title;
  if (segment.next) {
    end = segment.next.user?.timestamp; prefix = '本段用时';
    title = '从这段开始到下一条用户消息的时间；后续追加的问题单独计时，不代表此前任务已完成。';
  } else if (ended) {
    end = validTime(timing.completedAt) ? timing.completedAt : validTime(timing.startedAt) && typeof timing.durationMs === 'number' && timing.durationMs >= 0 ? timing.startedAt + timing.durationMs : null;
    prefix = '本次用时'; title = '从这条用户消息发送到本轮结束，包含工具执行和等待确认时间。';
  } else {
    if (!live || thread?.runtimeStale || !thread?.busy || thread.turnId !== segment.turnId) return { text: '耗时待同步', title: '恢复连接后核对本次提问的耗时。' };
    end = now; prefix = '已用时'; title = '从这条用户消息发送开始计时，包含工具执行和等待确认时间。';
  }
  if (!validTime(end) || end < start) return null;
  const formatted = formatDuration(end - start); if (!formatted) return null;
  const approximate = timing?.estimated || segment.user?.timestampSource === 'observed' || segment.next?.user?.timestampSource === 'observed';
  const suffix = !segment.next && timing?.status === 'interrupted' ? ' · 已停止' : !segment.next && timing?.status === 'failed' ? ' · 未完成' : '';
  return { text: `${prefix}${approximate ? '约' : ''} ${formatted}${suffix}`, title };
}

export function renderMessageTimes(thread, elements, live = true, now = Date.now()) {
  const durations = new Map();
  for (const segment of requestSegments(thread)) {
    const reply = segment.items.findLast(item => item.type === 'agentMessage');
    if (reply) durations.set(reply.id, requestDuration(thread, segment, live, now));
  }
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
    const info = item.type === 'agentMessage' ? durations.get(item.id) : null;
    duration.hidden = !info;
    if (info) { if (duration.textContent !== info.text) duration.textContent = info.text; duration.title = info.title; }
  }
}
