import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { once } from 'node:events';
import { cosmosResponse, verifyCosmos, responseEvents } from './cosmos-transport.mjs';

export const COSMOS_MODEL = 'lemon-cosmos';
export const COSMOS_PROVIDER = 'lemon_cosmos';
const DEFAULT_URL = 'http://cosmos-api-inner.qingsonghealth.net/v1';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function connectionProfile(body, previous) {
  const key = body.key === '' || body.key === undefined ? previous?.key : body.key;
  if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)) throw fail('请输入有效的 Cosmos Key。');
  const protocol = body.protocol || 'workflow';
  if (!['workflow', 'chatflow', 'responses'].includes(protocol)) throw fail('请选择有效的 Cosmos 接口类型。');
  let url;
  try { url = new URL(body.baseUrl || DEFAULT_URL); } catch { throw fail('服务地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.length > 2048) throw fail('服务地址仅支持不含密钥、参数及账号的 HTTP / HTTPS 地址。');
  url.pathname = url.pathname.replace(/\/(workflows\/run|chat-messages|responses)\/?$/, '').replace(/\/+$/, '');
  const inputKey = protocol === 'chatflow' && body.inputKey === '' ? '' : body.inputKey || 'input', outputKey = body.outputKey || 'output';
  if (body.model !== undefined && typeof body.model !== 'string') throw fail('模型 ID 无效。');
  const model = (body.model || '').trim();
  for (const name of [inputKey, outputKey]) if (!(protocol === 'chatflow' && name === '') && (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/.test(name))) throw fail('工作流输入/输出变量名无效。');
  if (typeof model !== 'string' || model.length > 120 || /[\s\x00-\x1f]/.test(model) || protocol === 'responses' && !model) throw fail('Responses 接口需要填写模型 ID。');
  return { key, protocol, baseUrl: url.href.replace(/\/+$/, ''), model, inputKey, outputKey };
}

export class ModelConnections {
  constructor({ stateDir, fetchImpl = fetch, ephemeral = false } = {}) {
    this.dir = path.join(stateDir, 'model-provider'); this.file = path.join(this.dir, 'connection.json'); this.fetchImpl = fetchImpl;
    this.value = { active: 'codex', revision: 0, cosmos: null }; this.leases = new Map(); this.bindings = new Map(); this.busy = false; this.ephemeral = ephemeral;
    this.loading = this.load();
  }
  async load() {
    if (this.ephemeral) return;
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (!['codex', 'cosmos'].includes(value.active) || !Number.isSafeInteger(value.revision)) throw new Error('invalid');
      if (value.cosmos) connectionProfile(value.cosmos);
      if (value.active === 'cosmos' && !value.cosmos?.verifiedAt) throw new Error('invalid');
      this.value = value;
      await chmod(this.file, 0o600); await chmod(this.dir, 0o700);
    } catch (error) { if (error.code !== 'ENOENT') this.loadError = '本机模型配置无法读取，请检查配置文件；未自动切换模型。'; }
  }
  async status() {
    await this.loading;
    if (this.loadError) throw fail(this.loadError, 503);
    const { active, revision, cosmos } = this.value;
    return { active, revision, cosmos: cosmos ? { protocol: cosmos.protocol, baseUrl: cosmos.baseUrl, model: cosmos.model, inputKey: cosmos.inputKey, outputKey: cosmos.outputKey, hasKey: true, verifiedAt: cosmos.verifiedAt } : { protocol: 'chatflow', baseUrl: DEFAULT_URL, model: '', inputKey: 'input', outputKey: 'output', hasKey: false, verifiedAt: null } };
  }
  async update(body, { signal } = {}) {
    await this.status();
    if (this.busy) throw fail('模型配置正在验证，请等待完成。', 409);
    if (body.revision !== this.value.revision) throw fail('模型配置已在其他页面改变，请重新打开后操作。', 409);
    this.busy = true;
    try {
      let next;
      if (body.action === 'configure') {
        const profile = connectionProfile(body, this.value.cosmos);
        // A saved credential must never be sent to a newly entered origin.
        if (!body.key && profile.baseUrl !== this.value.cosmos?.baseUrl) throw fail('服务地址已改变，请重新输入对应地址的 Key。');
        await verifyCosmos(profile, { fetchImpl: this.fetchImpl, signal });
        next = { ...this.value, active: 'cosmos', cosmos: { ...profile, verifiedAt: new Date().toISOString() } };
      } else if (body.action === 'select') {
        if (!['codex', 'cosmos'].includes(body.provider)) throw fail('模型服务无效。');
        if (body.provider === 'cosmos' && !this.value.cosmos?.verifiedAt) throw fail('请先填写 Key 并通过兼容验证。');
        next = { ...this.value, active: body.provider };
      } else throw fail('模型配置操作无效。');
      if (signal?.aborted) throw fail('已取消模型切换。', 499);
      next.revision++;
      if (!this.ephemeral) {
        await mkdir(this.dir, { recursive: true, mode: 0o700 }); await chmod(this.dir, 0o700);
        const temporary = path.join(this.dir, `.${randomBytes(12).toString('hex')}.tmp`);
        try { await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); await rename(temporary, this.file); }
        catch { throw fail('模型配置保存失败，原模型保持不变。', 500); }
      }
      this.value = next;
      return this.status();
    } finally { this.busy = false; }
  }
  model() { return { model: COSMOS_MODEL, displayName: 'Cosmos · 自有模型', isDefault: false, supportedReasoningEfforts: [], inputModalities: ['text'] }; }
  async forThread(id, model) { return this.bindings.get(id) || this.options(model); }
  bind(id, options) { if (options) this.bindings.set(id, options); }
  async options(model) {
    if (model !== COSMOS_MODEL) return null;
    await this.status();
    if (!this.value.cosmos?.verifiedAt || !this.origin) throw fail('Cosmos 尚未配置，请在左下角填写 Key 并验证。', 409);
    const profile = this.value.cosmos;
    let lease = [...this.leases.values()].find(entry => entry.profile === profile);
    if (!lease) {
      lease = { id: randomBytes(32).toString('hex'), profile };
      this.leases.set(lease.id, lease);
    }
    const runtimeModel = profile.model || (profile.protocol === 'chatflow' ? 'cosmos-chatflow' : 'cosmos-workflow');
    return { model: runtimeModel, modelProvider: COSMOS_PROVIDER, config: {
      [`model_providers.${COSMOS_PROVIDER}`]: { name: 'Cosmos via Ningmeng', base_url: `${this.origin}/internal/model/${lease.id}/v1`, wire_api: 'responses', requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 390000, supports_websockets: false },
      'features.enable_request_compression': false, 'web_search': 'disabled',
      'agents.default_subagent_model': runtimeModel,
    } };
  }
  async handle(req, res, url) {
    if (!url.pathname.startsWith('/internal/model/')) return false;
    const match = url.pathname.match(/^\/internal\/model\/([a-f0-9]{64})\/v1\/responses$/), lease = match && this.leases.get(match[1]);
    if (!lease || req.method !== 'POST' || req.headers.origin || req.headers['sec-fetch-site'] || req.headers['content-encoding']) throw fail('模型代理请求无效。', 403);
    const controller = new AbortController(), cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    let timer;
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) throw fail('模型上下文过大，请新建对话或缩小任务范围。', 413);
        chunks.push(chunk);
      }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('模型请求格式无效。'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('模型请求格式无效。');
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
        timer = setInterval(() => { if (!res.destroyed && !res.writableNeedDrain) res.write(': waiting for Cosmos\n\n'); }, 15000); timer.unref?.();
      }
      const result = await cosmosResponse(lease.profile, body, { fetchImpl: this.fetchImpl, signal: controller.signal });
      if (res.destroyed) return true;
      if (body.stream) {
        for (const event of responseEvents(result)) {
          if (!res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) await once(res, 'drain', { signal: controller.signal });
        }
        res.end();
      } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); }
    } catch (error) {
      if (res.destroyed) return true;
      const message = error.status ? error.message : 'Cosmos 请求失败，未自动改用其他模型。';
      if (res.headersSent) res.end(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { id: 'failed', status: 'failed', error: { code: 'cosmos_error', message } } })}\n\n`);
      else { res.writeHead(error.status || 502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'cosmos_error' } })); }
    } finally { clearInterval(timer); res.off('close', cancel); }
    return true;
  }
}
