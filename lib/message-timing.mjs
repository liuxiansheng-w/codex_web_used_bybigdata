import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const milliseconds = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 8640000000000000 ? value : null;
const seconds = value => milliseconds(value) == null ? null : milliseconds(value * 1000);
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function turnTiming(turn, previous = {}, observed = {}) {
  const startedAt = seconds(turn.startedAt) ?? previous.startedAt ?? observed.startedAt ?? null;
  const completedAt = seconds(turn.completedAt) ?? previous.completedAt ?? observed.completedAt ?? null;
  const durationMs = duration(turn.durationMs) ?? previous.durationMs ?? (startedAt != null && completedAt >= startedAt ? completedAt - startedAt : null);
  return { id: turn.id, status: turn.status || previous.status || 'inProgress', startedAt, completedAt, durationMs,
    estimated: duration(turn.durationMs) == null && (seconds(turn.startedAt) == null && !previous.startedAt && !!observed.startedAt || seconds(turn.completedAt) == null && !previous.completedAt && !!observed.completedAt || !!previous.estimated) };
}

// The RPC omits historical item timestamps. Read only time metadata from the
// native thread's own bounded rollout, never a path supplied by an HTTP client.
export async function readHistoryTiming(thread, codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex')) {
  const empty = () => ({ messages: new Map(), turns: new Map() });
  if (!thread.path || !thread.id || !path.isAbsolute(thread.path) || !thread.path.endsWith('.jsonl')) return empty();
  let file;
  try {
    const [home, filename] = await Promise.all([realpath(codexHome), realpath(thread.path)]);
    if (!['sessions', 'archived_sessions'].some(dir => filename.startsWith(path.join(home, dir) + path.sep))) return empty();
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat(); if (!info.isFile() || info.size > 64 * 1024 * 1024) return empty();
    const buffer = Buffer.alloc(info.size); let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    const lines = buffer.subarray(0, offset).toString('utf8').split('\n');
    const header = JSON.parse(lines[0]);
    if (header.type !== 'session_meta' || header.payload?.id !== thread.id) return empty();
    const result = empty();
    for (const line of lines.slice(1)) {
      let record; try { record = JSON.parse(line); } catch { continue; } // A live log can end mid-record.
      const payload = record.payload, timestamp = milliseconds(Date.parse(record.timestamp));
      if (!payload || !timestamp) continue;
      if (record.type === 'response_item' && payload.type === 'message' && payload.id && ['user', 'assistant'].includes(payload.role)) {
        if (!result.messages.has(payload.id)) result.messages.set(payload.id, { timestamp, type: payload.role === 'user' ? 'userMessage' : 'agentMessage' });
      }
      if (record.type === 'event_msg' && payload.type === 'item_completed' && payload.thread_id === thread.id && payload.item?.id) {
        const type = { UserMessage: 'userMessage', AgentMessage: 'agentMessage', Plan: 'plan' }[payload.item.type];
        const time = type === 'userMessage' ? milliseconds(payload.started_at_ms) ?? milliseconds(payload.completed_at_ms) : milliseconds(payload.completed_at_ms);
        if (type && time) result.messages.set(payload.item.id, { timestamp: time, type });
      }
      if (record.type === 'event_msg' && payload.type === 'user_message' && payload.client_id) result.messages.set(payload.client_id, { timestamp, type: 'userMessage' });
      if (record.type === 'event_msg' && payload.turn_id && ['task_started', 'task_complete', 'turn_aborted'].includes(payload.type)) {
        result.turns.set(payload.turn_id, turnTiming({ id: payload.turn_id, startedAt: payload.started_at, completedAt: payload.completed_at, durationMs: payload.duration_ms, status: payload.type === 'task_started' ? 'inProgress' : payload.type === 'turn_aborted' ? 'interrupted' : 'completed' }, result.turns.get(payload.turn_id)));
      }
    }
    return result;
  } catch { return empty(); }
  finally { await file?.close(); }
}
