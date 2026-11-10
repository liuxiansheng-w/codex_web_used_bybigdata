import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserWorkspace, browserUrl, downloadName } from '../lib/browser-workspace.mjs';
import { BrowserTools } from '../lib/browser-tools.mjs';
import { forwardBrowser, mcpRequest } from '../lib/browser-mcp.mjs';

class Cdp extends EventEmitter {
  calls = []; index = 0; async start() {} async close() {}
  async call(method, params = {}, session) {
    this.calls.push({ method, params, session });
    if (method === 'Target.createTarget') { assert.equal(params.width, undefined, 'tab sizing belongs to Emulation, not new-window-only target fields'); return { targetId: 'target-' + ++this.index }; }
    if (method === 'Target.attachToTarget') return { sessionId: 'session-' + this.index };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-' + this.index } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'Runtime.evaluate' && params.expression.includes('document.elementFromPoint')) {
      const node = this.element || { tagName: 'BUTTON', id: 'save', isContentEditable: false, innerText: 'Save', getBoundingClientRect: () => ({ left: 20, top: 30, right: 120, bottom: 70 }), getAttribute: () => '' };
      return { result: { value: runInNewContext(params.expression, { document: { elementFromPoint: () => node }, CSS: { escape: text => text } }) } };
    }
    if (method === 'Runtime.evaluate') return { result: { value: params.expression.includes('__lemonBrowserRefs = refs') ? { title: 'Fixture', url: 'https://example.test/', text: 'Untrusted page text', controls: [{ ref: 'e1', label: 'Fixture button' }] } : { x: 30, y: 40, password: false, file: false } } };
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('fixture-image').toString('base64') };
    return {};
  }
}
async function fixture() {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'lemon-browser-test-'))), cdp = new Cdp();
  const thread = { id: 'chat', cwd, busy: true, mode: 'workspace-write', plan: false }, workspace = { threads: new Map([['chat', thread]]), resumed: new Set(['chat']), validId(id) { assert.match(id, /^[\w-]+$/); }, get: async id => workspace.threads.get(id) };
  const target = path.join(cwd, 'Downloads'); await mkdir(target);
  const browser = new BrowserWorkspace({ stateDir: cwd, cdp, workspace, defaultDirectory: target, trashRoot: path.join(cwd, 'Trash') }); return { cwd, cdp, workspace, thread, browser, target };
}

test('browser accepts only web URLs and safe filenames', () => {
  assert.equal(browserUrl('example.test/a?q=1'), 'https://example.test/a?q=1'); assert.equal(browserUrl('about:blank'), 'about:blank');
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://u:p@example.test/', 'chrome://settings']) assert.throws(() => browserUrl(value));
  for (const name of ['../x', '/x', '.env', 'a\\b', 'a\n.sql', ' trailing ']) assert.throws(() => downloadName(name));
});

test('human and model share one tab, enforce project/mode/identity and reject stale element refs', async () => {
  const { browser, cwd, cdp, thread, workspace } = await fixture();
  const tab = await browser.action({ cwd, action: 'new', url: 'https://example.test/' });
  await assert.rejects(browser.modelCall({ action: 'list' }, thread.id), /允许 AI/);
  await browser.share({ cwd, threadId: thread.id, enabled: true });
  const content = await browser.modelCall({ action: 'snapshot', tabId: tab.id }, thread.id), snapshot = JSON.parse(content.content[0].text);
  assert.equal(snapshot.title, 'Fixture'); assert.equal(cdp.index, 1, 'AI reads the existing target, not a second browser');
  await browser.action({ cwd, tabId: tab.id, action: 'click', revision: snapshot.revision, x: 20, y: 20 });
  await assert.rejects(browser.modelCall({ action: 'click', tabId: tab.id, ref: 'e1', snapshotId: snapshot.snapshotId }, thread.id), /重新读取/);
  workspace.resumed.delete(thread.id); await assert.rejects(browser.modelCall({ action: 'reload', tabId: tab.id }, thread.id), /尚未确认运行权限/); workspace.resumed.add(thread.id);
  thread.mode = 'read-only'; await assert.rejects(browser.modelCall({ action: 'type', tabId: tab.id, ref: 'e1', text: 'x' }, thread.id), /只读/);
  assert.equal((await browser.modelCall({ action: 'screenshot', tabId: tab.id }, thread.id)).content[0].type, 'image');
  thread.mode = 'workspace-write'; thread.plan = true; await assert.rejects(browser.modelCall({ action: 'reload', tabId: tab.id }, thread.id), /计划/);
  thread.plan = false; const fresh = await browser.action({ cwd, action: 'snapshot', tabId: tab.id }); await assert.rejects(browser.modelCall({ action: 'navigate', tabId: tab.id, snapshotId: fresh.snapshotId, url: 'https://other.test/' }, thread.id), /先在共享浏览器/);
  await browser.share({ cwd, threadId: thread.id, enabled: false }); await assert.rejects(browser.modelCall({ action: 'list' }, thread.id), /允许 AI/);
});

