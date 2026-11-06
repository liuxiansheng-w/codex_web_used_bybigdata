import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { access, mkdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';

// Chrome's private debugging pipe has no listening TCP port. The OS renderer
// sandbox remains enabled; the workbench never attaches to the user's Chrome.
export class BrowserCdp extends EventEmitter {
  constructor({ profile, executable = process.env.LEMON_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', launch = spawn } = {}) {
    super(); this.profile = profile; this.executable = executable; this.launch = launch; this.pending = new Map(); this.sequence = 0; this.buffer = ''; this.closed = false;
  }
  async start() {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try { await access(this.executable, constants.X_OK); } catch { throw Object.assign(new Error('未找到本机 Chrome，请安装 Chrome 后重试，或配置 LEMON_CHROME_BIN。'), { status: 503 }); }
      await mkdir(this.profile, { recursive: true, mode: 0o700 });
      const info = await lstat(this.profile); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('浏览器配置目录异常。');
      const child = this.launch(this.executable, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${this.profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], shell: false });
      this.child = child; this.closed = false;
      child.stdio[4].setEncoding('utf8'); child.stdio[4].on('data', chunk => this.receive(chunk));
      child.stdio[3].on('error', () => this.disconnected()); child.stdio[4].on('error', () => this.disconnected());
      child.once('error', () => this.disconnected()); child.once('exit', () => this.disconnected());
      await this.call('Browser.getVersion');
    })().catch(error => { this.child?.kill('SIGTERM'); this.child = null; throw error; }).finally(() => { this.starting = null; });
    return this.starting;
  }
  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 30_000_000) { this.disconnected(); return; }
    let at;
    while ((at = this.buffer.indexOf('\0')) >= 0) {
      const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (Object.hasOwn(message, 'id')) {
        const pending = this.pending.get(message.id); if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) { this.emit('protocolError', { method: pending.method, code: message.error.code, message: message.error.message }); pending.reject(Object.assign(new Error('浏览器未完成此操作，请刷新页面状态后重试。'), { method: pending.method, code: message.error.code })); }
        else pending.resolve(message.result || {});
      } else if (message.method) this.emit('event', message);
    }
  }
  call(method, params = {}, sessionId, timeout = 15000) {
    if (!this.child || this.closed) return Promise.reject(new Error('共享浏览器尚未连接。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('浏览器操作超时，结果未确认，请刷新状态，勿重复提交。')); }, timeout); timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0', error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('共享浏览器连接中断。')); } });
    });
  }
  disconnected() {
    if (this.closed) return; this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('共享浏览器连接中断，操作结果未确认。')); }
    this.pending.clear(); this.buffer = ''; const child = this.child; this.child = null; if (child && child.exitCode === null) child.kill('SIGTERM'); this.emit('offline');
  }
  async close() { const child = this.child; this.disconnected(); child?.kill('SIGTERM'); }
}
