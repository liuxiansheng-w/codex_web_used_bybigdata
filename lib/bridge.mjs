import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

async function defaultExecutable() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const platform = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  try {
    const extensions = path.join(homedir(), '.cursor', 'extensions');
    const installed = JSON.parse(await readFile(path.join(extensions, 'extensions.json'), 'utf8'));
    const entry = installed.find(e => e.identifier?.id === 'openai.chatgpt');
    if (entry && platform && arch && /^openai\.chatgpt-[\w.-]+$/.test(entry.relativeLocation)) {
      const executable = path.join(extensions, entry.relativeLocation, 'bin', `${platform}-${arch}`, process.platform === 'win32' ? 'codex.exe' : 'codex');
      await access(executable, constants.X_OK);
      return executable;
    }
  } catch { /* Fall back to the CLI on PATH when no usable Cursor extension exists. */ }
  return 'codex';
}

// App-server credentials stay inside the Codex child process.
export class CodexBridge extends EventEmitter {
  constructor({ executable, cwd } = {}) {
    super();
    this.executable = executable;
    this.cwd = cwd;
    this.pending = new Map();
    this.sequence = 0;
    this.ready = false;
  }

  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = this.connect().finally(() => { this.starting = null; });
    return this.starting;
  }

  async connect() {
    this.executable ||= await defaultExecutable();
    const child = spawn(this.executable, ['app-server', '--stdio'], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.child = child;
    // Do not log stderr: plugins or providers could include credentials there.
    child.stderr.resume();
    let failed = false;
    const fail = (message) => {
      if (failed) return;
      failed = true;
      this.ready = false;
      if (this.child === child) this.child = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(message));
      }
      this.pending.clear();
      this.emit('offline', message);
    };
    child.on('error', (error) => fail(error.code === 'ENOENT'
      ? '未找到本机助手运行时，请在服务端配置运行时路径后重新连接。'
      : `助手服务无法启动（${error.code || '进程错误'}）。`));
    child.on('exit', () => fail('助手连接已断开。点击「重新连接」恢复。'));
    child.stdin.on('error', () => fail('助手通信连接已关闭。'));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        this.emit(message.id === undefined ? 'notification' : 'request', message);
      } else if (this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message || '助手请求失败'));
        else entry.resolve(message.result);
      }
    });
    try {
      this.info = await this.request('initialize', {
        clientInfo: { name: 'codex_web_shell', title: '柠檬', version: '1.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.write({ method: 'initialized' });
      this.ready = true;
      this.emit('online');
    } catch (error) {
      child.kill();
      throw error;
    }
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error('助手尚未连接，请重新连接。');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeout = 120_000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`助手请求超时（${method}）。请检查会话状态，不要重复提交同一任务。`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id, result) { this.write({ id, result }); }
  unsupported(id) { this.write({ id, error: { code: -32601, message: 'This client does not support this interaction.' } }); }
  close() { this.child?.kill('SIGTERM'); }
}