test('element annotations inspect only the selected target without clicking or exposing input contents', async () => {
  const { browser, cwd, cdp, thread } = await fixture();
  const tab = await browser.action({ cwd, action: 'new', url: 'https://example.test/' });
  const result = await browser.action({ cwd, tabId: tab.id, action: 'inspect-element', revision: tab.revision, x: 25, y: 35 });
  assert.equal(result.element.selector, 'button#save'); assert.equal(result.element.text, 'Save');
  assert.equal(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent'), false);
  cdp.element = { tagName: 'INPUT', id: 'password', isContentEditable: false, innerText: 'sensitive', value: 'secret', getBoundingClientRect: () => ({ left: 1, top: 1, right: 80, bottom: 20 }), getAttribute: () => '' };
  const sensitive = await browser.action({ cwd, tabId: tab.id, action: 'inspect-element', revision: tab.revision, x: 3, y: 3 });
  assert.equal(sensitive.element.text, ''); assert.equal('value' in sensitive.element, false);
  await assert.rejects(browser.action({ cwd, tabId: tab.id, action: 'inspect-element', revision: tab.revision - 1, x: 3, y: 3 }), /页面已变化/);
  await assert.rejects(browser.action({ cwd, tabId: tab.id, action: 'inspect-element', revision: tab.revision, x: 'bad', y: 3 }), /位置无效/);
  await browser.share({ cwd, threadId: thread.id, enabled: true });
  const snapshot = await browser.action({ cwd, tabId: tab.id, action: 'snapshot' });
  await assert.rejects(browser.modelCall({ action: 'inspect-element', tabId: tab.id, snapshotId: snapshot.snapshotId, x: 3, y: 3 }, thread.id), /只能由用户/);
});

test('workbench origins and file requests are blocked in the real Chrome request interception path', async () => {
  const { browser, cwd, cdp } = await fixture(); browser.blockedOrigins.add('http://localhost:4318');
  await assert.rejects(browser.action({ cwd, action: 'new', url: 'https://ningmeng.com/' }), /自身/);
  const tab = await browser.action({ cwd, action: 'new' });
  await browser.event({ method: 'Fetch.requestPaused', sessionId: 'session-1', params: { requestId: 'secret', request: { url: 'http://localhost:4318/api/bootstrap' } } });
  assert.equal(cdp.calls.at(-1).method, 'Fetch.failRequest');
  await browser.event({ method: 'Fetch.requestPaused', sessionId: 'session-1', params: { requestId: 'web', request: { url: 'https://example.test/' } } });
  assert.equal(cdp.calls.at(-1).method, 'Fetch.continueRequest'); assert.equal((await browser.list(cwd)).tabs[0].id, tab.id);
});

test('downloads honor ask, versioned directory settings, reset, and no-overwrite saves', async () => {
  const { browser, cwd, target } = await fixture();
  let settings = await browser.updateSettings({ revision: 0, directory: target, ask: true }); assert.equal(settings.ask, true);
  await assert.rejects(browser.updateSettings({ revision: 0, directory: target, ask: false }), /已变化/);
  const tab = await browser.action({ cwd, action: 'new' });
  await browser.event({ method: 'Page.frameNavigated', sessionId: 'session-1', params: { frame: { id: 'frame-1', url: 'about:blank' } } });
  await browser.event({ method: 'Browser.downloadWillBegin', params: { guid: 'fixture-guid', frameId: 'frame-1', suggestedFilename: 'report.txt' } });
  await writeFile(path.join(cwd, 'browser/downloads/fixture-guid'), 'original bytes');
  await browser.event({ method: 'Browser.downloadProgress', params: { guid: 'fixture-guid', state: 'completed', receivedBytes: 14, totalBytes: 14 } });
  assert.equal(browser.downloads.get('fixture-guid').state, 'pending');
  await writeFile(path.join(target, 'report.txt'), 'existing'); await assert.rejects(browser.saveDownload({ cwd, id: 'fixture-guid', directory: target, name: 'report.txt' }), /已有同名/);
  assert.equal(await readFile(path.join(target, 'report.txt'), 'utf8'), 'existing');
  await browser.saveDownload({ cwd, id: 'fixture-guid', directory: target, name: 'report-2.txt' }); assert.equal(await readFile(path.join(target, 'report-2.txt'), 'utf8'), 'original bytes');
  settings = await browser.updateSettings({ revision: settings.revision, reset: true, ask: false }); assert.equal(settings.directory, target); assert.equal(settings.ask, false);
});

test('private MCP bridge forwards only host metadata identity to the same browser manager', async t => {
  const { browser, cwd, thread } = await fixture(), tools = new BrowserTools(browser); await tools.start(); t.after(() => tools.close());
  const config = tools.config()['mcp_servers.lemon_browser']; assert.equal(config.command, process.execPath); assert.ok(!JSON.stringify(config).includes('token'));
  const listed = await mcpRequest({ method: 'tools/list' }); assert.equal(listed.tools[0].name, 'browser_read'); assert.equal(listed.tools[0].annotations.readOnlyHint, true); assert.equal(listed.tools[1].name, 'browser_act'); assert.equal(listed.tools[0].inputSchema.additionalProperties, false);
  await assert.rejects(forwardBrowser(tools.socket, { action: 'list', threadId: thread.id }, {}), /未提供聊天身份/);
  await browser.share({ cwd, threadId: thread.id, enabled: true });
  const result = await forwardBrowser(tools.socket, { action: 'list' }, { threadId: thread.id }); assert.equal(JSON.parse(result.content[0].text).cwd, cwd);
  const denied = await forwardBrowser(tools.socket, { action: 'list' }, { threadId: 'another' }); assert.equal(denied.isError, true);
});
