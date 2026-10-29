import { createHash, randomUUID } from 'node:crypto';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
// In-memory receipts are bound to one server lifetime. Never evict a receipt and
// then accept its identifier as a new operation. No prompt or attachment cache.
export class MessageSubmissions {
  epoch = randomUUID();
  records = new Map();
  constructor({ limit = 2000 } = {}) { this.limit = limit; }
  validate(id, epoch) {
    if (!/^[a-f0-9-]{36}$/i.test(id || '')) fail('提交编号无效。', 400);
    if (epoch !== this.epoch) fail('服务已重启，上次发送结果需在会话记录中核对；没有重新发送。');
  }
  get(id, epoch) {
    this.validate(id, epoch);
    const record = this.records.get(id);
    if (!record) return { state: 'notFound', message: '当前服务未收到这次提交。草稿保留，可明确重新发送。' };
    return { state: record.state, threadId: record.threadId || null, ...(record.error ? { message: record.error.message } : {}) };
  }
  attempting(id) { const record = this.records.get(id); if (record) record.attempted = true; }
  attach(id, threadId) { const record = this.records.get(id); if (record) record.threadId = threadId; }
  run(kind, body, operation) {
    const { submissionId: id, submissionEpoch: epoch, ...input } = body;
    if (!id) return operation(); // Existing clients remain compatible.
    this.validate(id, epoch);
    const fingerprint = createHash('sha256').update(JSON.stringify([kind, canonical(input)])).digest('hex');
    const previous = this.records.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('这次提交编号对应的内容已变化，未执行。');
      return previous.promise;
    }
    if (this.records.size >= this.limit) fail('本次服务的发送凭据已满，请在全部任务结束后维护服务；草稿已保留。', 503);
    const record = { fingerprint, state: 'pending', threadId: input.threadId || null };
    this.records.set(id, record);
    record.promise = Promise.resolve().then(operation).then(result => {
      record.threadId = result.threadId; record.state = 'accepted'; return result;
    }, error => {
      record.state = record.attempted || /超时|连接中断|连接已关闭|结果.*确认/.test(error.message) ? 'unknown' : 'failed';
      record.error = { message: error.message, status: error.status || 500 }; throw error;
    });
    return record.promise;
  }
}
