// Only explicit send/retry performs a POST. Recovery is a read-only receipt
// lookup, and a retry keeps the exact original body and operation identifier.
export function createSubmissionState({ api, getEpoch, storage }) {
  const pending = new Map();
  const key = (cwd, threadId) => JSON.stringify([cwd, threadId || null]);
  const storageKey = 'lemon:pendingSubmissions:v1';
  function persist() {
    try {
      const metadata = [...pending.values()].filter(record => record.body.submissionId).map(record => ({ cwd: record.cwd, originalThread: record.originalThread, threadId: record.threadId, route: record.route, id: record.body.submissionId, epoch: record.body.submissionEpoch }));
      if (metadata.length) storage?.setItem(storageKey, JSON.stringify(metadata)); else storage?.removeItem(storageKey);
    } catch { /* Exit protection remains active when tab storage is unavailable. */ }
  }
  try {
    for (const metadata of JSON.parse(storage?.getItem(storageKey) || '[]').slice(0, 20)) {
      if (typeof metadata.cwd !== 'string' || !['/api/send', '/api/followup'].includes(metadata.route) || !/^[a-f0-9-]{36}$/i.test(metadata.id || '') || typeof metadata.epoch !== 'string') continue;
      const scope = key(metadata.cwd, metadata.originalThread);
      pending.set(scope, { ...metadata, scope, state: 'unknown', snapshot: null, body: { submissionId: metadata.id, submissionEpoch: metadata.epoch }, message: '刷新前有一条消息的发送结果待核对。现有草稿已保留。' });
    }
  } catch { /* Malformed metadata never starts a task. */ }

  return {
    get(cwd, threadId) { return pending.get(key(cwd, threadId)); },
    all() { return [...pending.values()]; },
    begin(cwd, threadId, route, body, snapshot) {
      const scope = key(cwd, threadId);
      if (pending.has(scope)) throw new Error('请先核对上次发送结果。');
      const epoch = getEpoch();
      const record = { scope, cwd, threadId, originalThread: threadId, route, snapshot, state: 'sending', body: { ...body, ...(epoch ? { submissionId: globalThis.crypto.randomUUID(), submissionEpoch: epoch } : {}) } };
      pending.set(scope, record); persist(); return record;
    },
    async send(record) {
      if (!record.snapshot) throw new Error('刷新前的原消息只支持核对，请确认后手动发送草稿。');
      record.state = 'sending';
      try { const result = await api(record.route, record.body); record.result = result; record.threadId = result.threadId; record.state = 'accepted'; persist(); return result; }
      catch (error) { record.state = 'unknown'; record.message = error.message; persist(); throw error; }
    },
    async check(record) {
      if (!record.body.submissionId) throw new Error('当前服务尚未支持发送核对，请先查看会话记录；没有重新发送。');
      const result = await api('/api/submissions/' + encodeURIComponent(record.body.submissionId) + '?epoch=' + encodeURIComponent(record.body.submissionEpoch));
      record.message = ''; Object.assign(record, result); persist();
      if (result.state === 'accepted') record.result = { threadId: result.threadId };
      return result;
    },
    forget(record) { if (pending.get(record.scope) === record) pending.delete(record.scope); persist(); },
  };
}
