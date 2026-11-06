import net from 'node:net';
import { mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// MCP reaches the browser through a user-private Unix socket, never a public
// HTTP route, bearer URL, arbitrary CDP method or model-supplied thread id.
export class BrowserTools {
  constructor(browser) { this.browser = browser; this.clients = new Set(); }
  async start() {
    if (this.server) return;
    const root = await mkdtemp(path.join(tmpdir(), 'lemon-browser-')); await chmod(root, 0o700); this.socket = path.join(root, 'tools.sock');
    this.server = net.createServer(socket => {
      this.clients.add(socket); socket.setEncoding('utf8'); socket.setTimeout(30000, () => socket.destroy()); let buffer = '', used = false;
      socket.on('close', () => this.clients.delete(socket)); socket.on('error', () => {});
      socket.on('data', async chunk => {
        if (used) return; buffer += chunk;
        if (buffer.length > 60000) { used = true; socket.destroy(); return; }
        if (!buffer.includes('\n')) return; used = true;
        let result;
        try { const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); result = await this.browser.modelCall(request.arguments, request.threadId); }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message || '浏览器操作未完成，请核对页面。' }] }; }
        socket.end(JSON.stringify(result) + '\n');
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.socket, resolve); }); await chmod(this.socket, 0o600);
  }
  config() {
    if (!this.socket) return {};
    return { 'mcp_servers.lemon_browser': { command: process.execPath, args: [fileURLToPath(new URL('./browser-mcp.mjs', import.meta.url)), this.socket], enabled: true, startup_timeout_sec: 10, tool_timeout_sec: 30 } };
  }
  async close() { for (const client of this.clients) client.destroy(); if (this.server) await new Promise(resolve => this.server.close(resolve)); }
}
