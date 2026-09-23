import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { CodexBridge } from './lib/bridge.mjs';
import { TitleGenerator } from './lib/thread-titles.mjs';
import { SqlCompletion, completionContext } from './lib/sql-completion.mjs';
import { Workspace, check, directory } from './lib/workspace.mjs';
import { ProjectFiles } from './lib/project-files.mjs';
import { FileTools } from './lib/file-tools.mjs';
import { Workbench } from './lib/workbench.mjs';
import { GitSubmit } from './lib/git-submit.mjs';
import { languageTools } from './lib/language-tools.mjs';
import { SqlRunner } from './lib/sql-runner.mjs';
import { FileHistory } from './lib/file-history.mjs';
import { SpreadsheetPreview } from './lib/spreadsheet-preview.mjs';
import { Subagents } from './lib/subagents.mjs';
import { createEventStream, prepareThread } from './lib/event-stream.mjs';
import { ModelConnections, COSMOS_MODEL } from './lib/model-connections.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function defaultWorkspace(appRoot = root, explicit = process.env.WORKSPACE_CWD) {
  if (explicit) return path.resolve(explicit);
  let workspace = path.dirname(appRoot);
  // This workspace contains nested repositories. Moving the app into one must
  // not silently replace the original outer workspace as the default project.
  for (let dir = workspace; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) workspace = dir;
    if (dir === path.dirname(dir)) return workspace;
  }
}
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']],
  ['/markdown-preview.js', ['markdown-preview.js', 'text/javascript; charset=utf-8']],
  ['/markdown-renderer.js', ['markdown-renderer.js', 'text/javascript; charset=utf-8']],
  ['/markdown-renderer.html', ['markdown-renderer.html', 'text/html; charset=utf-8']],
  ['/composer.js', ['composer.js', 'text/javascript; charset=utf-8']],
  ['/permissions.js', ['permissions.js', 'text/javascript; charset=utf-8']],
  ['/permission-presets.js', ['permission-presets.js', 'text/javascript; charset=utf-8']],
  ['/interactions.js', ['interactions.js', 'text/javascript; charset=utf-8']],
  ['/file-tree.js', ['file-tree.js', 'text/javascript; charset=utf-8']],
  ['/file-editor.js', ['file-editor.js', 'text/javascript; charset=utf-8']],
  ['/editor-window.js', ['editor-window.js', 'text/javascript; charset=utf-8']],
  ['/code-highlight.js', ['code-highlight.js', 'text/javascript; charset=utf-8']],
  ['/workbench.js', ['workbench.js', 'text/javascript; charset=utf-8']],
  ['/git-submit.js', ['git-submit.js', 'text/javascript; charset=utf-8']],
  ['/artifact-viewer.js', ['artifact-viewer.js', 'text/javascript; charset=utf-8']],
  ['/project-list.js', ['project-list.js', 'text/javascript; charset=utf-8']],
  ['/editor-tools.js', ['editor-tools.js', 'text/javascript; charset=utf-8']],
  ['/query-history.js', ['query-history.js', 'text/javascript; charset=utf-8']],
  ['/product-ui.js', ['product-ui.js', 'text/javascript; charset=utf-8']],
  ['/task-results.js', ['task-results.js', 'text/javascript; charset=utf-8']],
  ['/execution-view.js', ['execution-view.js', 'text/javascript; charset=utf-8']],
  ['/message-timing.js', ['message-timing.js', 'text/javascript; charset=utf-8']],
  ['/sql-query.js', ['sql-query.js', 'text/javascript; charset=utf-8']],
  ['/sql-parameters.js', ['sql-parameters.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

function sameSecret(a, b) {
  const x = Buffer.from(a || ''); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req) {
  check(req.headers['content-type']?.split(';')[0] === 'application/json', '需要 JSON 请求。', 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    const limit = req.url === '/api/attachments/upload' ? 14_100_000 : req.url === '/api/project/save' ? 6_500_000 : req.url === '/api/project/language' ? 1_400_000 : 512_000;
    check(length <= limit, '请求过大。', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    check(value && typeof value === 'object' && !Array.isArray(value), '无效的请求格式。');
    return value;
  } catch { throw Object.assign(new Error('无效的 JSON。'), { status: 400 }); }
}

export function createApplication({ cwd = defaultWorkspace(), bridge = new CodexBridge({ cwd }), stateDir = path.join(root, '.local'), sqlRunner = new SqlRunner(), titleGenerator = bridge instanceof CodexBridge ? new TitleGenerator({ stateDir, executable: bridge.executable }) : null, sqlCompletion = bridge instanceof CodexBridge ? new SqlCompletion({ stateDir, executable: bridge.executable }) : null, modelConnections = new ModelConnections({ stateDir, ephemeral: !(bridge instanceof CodexBridge) }) } = {}) {
  const workspace = new Workspace(bridge, cwd, { titleGenerator, modelConnections });
  const projectFiles = new ProjectFiles();
  const fileTools = new FileTools(projectFiles);
  const workbench = new Workbench(workspace, projectFiles, stateDir);
  const gitSubmit = new GitSubmit(workbench);
  const fileHistory = new FileHistory(projectFiles, fileTools, workspace, stateDir);
  const spreadsheets = new SpreadsheetPreview(workbench), subagents = new Subagents(workspace);
  const session = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const clients = new Set();
  let startupError = null;

  workspace.on('thread', data => {
    if (!clients.size) return;
    const prepared = prepareThread(data);
    for (const client of clients) client.thread(prepared);
  });
  workspace.on('connection', data => { for (const client of clients) client.connection(data); });

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' blob:; worker-src 'self' blob:; frame-src blob: 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const port = server.address()?.port;
      const host = req.headers.host;
      check([`127.0.0.1:${port}`, `localhost:${port}`].includes(host), '只允许本机访问。', 403);
      const origin = `http://${host}`;
      check(!req.headers.origin || req.headers.origin === origin, '请求来源不受信任。', 403);
      check(!['cross-site'].includes(req.headers['sec-fetch-site']), '不允许跨站请求。', 403);
      const url = new URL(req.url, origin);
      if (await modelConnections.handle(req, res, url)) return;
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, contentType] = assets.get(url.pathname);
        if (url.pathname === '/markdown-renderer.html') {
          res.setHeader('X-Frame-Options', 'SAMEORIGIN');
          res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'self'; connect-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'");
        }
        if (url.pathname === '/') res.setHeader('Set-Cookie', `codex_desk=${session}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(await readFile(path.join(root, 'public', name)));
        return;
      }
      const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('codex_desk='))?.slice(11);
      check(sameSecret(cookie, session), '连接已过期，请刷新页面。', 401);
      const markdownAsset = url.pathname.match(/^\/vendor\/markdown\/(document|mermaid|chunk-[A-Z0-9]+)\.js$/);
      if (req.method === 'GET' && markdownAsset) {
        const filename = path.join(root, 'public/vendor/markdown', `${markdownAsset[1]}.js`);
        check(existsSync(filename), '预览资源不存在。', 404);
        const bytes = await readFile(filename);
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end(bytes); return;
      }
      const pdfAsset = url.pathname.match(/^\/vendor\/pdfjs\/(build\/pdf(?:\.worker)?\.min\.mjs|(?:cmaps|standard_fonts|wasm|icc)\/[A-Za-z0-9_.-]+\.(?:bcmap|pfb|ttf|wasm|icc))$/);
      if (req.method === 'GET' && pdfAsset) {
        const name = pdfAsset[1]; res.writeHead(200, { 'Content-Type': name.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' });
        res.end(await readFile(path.join(root, 'node_modules/pdfjs-dist', name))); return;
      }
      if (req.method === 'POST') {
        check(req.headers.origin === origin && sameSecret(req.headers['x-codex-csrf'], csrf), '请求校验失败，请刷新页面。', 403);
      }
      const imageRoute = url.pathname.match(/^\/api\/attachments\/images\/([0-9a-f-]{36})$/);
      if (imageRoute && req.method === 'GET') {
        const image = await workspace.context.images.read(imageRoute[1]);
        res.writeHead(200, { 'Content-Type': image.contentType, 'Content-Length': image.bytes.length, 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name)}` });
        res.end(image.bytes); return;
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        check(clients.size < 12, '打开的页面太多。', 429);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const client = createEventStream(res, { delta: url.searchParams.get('version') === '2', onClose: () => clients.delete(client) });
        clients.add(client);
        client.snapshot(bridge.ready, [...workspace.threads.values()].map(prepareThread));
        return;
      }
      if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
        const data = bridge.ready ? await workspace.bootstrap() : { connected: false, cwd, models: [], error: startupError || '柠檬正在连接，请稍候或点击重新连接。' };
        const connections = await modelConnections.status().catch(error => ({ error: error.message }));
        json({ ...data, csrf, modelConnections: connections, aiCompletionAvailable: !!sqlCompletion, workbenchFeatures: true }); return;
      }
      if (url.pathname === '/api/model-connections' && req.method === 'GET') { json(await modelConnections.status()); return; }
      if (url.pathname === '/api/model-connections' && req.method === 'POST') {
        const body = await readBody(req), controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', cancel);
        try { const result = await modelConnections.update(body, { signal: controller.signal }); if (!res.destroyed) json(result); }
        finally { res.off('close', cancel); }
        return;
      }
      if (url.pathname === '/api/connect' && req.method === 'POST') {
        await readBody(req);
        const wasReady = bridge.ready;
        if (!wasReady) workspace.threads.clear();
        await bridge.start(); startupError = null;
        json(await workspace.bootstrap()); return;
      }
      // Browsing local filenames does not depend on the model connection.
      if (url.pathname === '/api/sql/status' && req.method === 'GET') { json(await sqlRunner.status()); return; }
      if (url.pathname === '/api/sql/query' && req.method === 'POST') { json(await sqlRunner.execute(await readBody(req))); return; }
      if (url.pathname === '/api/project/files' && req.method === 'GET') {
        json(await projectFiles.list({ cwd: url.searchParams.get('cwd') || cwd, path: url.searchParams.get('path') || '', offset: Number(url.searchParams.get('offset') || 0) })); return;
      }
      if (url.pathname === '/api/project/attach' && req.method === 'POST') {
        json(await projectFiles.attach(workspace.context, await readBody(req))); return;
      }
      if (url.pathname === '/api/project/file' && req.method === 'GET') {
        const file = await projectFiles.read({ cwd: url.searchParams.get('cwd') || cwd, path: url.searchParams.get('path') });
        json(url.searchParams.get('version') === file.version ? { unchanged: true, version: file.version } : file); return;
      }
      if (url.pathname === '/api/project/save' && req.method === 'POST') {
        json(await projectFiles.save(await readBody(req))); return;
      }
      if (url.pathname === '/api/project/spreadsheet' && req.method === 'POST') { json(await spreadsheets.read(await readBody(req))); return; }
      if (url.pathname === '/api/project/history' && req.method === 'GET') { json(await fileHistory.list(Object.fromEntries(url.searchParams))); return; }
      if (url.pathname === '/api/project/restore-preview' && req.method === 'POST') { json(await fileHistory.preview(await readBody(req))); return; }
      if (url.pathname === '/api/project/restore-apply' && req.method === 'POST') { json(await fileHistory.apply(await readBody(req))); return; }
      if (url.pathname === '/api/project/language' && req.method === 'POST') { json(await languageTools(await readBody(req))); return; }
      if (url.pathname === '/api/project/complete' && req.method === 'POST') {
        check(sqlCompletion, 'AI 续写暂不可用。', 503);
        const body = await readBody(req), context = completionContext(body);
        const abort = new AbortController(), cancel = () => { if (!res.writableEnded) abort.abort(); };
        res.on('close', cancel);
        try {
          const file = await projectFiles.read({ cwd: body.cwd || cwd, path: body.path });
          check(file.writable, '此文件为只读，无法续写。', 403);
          if (!res.destroyed) {
            const connection = await modelConnections.options(context.model);
            const completion = await sqlCompletion.complete(context, { signal: abort.signal, connection });
            if (!res.destroyed) json({ completion });
          }
        } finally { res.off('close', cancel); }
        return;
      }
      if (req.method === 'GET') {
        const query = Object.fromEntries(url.searchParams);
        if (url.pathname === '/api/project/preview') {
          const artifact = await workbench.artifact(query);
          check(['.html', '.htm'].includes(artifact.extension), '此预览接口只支持 HTML。');
          // A separate document policy permits its layout CSS without weakening
          // the application's script/style policy. No scripts, network or origin access.
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
          res.setHeader('X-Frame-Options', 'SAMEORIGIN');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(Buffer.from(artifact.base64, 'base64')); return;
        }
        if (url.pathname === '/api/project/search') {
          const controller = new AbortController(), cancel = () => { if (!res.writableEnded) controller.abort(); };
          res.once('close', cancel);
          try { json(await fileTools.search({ ...query, filenames: query.filenames === '1', caseSensitive: query.caseSensitive === '1', signal: controller.signal })); }
          finally { res.off('close', cancel); }
          return;
        }
        if (url.pathname === '/api/project/artifact') { json(await workbench.artifact(query)); return; }
        if (url.pathname === '/api/git') { json(await workbench.gitStatus(query)); return; }
        if (url.pathname === '/api/git/submit') { json(await gitSubmit.snapshot(query)); return; }
        if (url.pathname === '/api/git/submit/diff') { json(await gitSubmit.diff(query)); return; }
        if (url.pathname === '/api/schedules') { json(await workbench.schedules()); return; }
        if (url.pathname === '/api/terminal') { json({ processes: workbench.terminalList() }); return; }
      }
      if (req.method === 'POST' && url.pathname === '/api/git/submit') { json(await gitSubmit.action(await readBody(req))); return; }
      if (req.method === 'POST' && ['/api/project/mutate', '/api/project/replace-preview', '/api/project/replace-apply', '/api/git/action'].includes(url.pathname)) {
        const body = await readBody(req);
        const action = { '/api/project/mutate': () => fileTools.mutate(body), '/api/project/replace-preview': () => fileTools.previewReplace(body), '/api/project/replace-apply': () => fileTools.applyReplace(body), '/api/git/action': () => workbench.gitAction(body) }[url.pathname];
        json(await action()); return;
      }
      check(bridge.ready, startupError || '助手尚未连接，请点击重新连接。', 503);
      const agentsRoute = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9_-]+)\/agents(?:\/(interrupt))?$/);
      if (agentsRoute && req.method === 'GET' && !agentsRoute[2]) { json(await subagents.list(agentsRoute[1])); return; }
      if (agentsRoute && req.method === 'POST' && agentsRoute[2]) { json(await subagents.interrupt(agentsRoute[1], await readBody(req))); return; }
      if (url.pathname === '/api/capabilities' && req.method === 'GET') {
        json(await workspace.catalog.get(await directory(url.searchParams.get('cwd') || cwd), url.searchParams.get('refresh') === '1')); return;
      }
      if (url.pathname === '/api/threads' && req.method === 'GET') {
        json(await workspace.list(url.searchParams.get('cwd') || cwd, url.searchParams.get('cursor'), { scope: url.searchParams.get('scope') || 'title', search: url.searchParams.get('search') || '', archived: url.searchParams.get('archived') === '1' })); return;
      }
      if (url.pathname === '/api/connections' && req.method === 'GET') { json(await workbench.connections(Object.fromEntries(url.searchParams))); return; }
      if (url.pathname === '/api/usage' && req.method === 'GET') { json(await bridge.request('account/rateLimits/read', {})); return; }
      const threadRoute = url.pathname.match(/^\/api\/threads\/([a-zA-Z0-9_-]+)$/);
      if (threadRoute && req.method === 'GET') { json(await workspace.get(threadRoute[1], { refreshTitle: true })); return; }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (url.pathname === '/api/send') { json(await workspace.send(body)); return; }
        if (url.pathname === '/api/followup') { json(await workspace.followup(body)); return; }
        if (url.pathname === '/api/queue') { json(workspace.queueAction(body)); return; }
        if (url.pathname === '/api/threads/action') { json(await workspace.threadAction(body)); return; }
        if (url.pathname === '/api/review') { json(await workspace.review(body)); return; }
        if (url.pathname === '/api/terminal/start') { json(await workbench.terminal(body)); return; }
        if (url.pathname === '/api/terminal/action') { json(await workbench.terminalAction(body)); return; }
        if (url.pathname === '/api/connections/action') { json(await workbench.connectionAction(body)); return; }
        if (url.pathname === '/api/schedules/action') { json(await workbench.scheduleAction(body)); return; }
        if (url.pathname === '/api/interrupt') { json(await workspace.interrupt(body.threadId)); return; }
        if (url.pathname === '/api/respond') { json(workspace.respond(body)); return; }
        if (url.pathname === '/api/attachments/upload') { json(await workspace.context.upload(body)); return; }
        if (url.pathname === '/api/attachments/reference') { json(await workspace.context.reference(body)); return; }
        if (url.pathname === '/api/goal') { json(await workspace.setGoal(body)); return; }
      }
      json({ error: '未找到接口。' }, 404);
    } catch (error) {
      if (res.destroyed) return;
      if (!res.headersSent) json({ error: error.message }, error.status || 500);
      else res.destroy();
    }
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 15_000;

  return {
    server, workspace, bridge, workbench, modelConnections,
    async start(port = Number(process.env.PORT || 4317)) {
      check(Number.isInteger(port) && port >= 0 && port <= 65535, 'PORT 必须是有效端口。');
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      modelConnections.origin = `http://127.0.0.1:${server.address().port}`;
      await modelConnections.loading;
      bridge.start().catch(error => { startupError = error.message; });
      return server.address().port;
    },
    async close() {
      titleGenerator?.close();
      sqlCompletion?.close();
      spreadsheets.close();
      await fileTools.close();
      workbench.close();
      for (const client of clients) client.close();
      for (const timer of workspace.timers.values()) clearTimeout(timer);
      bridge.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApplication();
  try {
    const port = await app.start();
    console.log(`柠檬已启动：http://127.0.0.1:${port}`);
    console.log('按 Ctrl+C 停止服务。');
    let closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (closing) return; closing = true;
      await app.close(); process.exit(0);
    });
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请设置 PORT 后重新启动。' : error.message);
    process.exitCode = 1;
  }
}
