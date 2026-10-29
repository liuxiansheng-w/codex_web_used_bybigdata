import { createSubmissionState } from './submission-state.js';
import { createMessageRenderer } from './message-renderer.js';
import { createDraftJournal } from './draft-journal.js';
import { markdown, escapeHtml as esc, bindMarkdownTableCopy } from './markdown.js';
import { createComposerTools } from './composer.js';
import { createPermissionControl, createApprovalBatch, createQuestionCard } from './permissions.js';
import { createDraftStore, positionPopover, createThemeControl, createAppearanceControl, createModuleThemeControls, threadDisplayState, createImageAttachment, createSidebarResize, userMessagePresentation, createFileAttachment, attachmentProjectEntry, createQuotaIndicator, applyThreadPatch, createModelSwitch, readableNotice } from './interactions.js';
import { createFileTree } from './file-tree.js';
import { createFileEditor } from './file-editor.js';
import { createEditorTools, createInlineCompletion } from './editor-tools.js';
import { createEditorContext } from './editor-context.js';
import { createLiveEdits } from './live-edits.js';
import { createWorkbench } from './workbench.js';
import { createProjectList } from './project-list.js';
import { taskResult, subtaskGroups, completedChangeSummaries, createChangeSummary } from './task-results.js';
import { renderMessageTimes, requestDuration } from './message-timing.js';
import { createSqlQuery, sqlFileFromRunnerLink } from './sql-query.js';
import { createProductUI, createGitSubmit, createTestPreview } from './product-ui.js';
import { createBottomPanel } from './editor-window.js';
import { renderActivity, renderExecutionGroup, executionLayout } from './execution-view.js';
import { renderGeneratedImage, modelRetryLabel } from './interactions.js';
import { createModelCatalogRefresh } from './interactions.js';
import { computerUseApproval } from './mcp-app-approval.js';
import { mcpFormMode, mcpFormSchema } from './mcp-form-schema.js';
import { renderMcpFields } from './mcp-form-fields.js';

// Older running servers may not yet expose the new optional static modules.
// Keep the existing workbench usable until its tasks finish and it can upgrade.
const createToolbox = (await import('./toolbox.js').catch(() => null))?.createToolbox;
const createThreadOrganization = (await import('./thread-organization.js').catch(() => null))?.createThreadOrganization;

const $ = id => document.getElementById(id);
bindMarkdownTableCopy(document, { notify: toast });
createThemeControl({ root: document.documentElement, button: $('themeToggle'), colorMeta: $('themeColor'), storage: localStorage });
createAppearanceControl({ root: document.documentElement, select: $('appearanceSelect'), storage: localStorage });
const bottomPanel = createBottomPanel({ surface: $('workSurface') });
const storage = {
  get(key) { try { return localStorage.getItem(`codex-desk:${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`codex-desk:${key}`, value); } catch {} },
};
const state = { connected: false, streaming: false, authReady: null, csrf: '', cwd: '', active: null, threads: new Map(), history: [], cursor: null, sending: false, selecting: false, loadSequence: 0, archived: false };
const threadOrganization = createThreadOrganization?.({ api, getContext: () => ({ cwd: state.cwd, available: state.threadOrganization, batch: state.threadOrganizationBatch, scope: JSON.stringify([$('search').value.trim().toLowerCase(), $('threadSearchScope').value, state.archived]) }), onChange: renderHistory, notify: toast, notice, legacyPins: pinnedThreads });
const modelCatalogRefresh = createModelCatalogRefresh({
  load: () => api('/api/models', undefined, { signal: AbortSignal.timeout(20_000) }),
  available: () => state.connected && !document.hidden && modelService() === 'codex',
  onStart: () => { $('model').setAttribute('aria-busy', 'true'); $('model').title = '正在刷新模型列表…'; },
  apply: models => { state.modelCatalog = models; $('model').title = ''; renderModelConnection(); inlineCompletion?.sync(); },
  onError: () => { $('model').title = '模型列表刷新失败，已保留当前列表和选择；稍后会再次刷新。'; },
  onFinish: () => { $('model').removeAttribute('aria-busy'); if ($('model').title === '正在刷新模型列表…') $('model').title = ''; },
});
const submissions = createSubmissionState({ api, storage: window.sessionStorage, getEpoch: () => state.submissionEpoch });
const requestCards = new Map();
const approvalBatch = createApprovalBatch({ api, getThread: selected, isConnected: () => state.connected && state.streaming, onChange: () => renderRequests(selected()?.requests || []), onComplete: toast });
const approvalToolbar = $('approvalToolbar');
approvalToolbar.querySelector('button').addEventListener('click', () => { void approvalBatch.approveAll(); });
const quotaIndicator = createQuotaIndicator({ button: $('accountQuota'), api });
const modelSwitch = createModelSwitch({ button: $('modelSwitchButton'), api,
  canSwitch: () => !(state.sending || state.switchingProject || attachingVersion || workbench.busy || composerTools.uploading || gitSubmit.busy),
  onSwitch: async value => {
    state.modelConnections = value;
    await newThread(); await bootstrap();
    toast(`已切换到 ${value.active === 'cosmos' ? 'Cosmos 自有模型' : 'Codex'}，请在新对话中使用。`);
  },
});
const elements = new Map(), executionContainers = new Map(), changeSummaries = new Map();
const renderSignatures = new WeakMap();
let visibleHistory = 120;
const replies = createMessageRenderer({
  onCopy: async (text, code = false) => { try { await navigator.clipboard.writeText(text); toast(code ? '已复制代码块' : '已复制回复'); } catch { notice('剪贴板不可用，请手动选中文字复制。'); } },
  onOpenFile: openProjectLink, runnerPath: sqlFileFromRunnerLink, onContext: addChartContext,
});
let persistenceTimer, recoverySnapshots = [], attachingVersion = false, draftWriteFailed = false, recoveryDismissed = false;
const drafts = createDraftStore({ storage: localStorage, onError: message => { draftWriteFailed = true; notice(message); } });
const editorJournal = createDraftJournal({ storage: localStorage, name: 'editorDrafts', limit: 2_000_000, onError: message => { draftWriteFailed = true; notice(message); } });
const validEditorDraft = file => typeof file?.cwd === 'string' && typeof file.path === 'string' && typeof file.content === 'string' && typeof file.baseline === 'string' && typeof file.version === 'string';
recoverySnapshots = editorJournal.latest().map(record => record.value).filter(validEditorDraft);
let persistedEditorIds = new Set();

let selectionSequence = 0, starterUndo = null;
const projectThreads = new Map();
let projectList, fileTree;
let sqlQuery, inlineCompletion, productUI, editorContext, liveEdits, toolbox, testPreview;
let renderedThread = null, executionStreamReady = false;
let stream, reconnectTimer, recoveringStream;
let reconnectAttempts = 0;
const composerTools = createComposerTools({ api, notice, getContext: () => ({ cwd: state.cwd, thread: selected() }), onChange: () => updateControls(), onDraftChange: () => saveDraft() });
const permissionControl = createPermissionControl({ onChange: updateControls, notice });
const attachProjectFile = async entry => {
  if (attachingVersion) return;
  const threadId = state.active;
  attachingVersion = true; updateControls();
  try {
    let file = fileEditor.inspect(entry), choice = 'disk';
    if (file?.dirty) {
      $('referenceVersionPath').textContent = `${entry.cwd}/${entry.path}`;
      $('referenceSave').disabled = !file.writable || file.saving || file.loading;
      choice = await new Promise(resolve => {
        const dialog = $('referenceVersionDialog');
        const finish = value => { dialog.close(); resolve(value); };
        $('referenceSnapshot').onclick = () => finish('snapshot'); $('referenceSave').onclick = () => finish('save');
        $('referenceDisk').onclick = () => finish('disk'); $('referenceCancel').onclick = () => finish(null);
        dialog.oncancel = event => { event.preventDefault(); finish(null); }; dialog.showModal();
      });
    }
    if (!choice) return;
    if (state.cwd !== entry.cwd || state.active !== threadId) throw new Error('项目或会话已变化，请重新添加。');
    if (choice === 'save' && !await fileEditor.saveFile(entry)) throw new Error('尚未成功保存，请处理文件冲突或保存错误后重新添加。');
    file = fileEditor.inspect(entry);
    if (choice === 'snapshot' && !file) throw new Error('编辑草稿已关闭，请重新选择。');
    if (await composerTools.addProjectReference({ ...entry, ...(choice === 'snapshot' ? { snapshot: file.content } : {}) })) { productUI?.showConversation(); saveDraft(); toast(`已加入${choice === 'snapshot' ? '未保存快照' : '磁盘引用'}：${entry.path}`); }
  } finally { attachingVersion = false; updateControls(); }
};
const fileEditor = createFileEditor({ api, onReveal: entry => { showSidebar(); return fileTree.setActive(entry, { force: true }); }, onAttach: attachProjectFile, onSessionError: notice, onChange: ({ restoring = false } = {}) => { productUI?.sync({ restoring }); inlineCompletion?.sync(); editorContext?.schedule(); sqlQuery?.sync(); toolbox?.sync(); fileTree?.setActive(fileEditor.current); if (projectList) { updateControls(); projectList.refresh(); } clearTimeout(persistenceTimer); persistenceTimer = setTimeout(persistEditor, 500); } });
editorContext = createEditorContext({ editor: fileEditor, getContext: () => ({ cwd: state.cwd, modelService: modelService() }) });
fileTree = createFileTree({
  api, notice, hasAttachment: (cwd, path) => composerTools.hasProjectReference(cwd, path),
  onAttach: attachProjectFile,
  onOpen: async entry => { if (await workbench.openFile(entry)) hideSidebar(); },
  onManage: entry => workbench.show('files', entry),
  onSearch: query => workbench.show('search', { query, filenames: true }),
});
projectList = createProjectList({ api, onSelect: switchProject, onGit: (cwd, action) => gitSubmit.show(cwd, { action }), getContext: () => ({ cwd: state.cwd }), getTabs: () => fileEditor.tabs, notice,
  remote: { load: () => api('/api/projects'), save: projects => api('/api/projects', { projects }) },
});
const workbench = createWorkbench({
  bottomPanel,
  api, editor: fileEditor, getContext: () => ({ cwd: state.cwd, thread: selected(), model: $('model').value, features: state.workbenchFeatures, appApprovals: state.computerUseAppApprovals, memorySettings: state.memorySettings, attachDirectory: async path => { const item = await api('/api/attachments/reference', { path }); const snapshot = composerTools.snapshot(); snapshot.files.push(item); composerTools.restoreDraft(snapshot); } }),
  onContext: addContext, onThread: id => selectThread(id, true), onProject: cwd => switchProject(cwd, true), projects: projectList, refreshFiles: () => $('refreshFiles').click(),
  getDraftPreference: () => storage.get('persistDrafts') === 'true',
  setDraftPreference, clearDrafts: clearSavedDrafts, restoreDrafts, showDraftVersions,
  onGitSubmit: cwd => gitSubmit.show(cwd),
  getArtifacts: () => taskResult(selected()).artifacts,
  getChanges: () => taskResult(selected()).changes,
});
inlineCompletion = createInlineCompletion({ editor: fileEditor, api, getConfig: () => ({ available: state.aiCompletionAvailable, model: $('model').value }) });
createEditorTools({ editor: fileEditor, api, notice, completion: inlineCompletion, onContext: addContext, onPreview: entry => workbench.previewArtifact(entry) });
sqlQuery = createSqlQuery({ editor: fileEditor, api, onContext: addContext, onChartContext: addChartContext, notice, bottomPanel });
productUI = createProductUI();
toolbox = createToolbox?.({ editor: fileEditor, notify: toast, onContext: addChartContext, getContextKey: () => JSON.stringify([state.cwd, state.active]) });
if (!toolbox) {
  $('toolboxButton').title = '工具箱模块暂时无法加载，点击查看说明';
  $('toolboxButton').onclick = () => notice('工具箱模块暂时无法加载，请刷新页面。若仍不可用，请检查服务是否已加载最新的工具箱资源。');
}
testPreview = createTestPreview({ getContext: () => ({ thread: selected(), cwd: state.cwd, live: state.connected && state.streaming && executionStreamReady && !selected()?.runtimeStale }) });
const gitSubmit = createGitSubmit({ api, getContext: () => ({ cwd: state.cwd }), getTabs: () => fileEditor.tabs, onPulled: async cwd => {
  await fileEditor.refresh({ all: true, cwd }); if (state.cwd === cwd) $('refreshFiles').click();
} });
liveEdits = createLiveEdits({ onOpen: async (file, thread) => { if (selected()?.id !== thread.id || state.cwd !== thread.cwd) throw new Error('请切回修改所属项目和会话。'); if (file.kind === 'delete') return workbench.show('git', { changes: [{ ...file, itemId: file.item.id, status: file.item.status }] }); return workbench.openFile({ cwd: thread.cwd, path: file.movePath || file.path }); }, getContext: () => ({ thread: selected(), live: state.connected && state.streaming && executionStreamReady && !selected()?.runtimeStale }) });
createModuleThemeControls({ root: document.documentElement, storage: localStorage, bottomPanel });
function addChartContext(text) {
  if (!composerTools.appendText(text)) { toast('当前正在提交消息，稍后再加入图表内容。'); return false; }
  productUI?.showConversation(); resizePrompt(); updateControls(); saveDraft(); $('prompt').focus(); toast('已加入当前对话草稿，确认后发送。'); return true;
}
function addContext(text) { productUI?.showConversation(); $('prompt').value = ($('prompt').value ? $('prompt').value + '\n\n' : '') + text; resizePrompt(); updateControls(); saveDraft(); $('prompt').focus(); }
document.addEventListener('click', event => {
  const followup = event.target.closest?.('[data-followup-prompt]');
  if (!followup || !followup.closest('.message.agent, .agent-output')) return;
  const prompt = followup.dataset.followupPrompt; if (!prompt?.trim()) return;
  addContext(prompt); toast('已填入输入框，确认后发送。');
});
function persistEditor() {
  if (storage.get('persistDrafts') !== 'true') return;
  const files = new Map(recoverySnapshots.map(file => [JSON.stringify([file.cwd, file.path]), file]));
  const activeSnapshots = fileEditor.snapshots();
  for (const file of activeSnapshots) files.set(JSON.stringify([file.cwd, file.path]), file);
  for (const id of persistedEditorIds) if (!files.has(id)) editorJournal.remove(id);
  for (const file of activeSnapshots) editorJournal.put(JSON.stringify([file.cwd, file.path]), file);
  persistedEditorIds = new Set(files.keys());
}
function clearSavedDrafts() { recoverySnapshots = []; drafts.clearSaved(); editorJournal.clear(); updateDraftStatus(); }
function setDraftPreference(enabled) {
  if (enabled && !confirm('允许此浏览器将输入和编辑草稿以明文保存在本机？请勿在共享设备上开启。')) return;
  storage.set('persistDrafts', String(enabled));
  if (enabled) { saveDraft(); persistEditor(); } else clearSavedDrafts(); updateDraftStatus();
}
async function restoreDrafts() {
  if (!recoverySnapshots.length) recoverySnapshots = editorJournal.latest().map(record => record.value).filter(validEditorDraft);
  if (!recoverySnapshots.length) return toast('没有可恢复的编辑草稿。');
  const pending = [...recoverySnapshots];
  await fileEditor.restore(pending);
  recoverySnapshots = pending.filter(file => !fileEditor.inspect(file));
  persistEditor(); updateDraftStatus();
}
function updateDraftStatus() {
  const saved = storage.get('persistDrafts') === 'true';
  $('draftStatus').textContent = draftWriteFailed ? '草稿保存失败 · 请备份' : saved ? composerTools.hasPastedText ? '正文可恢复 · 文本附件仅本页' : '本机草稿恢复已开启' : '草稿仅保留在本页';
  $('undoStarterPrompt').hidden = !starterUndo || starterUndo.cwd !== state.cwd || starterUndo.thread !== state.active || $('prompt').value !== starterUndo.after;
  $('draftChoice').hidden = storage.get('persistDrafts') !== null || !$('prompt').value.trim();
  $('draftRecovery').hidden = recoveryDismissed || !recoverySnapshots.length;
  $('draftRecoveryText').textContent = `有 ${recoverySnapshots.length} 份编辑草稿可恢复（不写入磁盘）。`;
  $('composerHelp').textContent = storage.get('enterBehavior') === 'cmd' ? '⌘ / Ctrl + Enter 发送 · Enter 换行' : 'Enter 发送 · Shift + Enter 换行';
  $('composerHelp').title = $('composerHelp').textContent;
}
let previewedDraftVersion;
function showDraftVersions() {
  const list = $('draftVersionsList'); list.replaceChildren(); $('draftVersionPreview').hidden = true; $('draftVersionsStatus').textContent = '';
  const prompts = createDraftJournal({ storage: localStorage, name: 'promptDrafts' }).list().map(record => ({ ...record, kind: 'prompt' }));
  const records = [...prompts, ...editorJournal.list().filter(record => validEditorDraft(record.value)).map(record => ({ ...record, kind: 'editor' }))].sort((a, b) => b.at - a.at);
  for (const record of records) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'draft-version-row';
    let parts; try { parts = JSON.parse(record.id); } catch { continue; }
    const label = record.kind === 'editor' ? parts[1] : '聊天草稿 · ' + (parts[1] ? String(parts[1]).slice(0, 12) : '新对话');
    row.textContent = label + ' · ' + (record.at ? new Date(record.at).toLocaleString('zh-CN') : '迁移的旧版本'); row.title = parts[0];
    row.addEventListener('click', () => { previewedDraftVersion = record; const text = record.kind === 'editor' ? record.value.content : record.value.text || ''; $('draftVersionLabel').textContent = label; $('draftVersionHint').textContent = parts[0] + (text.length > 50_000 ? ' · 仅预览前 50,000 字符，恢复保留全文' : ''); $('draftVersionText').value = text.slice(0, 50_000); $('draftVersionPreview').hidden = false; $('draftVersionRestore').textContent = record.kind === 'editor' ? '打开为未保存草稿' : '加入当前聊天草稿'; });
    list.append(row);
  }
  if (!records.length) { const empty = document.createElement('p'); empty.textContent = '尚无已保存的草稿版本。'; list.append(empty); }
  $('draftVersionsDialog').showModal();
}
$('draftVersionRestore').addEventListener('click', async () => {
  const record = previewedDraftVersion; if (!record) return;
  try {
    if (record.kind === 'prompt') { if (JSON.parse(record.id)[0] !== state.cwd) throw new Error('请先切换到草稿所属项目，再加入对话。'); addContext(record.value.text || ''); }
    else {
      const entry = record.value; if (entry.cwd !== state.cwd) throw new Error('请先切换到草稿所属项目。');
      if (fileEditor.inspect(entry)?.dirty) throw new Error('该文件已有未保存草稿，请先保存或关闭对应标签，再恢复此版本。');
      await fileEditor.restore([entry]);
      if (fileEditor.inspect(entry)?.content !== entry.content) throw new Error('尚未恢复，请检查文件是否可打开。');
    }
    $('draftVersionsDialog').close(); toast('已恢复为草稿，确认后再保存或发送。');
  } catch (error) { $('draftVersionsStatus').textContent = error.message; }
});
window.addEventListener('storage', event => { if (drafts.matchesStorage(event.key) || editorJournal.matches(event.key)) { updateDraftStatus(); if (event.key !== 'codex-desk:persistDrafts') toast('其他窗口更新了草稿，可在设置中查看各版本。'); } });

$('enableDraftRecovery').addEventListener('click', () => setDraftPreference(true));
$('keepDraftTemporary').addEventListener('click', () => setDraftPreference(false));
$('draftStatus').addEventListener('click', () => workbench.show('preferences'));
$('recoverDraftsNow').addEventListener('click', () => restoreDrafts().catch(error => notice(error.message)));
$('dismissDraftRecovery').addEventListener('click', () => { recoveryDismissed = true; updateDraftStatus(); });
window.addEventListener('beforeunload', event => {
  clearTimeout(persistenceTimer); saveDraft(); persistEditor();
  if (submissions.all().length || $('prompt').value.trim() || drafts.hasUnsent(state.cwd, state.active) || composerTools.snapshot().files.length || workbench.hasDraft || workbench.busy) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { clearTimeout(persistenceTimer); saveDraft(); persistEditor(); });
async function switchProject(cwd, fromWorkbench = false) {
  if (gitSubmit.busy) throw new Error('请等待 Git 操作完成，再切换项目。');
  if (state.sending || state.selecting || state.switchingProject || attachingVersion || (workbench.busy && !(fromWorkbench && workbench.pending === 1)) || composerTools.uploading || fileEditor.locked) throw new Error('请等待当前操作完成，再切换项目。');
  if (!cwd?.startsWith('/')) throw new Error('请输入项目文件夹的绝对路径。');
  state.switchingProject = true; updateControls();
  try {
    // Local file access must remain usable even when the model service is offline.
    const result = await api(`/api/project/files?cwd=${encodeURIComponent(cwd)}`);
    if (result.cwd === state.cwd) { projectList.remember(result.cwd); return true; }
    if (fileEditor.locked) throw new Error('请先处理编辑器中的未保存提示。');
    productUI?.showConversation();
  saveDraft(); projectThreads.set(state.cwd, state.active); selectionSequence++; state.loadSequence++;
    state.cwd = result.cwd; state.history = []; state.cursor = null; state.active = projectThreads.get(state.cwd) || null;
    state.archived = false; $('archivedThreads').checked = false; $('search').value = '';
    storage.set('cwd', state.cwd); storage.set('active', state.active || '');
    composerTools.reset(); permissionControl.reset();
    if (selected()) setThreadOptions(selected()); else renderModelConnection();
    workspaceLabel(); workbench.contextChanged(); restoreDraft(); render(true); renderHistory(); notice(null);
    if (state.connected) loadHistory().catch(error => notice(`项目已打开，会话列表暂不可用：${error.message}`));
    return true;
  } finally { state.switchingProject = false; updateControls(); }
}

let noticeThreadId = null;
function notice(message, threadId = null) {
  const text = readableNotice(message);
  $('noticeText').textContent = text;
  $('notice').hidden = !text;
  noticeThreadId = text ? threadId : null;
}
function syncThreadNotice(thread, previous = null, force = false) {
  if (!thread) return;
  const error = modelRetryLabel(thread) ? null : thread.error;
  const oldError = modelRetryLabel(previous) ? null : previous?.error;
  if (error && (force || error !== oldError)) notice(error, thread.id);
  else if (!error && noticeThreadId === thread.id) notice(null);
}

async function api(route, body, { signal } = {}) {
  const response = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Codex-CSRF': state.csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok || (route === '/api/sql/query' && result.ok === false)) throw Object.assign(new Error(result.error || `请求失败 (${response.status})`), { status: result.status || response.status });
  return result;
}

function selected() { return state.threads.get(state.active); }
function modelService() { const thread = selected(); return thread ? thread.model === 'lemon-cosmos' || thread.modelProvider === 'lemon_cosmos' ? 'cosmos' : 'codex' : state.modelConnections?.active || 'codex'; }
function renderModelConnection() {
  const cosmos = modelService() === 'cosmos';
  modelSwitch.setCurrent(cosmos ? 'cosmos' : 'codex');
  const available = (state.modelCatalog || []).filter(m => (m.id === 'lemon-cosmos') === cosmos);
  const previous = $('model').value || storage.get('model') || '';
  const previousName = [...$('model').options].find(option => option.value === previous)?.textContent || previous;
  $('model').replaceChildren(...(cosmos ? [] : [new Option('默认模型', '')]));
  for (const model of available) $('model').add(new Option(model.name || model.id, model.id));
  if (cosmos && !$('model').options.length) $('model').add(new Option('Cosmos · 待配置', 'lemon-cosmos'));
  if (previous && (previous === 'lemon-cosmos') === cosmos && ![...$('model').options].some(o => o.value === previous)) $('model').add(new Option(previousName, previous));
  if ([...$('model').options].some(o => o.value === previous)) $('model').value = previous;
  composerTools.setModels(available);
  quotaIndicator.setAvailability({ connected: state.connected, loggedIn: cosmos ? true : state.authReady, type: cosmos ? 'cosmos' : state.authType });
}
function storeThread(thread) {
  const previous = state.threads.get(thread.id);
  if (!previous || previous.runtimeStale || (thread.revision || 0) >= (previous.revision || 0)) state.threads.set(thread.id, thread);
}
function setConnection(value) {
  state.connected = value;
  if (!value || !state.streaming) executionStreamReady = false;
  quotaIndicator.setAvailability({ connected: value, loggedIn: modelService() === 'cosmos' ? true : state.authReady, type: modelService() === 'cosmos' ? 'cosmos' : state.authType });
  const online = value && state.streaming;
  $('connection').className = `connection ${online ? 'online' : 'offline'}`;
  $('connectionText').textContent = online ? (state.authReady === false ? '等待登录' : '本地已连接') : value ? '恢复实时连接…' : '未连接';
  $('reconnect').hidden = online && state.authReady !== false;
  updateControls(); renderHistory(); renderConversationHeading();
  refreshMessageTimes();
  renderRequests(selected()?.requests || []);
  // Connection changes must also stop execution motion without replacing logs.
  renderExecutionConnection();
}

function renderExecutionConnection() {
  const thread = selected(); if (!thread || renderedThread !== state.active) return;
  const live = state.connected && state.streaming && executionStreamReady && !thread.runtimeStale;
  for (const item of thread.items) {
    const element = elements.get(item.id); if (!element?.classList.contains('activity')) continue;
    const turnStatus = thread.turnTimings?.find(turn => turn.id === item.turnId)?.status || (item.turnId === thread.latestTurnId ? thread.busy ? 'inProgress' : thread.completion : null);
    renderActivity(element, { ...item, turnStatus }, { ...fileChangeOptions(thread), live, active: !!thread.busy && !!thread.turnId && item.turnId === thread.turnId, waiting: !!thread.requests?.some(request => request.params?.itemId === item.id) });
  }
  organizeExecution(thread);
}
function fileChangeOptions(thread) {
  return { cwd: thread.cwd, onOpenFile: async entry => {
    if (state.active !== thread.id || state.cwd !== entry.cwd) throw new Error('请切回这次修改所属的会话和项目后查看文件。');
    await workbench.openFile(entry);
  } };
}
function updateControls() {
  editorContext?.schedule();
  liveEdits?.sync();
  testPreview?.sync();
  const thread = selected();
  const busy = !!thread?.busy;
  const selecting = state.selecting || !!state.switchingProject || attachingVersion;
  $('sendButton').hidden = false;
  $('followupBehavior').hidden = !busy;
  const behavior = $('followupBehavior').value;
  const sendLabel = busy ? { steer: '追加指令', queue: '加入队列', interrupt: '停止并发送' }[behavior] : '发送';
  $('sendButtonLabel').textContent = sendLabel; $('sendButton').title = sendLabel; $('sendButton').setAttribute('aria-label', sendLabel);
  $('followupHint').hidden = !busy;
  $('followupHint').textContent = { steer: '补充到正在执行的任务，沿用当前模型和权限。', queue: '当前任务结束后发送，按当前模型和权限执行。', interrupt: '先停止当前任务再发送；已完成的文件修改会保留。' }[behavior];
  renderSubmission();
  $('stopButton').hidden = !busy;
  $('stopButton').disabled = !thread?.turnId || !state.connected || state.sending;
  $('sendButton').disabled = !state.connected || !state.streaming || (state.authReady === false && modelService() !== 'cosmos') || state.sending || selecting || composerTools.uploading || !composerTools.canSend || !!submissions.get(state.cwd, state.active);
  $('model').disabled = busy || state.sending || selecting;
  $('prompt').readOnly = !!state.switchingProject;
  $('mode').disabled = busy || state.sending;
  composerTools.setBusy(busy, state.sending || state.selecting || !!state.switchingProject);
  fileTree.setBusy(state.sending || selecting || composerTools.uploading);
  permissionControl.setBusy(busy || state.sending || selecting || !state.connected, composerTools.payload().plan);
  $('newThread').disabled = state.sending || !!state.switchingProject || composerTools.uploading;
  projectList?.setBusy(state.sending || selecting || composerTools.uploading || fileEditor.locked);
  $('settingsButton').disabled = state.sending || selecting || composerTools.uploading;
  $('parentThreadBack').disabled = state.sending || selecting || !!state.switchingProject;
  $('runStatus').hidden = !busy && !state.sending;
  renderRunStatus();
  $('composer').setAttribute('aria-busy', String(state.sending));
  $('conversationLoading').hidden = !state.selecting || !!thread;
  renderConversationHeading();
  updateDraftStatus();
}

function renderRunStatus() {
  const thread = selected(), duration = requestDuration(thread, undefined, state.connected && state.streaming);
  const asyncOnly = thread?.requests.length && thread.requests.every(request => ['item/tool/requestUserInput', 'item/agentMessage/answer'].includes(request.method) && request.params?.isBlocking === false);
  const label = thread?.requests.length ? asyncOnly ? '柠檬正在处理，你可以补充回答' : '等待你的回复或审批' : state.sending ? '正在发送…' : modelRetryLabel(thread) || '柠檬正在处理…';
  $('runStatusText').textContent = label + (thread?.busy && duration ? ` · ${duration.text}` : '');
}
function refreshMessageTimes() { renderMessageTimes(selected(), elements, state.connected && state.streaming); }
window.setInterval?.(() => {
  if (document.visibilityState === 'hidden' || !selected()?.busy) return;
  refreshMessageTimes(); renderRunStatus();
}, 1000);
document.addEventListener('visibilitychange', () => {
  refreshMessageTimes(); renderRunStatus();
  if (!document.hidden && state.connected) loadHistory().catch(() => {});
});
window.addEventListener('focus', () => { if (!document.hidden && state.connected) loadHistory().catch(() => {}); });

function workspaceLabel() {
  const name = state.cwd.split('/').filter(Boolean).at(-1) || state.cwd;
  $('breadcrumbWorkspace').textContent = name;
  $('breadcrumbWorkspace').title = state.cwd;
  projectList.remember(state.cwd);
  fileTree.setProject(state.cwd);
  fileEditor.setProject(state.cwd);
}

function renderHistory() {
  const historyTop = $('threadList').scrollTop;
  const focusedRow = $('threadList').contains(document.activeElement) ? document.activeElement.closest('.thread-row') : null;
  const focusedId = focusedRow?.querySelector('[data-thread-id]')?.dataset.threadId;
  const focusedMenu = document.activeElement?.classList.contains('thread-menu');
  const focusedPin = document.activeElement?.classList.contains('thread-pin');
  const focusedSelection = document.activeElement?.classList.contains('thread-select');
  const focusedGroup = document.activeElement?.dataset.groupToggle, focusedFolder = document.activeElement?.dataset.folderEdit;
  const query = $('search').value.trim().toLowerCase(), contentSearch = $('threadSearchScope')?.value === 'content' && !!query;
  const merged = new Map(state.history.map(t => [t.id, t]));
  for (const t of state.threads.values()) if (!contentSearch && t.cwd === state.cwd && !!t.archived === state.archived) merged.set(t.id, { ...merged.get(t.id), ...t, preview: t.items?.filter(item => ['userMessage', 'agentMessage'].includes(item.type)).at(-1)?.text || merged.get(t.id)?.preview || t.preview });
  const pins = threadOrganization ? new Set([...merged.values()].filter(t => threadOrganization.isPinned(t)).map(t => t.id)) : pinnedThreads();
  const timestamp = t => t.updatedAt ? Number(t.updatedAt) * (Number(t.updatedAt) < 1e12 ? 1000 : 1) : 0;
  const list = [...merged.values()].filter(t => contentSearch || t.title.toLowerCase().includes(query)).sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || timestamp(b) - timestamp(a));
  $('threadList').replaceChildren();
  const rowFor = t => {
    const updated = t.updatedAt ? new Date(t.updatedAt < 1e12 ? t.updatedAt * 1000 : t.updatedAt) : null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const button = document.createElement('button'); button.className = `thread-button${t.id === state.active ? ' active' : ''}`;
    const status = displayState(t), content = document.createElement('span'); content.className = 'thread-content';
    const title = document.createElement('strong'); title.textContent = `${pins.has(t.id) && !threadOrganization?.ready() ? '⌑ ' : ''}${t.title}`;
    const meta = document.createElement('span'); meta.className = 'thread-meta'; if (!['done', 'idle', 'new'].includes(status.key)) meta.append(statusBadge(status)); if (updated) { const time = document.createElement('time'); time.textContent = updated >= today ? updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : updated.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }); time.title = updated.toLocaleString('zh-CN'); time.dateTime = updated.toISOString(); meta.append(time); } content.append(title, meta); const preview = document.createElement('small'); preview.className = 'thread-preview'; preview.textContent = (t.preview || '').replace(/\s+/g, ' ').slice(0, 110); if (contentSearch && preview.textContent) content.append(preview); button.append(content); button.title = `${t.title}\n${status.label}${status.key === 'unknown' ? ' · 打开会话或恢复连接后核对' : ''}`;
    button.dataset.busy = String(status.key === 'running'); button.dataset.threadId = t.id;
    button.setAttribute('aria-current', t.id === state.active ? 'true' : 'false');
    button.addEventListener('click', () => { if (!threadOrganization?.activateSelection?.(t)) void selectThread(t.id); });
    const folder = threadOrganization?.folderFor(t);
    if (folder && pins.has(t.id)) { const badge = document.createElement('small'); badge.className = 'thread-folder-badge'; badge.textContent = folder.name; content.append(badge); }
    const row = document.createElement('div'); row.className = 'thread-row'; const menu = document.createElement('button'); menu.type = 'button'; menu.className = 'thread-menu'; menu.textContent = '⋯'; menu.setAttribute('aria-label', `管理会话 ${t.title}`); menu.addEventListener('click', () => openThreadActions(t)); const selection = threadOrganization?.selectionControl?.(t); if (selection) { row.append(selection); row.classList.toggle('is-selected', selection.checked); button.setAttribute('aria-pressed', String(selection.checked)); } row.append(button); const pin = threadOrganization?.pinButton(t); if (pin) row.append(pin); row.append(menu); return row;
  };
  if (!threadOrganization?.render(list, rowFor, { query })) {
    if (!list.length) { const p = document.createElement('p'); p.className = 'list-empty'; p.textContent = query ? '没有匹配的对话' : '还没有对话，点击右上角 ＋ 开始。'; $('threadList').append(p); }
    let lastGroup = '';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const t of list) {
      const updated = t.updatedAt ? new Date(timestamp(t)) : null;
      const group = pins.has(t.id) ? '置顶' : updated ? updated >= today ? '今天' : updated >= new Date(today.getTime() - 86400000) ? '昨天' : updated.toLocaleDateString('zh-CN') : '最近会话';
      if (group !== lastGroup) { const heading = document.createElement('div'); heading.className = 'history-date'; heading.textContent = group; $('threadList').append(heading); lastGroup = group; }
      $('threadList').append(rowFor(t));
    }
  }
  $('loadMore').hidden = !state.cursor;
  if (focusedId && $('mainPanel').dataset.chatView === 'history') {
    const button = [...$('threadList').querySelectorAll('[data-thread-id]')].find(button => button.dataset.threadId === focusedId);
    (focusedSelection ? button?.parentElement.querySelector('.thread-select') : focusedMenu ? button?.parentElement.querySelector('.thread-menu') : focusedPin ? button?.parentElement.querySelector('.thread-pin') : button)?.focus({ preventScroll: true });
  }
  if (focusedGroup || focusedFolder) [...$('threadList').querySelectorAll('[data-group-toggle], [data-folder-edit]')].find(button => focusedGroup ? button.dataset.groupToggle === focusedGroup : button.dataset.folderEdit === focusedFolder)?.focus({ preventScroll: true });
  $('threadList').scrollTop = historyTop;
  renderActiveThreads();
}

function displayState(thread) { return threadDisplayState(thread, state.connected && state.streaming); }
function statusBadge(status) { const badge = document.createElement('span'); badge.className = 'thread-status'; badge.dataset.state = status.key; badge.textContent = status.label; return badge; }
function renderConversationHeading() {
  $('parentThreadBack').hidden = !selected()?.parentThreadId;
  const thread = selected(), title = thread?.title || (state.active ? '正在加载对话…' : '新对话');
  const status = state.sending ? { key: 'running', label: '提交中' } : state.selecting ? { key: 'unknown', label: '同步中' } : displayState(thread);
  $('threadTitle').textContent = title; $('threadTitle').title = title;
  $('conversationTitleButton').title = `${title}\n点击查看完整名称、重命名及更多操作`;
  $('currentThreadStatus').textContent = status.label; $('currentThreadStatus').dataset.state = status.key;
  document.title = `${title}${thread?.busy ? ' · 进行中' : ''} — 柠檬`;
}
function renderActiveThreads() {
  const live = state.connected && state.streaming;
  const active = [...state.threads.values()].filter(thread => thread.busy || thread.requests?.length || thread.queue?.length).sort((a, b) => displayState(b).rank - displayState(a).rank);
  $('activityHeading').textContent = live ? '进行中的会话' : '任务状态待同步';
  document.querySelector('.session-activity').hidden = active.length === 0 && live;
  $('activityCount').textContent = String(active.length); $('activeThreadList').replaceChildren();
  $('activityEmpty').hidden = active.length > 0;
  $('activityEmpty').textContent = live ? '暂无已同步的运行任务' : '连接恢复后核对运行状态';
  $('activeThreadList').title = '显示当前服务已同步的会话，跨项目汇总；其他客户端的未同步任务不在此列表中。';
  for (const thread of active) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'active-thread'; button.dataset.threadId = thread.id;
    const name = document.createElement('strong'); name.textContent = thread.title;
    const meta = document.createElement('span'), project = document.createElement('small'); project.textContent = thread.cwd?.split('/').filter(Boolean).at(-1) || '本机项目';
    meta.append(project, statusBadge(displayState(thread))); button.append(name, meta); button.title = `${thread.title}\n${thread.cwd || ''}`;
    button.setAttribute('aria-current', String(state.active === thread.id)); button.addEventListener('click', () => selectThread(thread.id)); $('activeThreadList').append(button);
  }
}

async function loadHistory(append = false) {
  const generation = ++state.loadSequence;
  const cwd = state.cwd;
  $('historyError').hidden = true;
  let result;
  try { result = await api(`/api/threads?cwd=${encodeURIComponent(cwd)}&search=${encodeURIComponent($('search').value.trim())}&archived=${state.archived ? 1 : 0}${$('threadSearchScope')?.value === 'content' ? '&scope=content' : ''}${append && state.cursor ? `&cursor=${encodeURIComponent(state.cursor)}` : ''}`); }
  catch (error) { if (generation === state.loadSequence && cwd === state.cwd) { $('historyError').textContent = error.message; $('historyError').hidden = false; } throw error; }
  if (generation !== state.loadSequence || cwd !== state.cwd) return;
  if (result.cwd !== state.cwd) { state.cwd = result.cwd; storage.set('cwd', state.cwd); workspaceLabel(); }
  threadOrganization?.accept(result.organization);
  state.history = [...new Map((append ? [...state.history, ...result.threads] : result.threads).map(thread => [thread.id, thread])).values()];
  state.cursor = result.nextCursor;
  if ($('threadSearchInfo')) $('threadSearchInfo').textContent = $('threadSearchScope').value === 'content' && $('search').value.trim() ? `搜索当前项目会话内容${result.nextCursor ? ' · 可加载更多继续搜索' : ''}${result.partial ? ' · 部分会话未能读取，可重试' : ''}` : '';
  if (result.organizationPartial) $('threadSearchInfo').textContent += ' · 部分分组会话尚未读取，可刷新或加载更多';
  if (result.organizationError) { $('historyError').textContent = result.organizationError; $('historyError').hidden = false; }
  renderHistory();
  void threadOrganization?.migrate(result.threads);
}

function hideSidebar() { $('sidebar').classList.remove('open'); $('scrim').hidden = true; }

function saveDraft() {
  if (state.selecting || (state.active && renderedThread !== state.active)) return;
  drafts.save(state.cwd, state.active, { text: $('prompt').value, model: $('model').value, context: composerTools.snapshot() });
  updateDraftStatus();
}
function restoreDraft() {
  const draft = drafts.read(state.cwd, state.active);
  $('prompt').value = draft?.text || '';
  if (draft) {
    if ([...$('model').options].some(option => option.value === draft.model)) $('model').value = draft.model;
    composerTools.restoreDraft(draft.context);
  }
  resizePrompt(); updateControls();
}

async function selectThread(id, fromWorkbench = false, { preserveLayout = false } = {}) {
  if (gitSubmit.busy) return;
  if (state.sending || state.switchingProject || attachingVersion || (workbench.busy && !(fromWorkbench && workbench.pending === 1)) || composerTools.uploading || fileEditor.locked) return;
  productUI?.showConversation({ preserveLayout });
  if (id === state.active && selected() && !state.selecting && renderedThread === id) { hideSidebar(); return; }
  saveDraft(); projectThreads.set(state.cwd, state.active);
  const sequence = ++selectionSequence;
  state.selecting = true;
  $('prompt').value = ''; composerTools.reset(); permissionControl.reset();
  state.active = id; storage.set('active', id);
  notice(null); hideSidebar(); render(); renderHistory(); updateControls();
  try {
    const thread = await api(`/api/threads/${encodeURIComponent(id)}`);
    storeThread(thread);
    if (state.active === id && sequence === selectionSequence) {
      if (thread.cwd !== state.cwd) { state.cwd = thread.cwd; storage.set('cwd', state.cwd); workspaceLabel(); await loadHistory(); }
      if (sequence !== selectionSequence) return;
      workbench.contextChanged(); setThreadOptions(thread); restoreDraft(); render(true); renderHistory();
      syncThreadNotice(thread, null, true);
    }
  } catch (error) { if (state.active === id) notice(error.message); }
  finally { if (sequence === selectionSequence) { state.selecting = false; updateControls(); } }
}

function setThreadOptions(thread) {
  renderModelConnection();
  if (thread.model) {
    if (![...$('model').options].some(o => o.value === thread.model)) $('model').add(new Option(thread.model, thread.model));
    $('model').value = thread.model;
  }
  $('mode').value = thread.mode || 'workspace-write';
  composerTools.restore(thread);
  permissionControl.restore(thread);
}

async function newThread(preserveDraft = true) {
  if (gitSubmit.busy) return;
  if (state.sending || state.switchingProject || attachingVersion || workbench.busy || composerTools.uploading) return;
  if (preserveDraft) saveDraft();
  selectionSequence++; state.selecting = false;
  state.active = null; storage.set('active', ''); productUI?.showConversation();
  workbench.contextChanged();
  composerTools.reset();
  permissionControl.reset();
  restoreDraft();
  renderModelConnection(); inlineCompletion?.sync();
  notice(null); hideSidebar(); render(); renderHistory(); $('prompt').focus();
}

function render(forceScroll = false) {
  const t = selected();
  const area = $('scrollArea');
  const nearBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
  const changedThread = renderedThread !== state.active;
  if (changedThread) { visibleHistory = 120; executionContainers.clear(); changeSummaries.clear(); elements.clear(); $('messages').replaceChildren(); renderedThread = state.active; }
  $('loadEarlierMessages').hidden = true;
  $('welcome').hidden = !!state.active;
  $('messages').hidden = !state.active;
  renderConversationHeading();
  if (t) {
    const start = Math.max(0, t.items.length - visibleHistory), visibleItems = t.items.slice(start);
    const groups = new Map(subtaskGroups({ ...t, items: visibleItems }).map(group => [group.anchor, group]));
    const groupedIds = new Set([...groups.values()].flatMap(group => group.itemIds));
    const liveIds = new Set(visibleItems.filter(item => !groupedIds.has(item.id) || groups.has(item.id)).map(i => i.id));
    for (const [id, el] of elements) if (!liveIds.has(id)) { el.remove(); elements.delete(id); }
    $('loadEarlierMessages').hidden = !start; $('loadEarlierMessages').textContent = '加载更早记录（还有 ' + start + ' 条）';
    for (const item of visibleItems) {
      if (groupedIds.has(item.id) && !groups.has(item.id)) continue;
      let el = elements.get(item.id);
      if (!el) { el = document.createElement('article'); elements.set(item.id, el); $('messages').append(el); }
      if (groups.has(item.id)) { workbench.renderAgentGroup(el, groups.get(item.id)); continue; }
      const turnStatus = t.turnTimings?.find(turn => turn.id === item.turnId)?.status || (item.turnId === t.latestTurnId ? t.busy ? 'inProgress' : t.completion : null);
      const live = state.connected && state.streaming && executionStreamReady && !t.runtimeStale;
      const waiting = !!t.requests?.some(request => request.params?.itemId === item.id);
      const active = !!t.busy && !!t.turnId && item.turnId === t.turnId;
      const presentation = ['userMessage', 'agentMessage', 'plan'].includes(item.type) ? '' : JSON.stringify([turnStatus, live, waiting, active]);
      const cached = renderSignatures.get(el);
      if (cached?.item === item && cached.presentation === presentation) continue;
      const signature = JSON.stringify(presentation ? [item, turnStatus, live, waiting, active] : item);
      renderSignatures.set(el, { item, presentation });
      if (el.dataset.signature === signature) continue;
      el.dataset.signature = signature;
      if (item.type === 'userMessage') {
        const presentation = userMessagePresentation(item);
        el.className = 'message user';
        el.replaceChildren();
        const label = document.createElement('div'); label.className = 'message-label'; label.textContent = '你';
        const body = document.createElement('div'); body.textContent = presentation.text; body.hidden = !presentation.text;
        el.append(label, body);
        if (item.editorContext) {
          const details = document.createElement('details'); details.className = 'editor-context-history';
          const summary = document.createElement('summary'); summary.textContent = `编辑器上下文 · ${item.editorContext.label}`;
          const preview = document.createElement('pre'); preview.textContent = item.editorContext.text;
          details.append(summary, preview); el.append(details);
        }
        const actions = document.createElement('div'); actions.className = 'user-message-actions';
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制'; copy.className = 'text-button'; copy.onclick = async () => { try { await navigator.clipboard.writeText(presentation.text); toast('已复制消息'); } catch { notice('请选中文字复制。'); } };
        const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = '编辑后重发'; edit.className = 'text-button'; edit.onclick = () => { if ($('prompt').value.trim() && !confirm('用这条消息替换输入框里的草稿？')) return; productUI?.showConversation(); $('prompt').value = presentation.text; resizePrompt(); updateControls(); saveDraft(); $('prompt').focus(); if (presentation.attachments.length) notice('文字已载入输入框；需要的附件请重新选择，确认后发送。'); };
        actions.append(copy, edit); el.append(actions);
        if (presentation.attachments.length) {
          const tags = document.createElement('div'); tags.className = 'message-attachments';
          for (const attachment of presentation.attachments) {
            if (['image', 'localImage'].includes(attachment.kind)) tags.append(createImageAttachment(attachment));
            else if (['file', 'folder'].includes(attachment.kind)) {
              const entry = attachmentProjectEntry(attachment, state.cwd);
              tags.append(createFileAttachment(attachment, { onOpen: entry ? async () => {
                try { if (entry.cwd !== state.cwd) throw new Error('请切回附件所属项目后打开。'); if (entry.kind === 'folder') await workbench.show('files', entry); else await workbench.openFile(entry); }
                catch (error) { notice(error.message); }
              } : undefined }));
            }
            else { const tag = document.createElement('span'); tag.textContent = attachment.name; tags.append(tag); }
          }
          el.append(tags);
        }
      } else if (item.type === 'agentMessage' || item.type === 'plan') {
        replies.update(el, item);
      } else if (item.type === 'imageGeneration') {
        renderGeneratedImage(el, { ...item, turnStatus });
      } else {
        renderActivity(el, { ...item, turnStatus }, { ...fileChangeOptions(t), live, waiting, active, animate: !changedThread && !!item.turnId && (item.turnId === t.turnId || item.turnId === t.latestTurnId) });
      }
      if (item.type === 'fileChange' && state.workbenchFeatures) {
        const view = el.querySelector('.activity-diff') || document.createElement('button'); view.className = 'text-button activity-diff'; view.textContent = '查看差异 / 回退';
        view.onclick = () => workbench.show('git', { changes: (item.changes || []).map(change => ({ ...change, itemId: item.id, status: item.status })) }); if (!view.parentNode) el.append(view);
      }
    }
  }
  organizeExecution(t);
  renderRequests(t?.requests || []);
  composerTools.renderGoal();
  renderQueue(t);
  refreshMessageTimes();
  workbench.refreshResults();
  const usage = t?.tokenUsage; $('tokenUsage').textContent = usage ? `${Number(usage.total?.totalTokens || 0).toLocaleString()} tokens${usage.modelContextWindow ? ` · 上下文 ${Math.min(100, Math.round((usage.last?.inputTokens || 0) / usage.modelContextWindow * 100))}%` : ''}` : '';
  $('tokenUsage').title = $('tokenUsage').textContent || '运行时报告的 token 用量';
  updateControls();
  if ((forceScroll || changedThread || nearBottom) && document.getSelection?.()?.isCollapsed !== false) requestAnimationFrame(() => { area.scrollTop = area.scrollHeight; updateScrollButton(); });
  else updateScrollButton();
}

function organizeExecution(thread) {
  const blocks = executionLayout((thread?.items || []).filter(item => elements.has(item.id)));
  const summaries = completedChangeSummaries(thread);
  const summaryAnchors = new Map(summaries.map(summary => [summary.itemIds.findLast(id => elements.has(id)), summary]));
  const keys = new Set(), ordered = [];
  function appendSummary(anchor) {
    const summary = summaryAnchors.get(anchor); if (!summary) return;
    let card = changeSummaries.get(summary.key);
    if (!card) {
      const checkContext = () => { if (selected()?.id !== thread.id || state.cwd !== summary.cwd) throw new Error('请切回文件所属会话和项目后操作。'); };
      card = createChangeSummary({
        onOpen: (file, current) => { checkContext(); return workbench.openFile({ cwd: current.cwd, path: file.path }); },
        onReview: current => { checkContext(); return workbench.show('git', { changes: current.changes }); },
        onError: notice,
      }); changeSummaries.set(summary.key, card);
    }
    card.update(summary); ordered.push(card.el);
  }
  for (const block of blocks) {
    if (block.item) { ordered.push(elements.get(block.item.id)); appendSummary(block.item.id); continue; }
    const { key, turnId, items } = block; keys.add(key);
    const turnRunning = !!thread.busy && turnId === thread.turnId;
    const running = turnRunning ? items.findLast(item => item.status === 'inProgress') : null;
    const active = turnRunning && (!!running || block === blocks.at(-1));
    let group = executionContainers.get(key);
    if (!group) { group = document.createElement('details'); group.className = 'execution-group'; group.open = active; group.append(document.createElement('summary')); executionContainers.set(key, group); }
    const turnEnded = thread.turnTimings?.find(turn => turn.id === turnId)?.status || (turnId === thread.latestTurnId ? thread.completion : null);
    const interrupted = turnEnded === 'interrupted' && items.some(item => item.status === 'inProgress' || item.status === 'interrupted');
    renderExecutionGroup(group, { items, active, interrupted, live: state.connected && state.streaming && executionStreamReady && !thread.runtimeStale, waiting: !!thread.requests?.length });
    let cursor = group.firstElementChild.nextSibling;
    for (const item of items) {
      const element = elements.get(item.id);
      if (element !== cursor) group.insertBefore(element, cursor);
      cursor = element.nextSibling;
    }
    ordered.push(group); appendSummary(items.at(-1).id);
  }
  for (const [key, group] of executionContainers) if (!keys.has(key)) { group.remove(); executionContainers.delete(key); }
  const summaryKeys = new Set(summaries.map(summary => summary.key));
  for (const [key, card] of changeSummaries) if (!summaryKeys.has(key)) { card.el.remove(); changeSummaries.delete(key); }
  // Restore event order after history refreshes or late insertions. Nodes that
  // are already in place are untouched, preserving details, focus and selection.
  const messages = $('messages'); let cursor = messages.firstChild;
  for (const element of ordered) {
    if (element !== cursor) messages.insertBefore(element, cursor);
    cursor = element.nextSibling;
  }
}

function renderRequests(requests) {
  const current = approvalBatch.view(), keys = new Set(requests.map(request => request.key));
  if (!approvalToolbar.isConnected) $('requests').prepend(approvalToolbar);
  approvalToolbar.hidden = current.candidates.length < 2 && !current.batch;
  $('approvalCount').textContent = current.batch ? '正在审批' : `待审批 ${current.candidates.length} 项`;
  $('approvalProgress').textContent = current.batch ? `已处理 ${current.batch.processed} / ${current.batch.total} 项` : '仅本次已列出的命令与文件修改';
  $('approveAll').disabled = current.disabled;
  $('approveAll').textContent = current.batch ? '正在提交…' : `全部允许一次（${current.candidates.length}）`;
  const pendingKeys = new Set([...state.threads.values()].flatMap(thread => (thread.requests || []).map(request => request.key)));
  for (const [key, card] of requestCards) {
    if (!keys.has(key)) card.remove();
    if (!pendingKeys.has(key) || approvalBatch.status(key).done) { card.remove(); requestCards.delete(key); }
  }
  for (const request of requests) {
    if (approvalBatch.status(request.key).done) continue;
    if (requestCards.has(request.key)) { const card = requestCards.get(request.key); if (!card.isConnected) $('requests').append(card); continue; }
    const { params, method } = request;
    if (['item/tool/requestUserInput', 'item/agentMessage/answer'].includes(method)) {
      const card = createQuestionCard(request, (request, payload) => approvalBatch.respond(request, payload), { allowSkip: state.questionInputs === true });
      requestCards.set(request.key, card); $('requests').append(card); continue;
    }
    if (method === 'mcpServer/elicitation/request') { const card = renderMcpRequest(request); requestCards.set(request.key, card); card.dataset.requestKey = request.key; continue; }
    const card = document.createElement('form'); card.className = 'request-card'; card.dataset.requestKey = request.key; requestCards.set(request.key, card);
    const title = document.createElement('h3');
    title.textContent = method.includes('fileChange') ? '允许这次文件修改？' : method.includes('permissions') ? '允许这次权限请求？' : '允许执行这条命令？';
    card.append(title);
    const description = document.createElement('p'); description.textContent = params.reason || '请查看下方内容后决定。'; card.append(description);
    const pre = document.createElement('pre');
    const item = selected()?.items.find(i => i.id === params.itemId);
    pre.textContent = params.command || item?.text || JSON.stringify(params.permissions || params, null, 2);
    card.append(pre);
    if (params.cwd) { const cwd = document.createElement('p'); cwd.textContent = `目录：${params.cwd}`; card.append(cwd); }
    const errorText = document.createElement('p'); errorText.className = 'field-error'; errorText.setAttribute('role', 'alert');
    const actions = document.createElement('div'); actions.className = 'request-actions';
    {
      const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'secondary-button'; reject.textContent = '拒绝';
      reject.addEventListener('click', () => answer('decline')); actions.append(reject);
    }
    const accept = document.createElement('button'); accept.type = 'submit'; accept.className = 'primary-button'; accept.textContent = method === 'item/permissions/requestApproval' ? '允许本轮权限' : '允许这一次'; actions.append(accept);
    card.append(errorText, actions); $('requests').append(card);
    const answer = async decision => {
      await approvalBatch.respond(request, { decision });
    };
    card.addEventListener('submit', e => { e.preventDefault(); answer('accept'); });
  }
  for (const [key, card] of requestCards) {
    const status = approvalBatch.status(key);
    card.setAttribute('aria-busy', String(!!status.pending));
    card.querySelector('.field-error').textContent = status.error || '';
    for (const button of card.querySelectorAll('.request-actions button')) button.disabled = !!button.dataset.unsupported || !!status.pending || current.busy || !state.connected || !state.streaming;
  }
}

function queueReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { void recoverStream(); }, Math.min(10_000, 750 * 2 ** Math.min(reconnectAttempts++, 4)));
}

async function refreshSession() {
  const options = () => ({ signal: AbortSignal.timeout(15_000) });
  try { return await bootstrap(false, options()); }
  catch (error) {
    if (error.status !== 401) throw error;
    // Renew only this same-origin page session, then obtain its matching CSRF.
    // Never replay sends, approvals, SQL, or terminal requests after a failure.
    const page = await fetch('/', { credentials: 'same-origin', cache: 'no-store', ...options() });
    if (!page.ok) throw new Error('工作台暂时无法连接，正在重试。');
    await page.text();
    return bootstrap(false, options());
  }
}

function recoverStream(manual = false) {
  if (recoveringStream) return recoveringStream;
  clearTimeout(reconnectTimer);
  stream?.close(); stream = null;
  state.streaming = false; setConnection(state.connected);
  recoveringStream = (async () => {
    try {
      const data = await refreshSession();
      if (manual && !data.connected) { await api('/api/connect', {}, { signal: AbortSignal.timeout(20_000) }); await bootstrap(); }
      startStream();
      void loadHistory().catch(() => {});
    } catch (error) {
      if (manual) notice(error.message);
      queueReconnect();
    } finally { recoveringStream = null; }
  })();
  return recoveringStream;
}

async function syncActiveThread(id, source) {
  try {
    const thread = await api(`/api/threads/${encodeURIComponent(id)}`);
    if (state.active !== id || stream !== source) return;
    const previous = selected();
    storeThread(thread); render(); renderHistory(); syncThreadNotice(thread, previous);
  } catch (error) { if (state.active === id && stream === source) notice(error.message); }
}

function startStream() {
  clearTimeout(reconnectTimer); stream?.close();
  executionStreamReady = false;
  const source = stream = new EventSource('/api/events?version=2');
  const versions = new Map();
  const disconnected = () => {
    if (stream !== source) return;
    source.close(); stream = null;
    state.streaming = false; setConnection(state.connected); queueReconnect();
  };
  const listen = (name, fn) => source.addEventListener(name, event => {
    if (stream !== source) return;
    try { return Promise.resolve(fn(event)).catch(disconnected); } catch { disconnected(); }
  });
  listen('open', () => { state.streaming = true; setConnection(state.connected); });
  listen('snapshot', event => {
    reconnectAttempts = 0;
    const data = JSON.parse(event.data);
    executionStreamReady = true;
    const previous = selected();
    // A reconnected/restarted service may no longer track older browser tasks.
    // Keep their drafts/history, but do not present old busy flags as live facts.
    for (const [id, thread] of state.threads) state.threads.set(id, { ...thread, runtimeStale: true });
    versions.clear();
    for (const thread of data.threads) { versions.set(thread.id, thread); storeThread(thread); }
    setConnection(data.connected); render(); renderHistory();
    syncThreadNotice(selected(), previous);
    // Includes state missed while this browser's SSE connection was down.
    if (data.connected && state.active && (!state.threads.has(state.active) || selected()?.runtimeStale)) void syncActiveThread(state.active, source);
  });
  listen('connection', async event => {
    const data = JSON.parse(event.data); setConnection(data.connected);
    if (data.error) notice(data.error);
    if (data.connected) { await bootstrap(false); loadHistory().catch(e => notice(e.message)); }
  });
  const receiveThread = thread => {
    executionStreamReady = true;
    const previous = state.threads.get(thread.id);
    if (state.active === thread.id && previous) visibleHistory += Math.max(0, thread.items.length - previous.items.length);
    storeThread(thread);
    const changedFiles = value => JSON.stringify((value?.items || []).filter(item => item.type === 'fileChange' && item.status === 'completed').map(item => item.id));
    if (previous?.busy && !thread.busy || changedFiles(previous) !== changedFiles(thread)) void fileEditor.refresh({ all: true, cwd: thread.cwd });
    const summary = value => JSON.stringify([value?.title, value?.busy, value?.archived, value?.requests?.length, value?.queue?.length, value?.queuePaused, value?.error, value?.completion]);
    if (summary(previous) !== summary(thread)) renderHistory();
    if (state.active === thread.id) {
      render();
      syncThreadNotice(thread, previous);
    }
    if (!previous && thread.cwd === state.cwd || previous?.busy && !thread.busy) loadHistory().catch(() => {});
    if (previous?.busy && !thread.busy) void quotaIndicator.refresh();
    if (previous?.busy && !thread.busy) notifyTask('柠檬任务已结束，请查看结果。');
    if ((thread.requests?.length || 0) > (previous?.requests?.length || 0)) notifyTask('柠檬需要你的回复或审批。');
  };
  listen('thread', event => {
    const thread = JSON.parse(event.data); versions.set(thread.id, thread); receiveThread(thread);
  });
  listen('thread-patch', event => {
    const patch = JSON.parse(event.data), thread = applyThreadPatch(versions.get(patch.thread.id), patch);
    versions.set(thread.id, thread); receiveThread(thread);
  });
  source.addEventListener('error', disconnected);
}
window.addEventListener('online', () => { if (!state.streaming) void recoverStream(); });
window.addEventListener('focus', () => { if (!state.streaming) void recoverStream(); });
window.addEventListener('focus', () => { void modelCatalogRefresh.refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void modelCatalogRefresh.refresh(); });
$('model').addEventListener('focus', () => { void modelCatalogRefresh.refresh(); });
$('model').addEventListener('pointerdown', () => { void modelCatalogRefresh.refresh({ force: true }); });
window.setInterval?.(() => { void modelCatalogRefresh.refresh(); }, 60_000);

async function bootstrap(first = false, options) {
  const data = await api('/api/bootstrap', undefined, options);
  state.csrf = data.csrf;
  state.submissionEpoch = data.submissionRecovery ? data.submissionEpoch : null;
  state.aiCompletionAvailable = !!data.aiCompletionAvailable;
  state.workbenchFeatures = !!data.workbenchFeatures;
  state.threadOrganization = !!data.threadOrganization;
  state.threadOrganizationBatch = !!data.threadOrganizationBatch;
  threadOrganization?.sync();
  state.computerUseAppApprovals = !!data.computerUseAppApprovals;
  state.questionInputs = data.questionInputs === true;
  state.memorySettings = data.memorySettings === true;
  state.mcpAppApprovalPersistence = data.mcpAppApprovalPersistence === true;
  state.modelConnections = data.modelConnections || { active: 'codex' };
  state.modelCatalog = data.models;
  modelCatalogRefresh.markLoaded(); $('model').title = '';
  modelSwitch.setStatus(data.modelConnections || { error: '模型切换服务尚未加载，请稍后重新打开。' });
  $('quickAgents').hidden = !state.workbenchFeatures; $('editorHistory').hidden = !state.workbenchFeatures;
  state.authReady = data.auth?.loggedIn ?? null;
  state.authType = data.auth?.type;
  setConnection(data.connected);
  if (first) { state.cwd = storage.get('cwd') || data.cwd; state.active = storage.get('active') || null; workspaceLabel(); workbench.contextChanged(); }
  renderModelConnection();
  inlineCompletion.sync();
  permissionControl.setAvailability(data.permissions);
  $('accountName').textContent = data.auth ? '已连接账户' : '本机助手';
  $('accountStatus').textContent = data.auth?.loggedIn ? '已使用本地登录' : data.auth ? '请先在终端登录' : '正在连接';
  if (data.auth && !data.auth.loggedIn) notice('尚未登录。请在终端运行 codex login，完成后点击「重新连接」。');
  else if (data.error) notice(data.error);
  else if (data.warnings?.length) notice(data.warnings.join('\n'));
  else if (data.connected && $('noticeText').textContent.includes('柠檬正在连接')) notice(null);
  return data;
}

async function acceptSubmission(record, result = record.result) {
  const sameDraft = state.cwd === record.cwd && state.active === record.originalThread;
  if (!record.snapshot) { submissions.forget(record); notice('已确认上次消息送达，会话记录可查看结果；本页草稿保留，请避免重复发送。'); if (record.threadId) await selectThread(record.threadId); return; }
  drafts.clear(record.cwd, record.originalThread, record.snapshot.draftText);
  submissions.forget(record);
  if (!sameDraft) { toast('上次消息已发送，可从会话列表查看。'); return; }
  // Preserve any draft typed while the request was being submitted.
  if ($('prompt').value === record.snapshot.draftText) { $('prompt').value = ''; resizePrompt(); }
  state.active = result.threadId; storage.set('active', result.threadId);
  if (!state.threads.has(result.threadId)) state.threads.set(result.threadId, await api(`/api/threads/${result.threadId}`));
  workbench.contextChanged();
  composerTools.sent(record.snapshot.composerContext);
  saveDraft();
  render(true); renderHistory();
}
function renderSubmission() {
  const record = submissions.get(state.cwd, state.active);
  $('submissionStatus').hidden = !record || record.state === 'sending';
  if (!record) return;
  $('submissionStatusText').textContent = record.message || ({ pending: '服务已收到消息，正在确认启动结果。', unknown: '上次发送结果尚未确认，草稿已保留。', notFound: '服务尚无这次提交记录，可以使用原内容重新提交。' })[record.state] || '请先核对上次发送结果。';
  $('submissionRetry').hidden = record.state !== 'notFound' || !record.snapshot;
  $('submissionOpen').hidden = !record.threadId;
}
$('submissionCheck').addEventListener('click', async () => {
  const record = submissions.get(state.cwd, state.active); if (!record || state.sending) return;
  state.sending = true; updateControls();
  try {
    const result = await submissions.check(record);
    if (result.state === 'accepted') await acceptSubmission(record);
    else if (result.state === 'failed') { submissions.forget(record); notice(result.message || '上次消息未成功发送，草稿已保留。'); }
  } catch (error) { record.message = error.message; notice(error.message); }
  finally { state.sending = false; updateControls(); }
});
$('submissionRetry').addEventListener('click', async () => {
  const record = submissions.get(state.cwd, state.active); if (!record || record.state !== 'notFound' || state.sending) return;
  state.sending = true; updateControls();
  try { await acceptSubmission(record, await submissions.send(record)); }
  catch (error) { notice(error.message); }
  finally { state.sending = false; updateControls(); }
});
$('submissionOpen').addEventListener('click', () => { const record = submissions.get(state.cwd, state.active); if (record?.threadId) void selectThread(record.threadId); });
$('submissionDismiss').addEventListener('click', () => {
  const record = submissions.get(state.cwd, state.active);
  if (record && confirm('结束这次发送核对？请先确认会话里是否已执行；之后发送相同内容可能会重复执行。')) { submissions.forget(record); updateControls(); }
});
$('followupBehavior').addEventListener('change', updateControls);

$('composer').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('sendButton').disabled || state.sending) return;
  const following = !!selected()?.busy;
  if (!following && !permissionControl.beforeSend()) return;
  const draftText = $('prompt').value, text = composerTools.messageText();
  const composerContext = composerTools.payload();
  const automaticContext = editorContext.payload();
  const draftCwd = state.cwd, draftThread = state.active;
  state.sending = true; updateControls(); notice(null);
  try {
    const body = following ? { threadId: state.active, text, behavior: $('followupBehavior').value, editorContext: automaticContext, attachments: composerContext.attachments, capabilities: composerContext.capabilities } : { threadId: state.active, text, cwd: state.cwd, model: $('model').value, modelService: modelService(), ...permissionControl.payload(), ...composerContext, editorContext: automaticContext };
    const record = submissions.begin(draftCwd, draftThread, following ? '/api/followup' : '/api/send', body, { draftText, composerContext });
    record.originalThread = draftThread;
    const result = await submissions.send(record);
    await acceptSubmission(record, result);
  } catch (error) { notice(error.message); }
  finally { state.sending = false; updateControls(); $('prompt').focus(); }
});

$('stopButton').addEventListener('click', async () => {
  $('stopButton').disabled = true;
  try { await api('/api/interrupt', { threadId: state.active }); }
  catch (error) { notice(error.message); updateControls(); }
});
function resizePrompt() { $('prompt').style.height = 'auto'; $('prompt').style.height = `${Math.min($('prompt').scrollHeight, 180)}px`; }
$('prompt').addEventListener('input', () => { resizePrompt(); updateControls(); saveDraft(); });
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && (storage.get('enterBehavior') !== 'cmd' || event.metaKey || event.ctrlKey)) { event.preventDefault(); $('composer').requestSubmit(); }
});
$('model').addEventListener('change', () => storage.set('model', $('model').value));
$('newThread').addEventListener('click', () => newThread());
let historySearchTimer;
$('threadSearchScope').addEventListener('change', () => loadHistory().catch(error => notice(error.message)));
$('search').addEventListener('input', () => { renderHistory(); clearTimeout(historySearchTimer); historySearchTimer = setTimeout(() => loadHistory().catch(error => notice(error.message)), 300); });
$('archivedThreads').addEventListener('change', () => { state.archived = $('archivedThreads').checked; loadHistory().catch(error => notice(error.message)); });
$('refreshThreads').addEventListener('click', () => loadHistory().catch(e => notice(e.message)));
$('loadMore').addEventListener('click', () => loadHistory(true).catch(e => notice(e.message)));
$('dismissNotice').addEventListener('click', () => notice(null));
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { const before = $('prompt').value; addContext(button.dataset.prompt); starterUndo = { cwd: state.cwd, thread: state.active, before, after: $('prompt').value }; updateDraftStatus(); });
$('undoStarterPrompt').addEventListener('click', () => { if (!starterUndo || $('prompt').value !== starterUndo.after || state.cwd !== starterUndo.cwd || state.active !== starterUndo.thread) return; $('prompt').value = starterUndo.before; starterUndo = null; resizePrompt(); saveDraft(); updateControls(); $('prompt').focus(); });
function showSidebar() {
  if (window.matchMedia('(max-width: 760px)').matches) { $('sidebar').classList.add('open'); $('scrim').hidden = false; }
  else { $('appShell').classList.remove('sidebar-collapsed'); storage.set('sidebarCollapsed', 'false'); }
}
$('appShell').classList.toggle('sidebar-collapsed', storage.get('sidebarCollapsed') === 'true');
createSidebarResize({ shell: $('appShell'), sidebar: $('sidebar'), handle: $('sidebarResizeHandle'), storage: localStorage });
$('menuButton').addEventListener('click', () => { showSidebar(); $('fileSearch').focus(); });
$('closeSidebar').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 760px)').matches) hideSidebar();
  else { $('appShell').classList.add('sidebar-collapsed'); storage.set('sidebarCollapsed', 'true'); $('menuButton').focus(); }
});
$('scrim').addEventListener('click', hideSidebar);
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || document.querySelector('dialog[open]') || event.target.closest?.('#toolboxPanel, #testPreviewWindow')) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newThread(); }
  if ((event.metaKey || event.ctrlKey) && event.key === '/') { event.preventDefault(); productUI.showHistory({ focusSearch: true }); }
  if (event.key === 'Escape') { if ($('mainPanel').dataset.chatView === 'history') { productUI.showConversation(); $('chatHistoryButton').focus(); return; } hideSidebar(); if (!event.defaultPrevented && !fileEditor.visible) $('prompt').focus(); }
});
$('shortcutsButton').addEventListener('click', () => $('shortcutsDialog').showModal());
let toastTimer;
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2200); }
function updateScrollButton() { const area = $('scrollArea'); $('scrollBottom').hidden = !state.active || area.scrollHeight - area.scrollTop - area.clientHeight < 150; }
$('scrollArea').addEventListener('scroll', updateScrollButton, { passive: true });
$('loadEarlierMessages').addEventListener('click', () => { const area = $('scrollArea'), top = area.scrollTop, height = area.scrollHeight; visibleHistory += 120; render(); requestAnimationFrame(() => { area.scrollTop = top + area.scrollHeight - height; }); });
$('scrollBottom').addEventListener('click', () => { $('scrollArea').scrollTop = $('scrollArea').scrollHeight; updateScrollButton(); });
window.addEventListener('resize', () => {
  positionPopover($('addButton'), $('addMenu')); positionPopover($('permissionButton'), $('permissionMenu'));
  if (!window.matchMedia('(max-width: 760px)').matches) hideSidebar();
  updateScrollButton();
});
$('settingsButton').addEventListener('click', () => workbench.show('preferences'));
$('parentThreadBack').addEventListener('click', () => { const parent = selected()?.parentThreadId; if (parent) void selectThread(parent); });
$('quickAgents').addEventListener('click', () => workbench.show('agents'));
$('editorHistory').addEventListener('click', () => workbench.showHistory());
$('quickArtifacts').addEventListener('click', () => workbench.show('artifacts'));
$('reconnect').addEventListener('click', async () => {
  $('reconnect').disabled = true; notice(null);
  try {
    await recoverStream(true);
  } catch (error) { notice(error.message); }
  finally { $('reconnect').disabled = false; }
});

function pinnedThreads() { try { const value = JSON.parse(storage.get('pinnedThreads') || '[]'); return new Set(Array.isArray(value) ? value : []); } catch { return new Set(); } }
let actionThread = null;
function openThreadActions(thread = selected()) { if (!thread) return notice('请先选择一个会话。'); actionThread = thread; $('threadRename').value = thread.title; $('threadActionError').textContent = ''; threadOrganization?.prepareActions(thread); $('threadActionsDialog').showModal(); }
$('conversationTitleButton').addEventListener('click', () => openThreadActions());
$('closeThreadActions').addEventListener('click', () => $('threadActionsDialog').close());
for (const button of document.querySelectorAll('[data-thread-action]')) button.addEventListener('click', async () => {
  if (!actionThread) return; const thread = actionThread, action = button.dataset.threadAction;
  for (const control of document.querySelectorAll('[data-thread-action]')) control.disabled = true;
  try {
    if (action === 'move' || action === 'pin' && threadOrganization?.supported()) await threadOrganization.act(action, thread);
    else if (action === 'pin') { const pins = pinnedThreads(); pins.has(thread.id) ? pins.delete(thread.id) : pins.add(thread.id); storage.set('pinnedThreads', JSON.stringify([...pins])); renderHistory(); }
    else {
      if (['archive', 'fork', 'compact'].includes(action) && !confirm({ archive: '归档此会话？不会删除项目文件，可以从归档列表恢复。', fork: '从当前会话创建只读分支？不会复制或回滚项目文件，也不会自动继续目标。', compact: '整理此会话的上下文？此操作可能消耗模型额度。' }[action])) return;
      const result = await api('/api/threads/action', { threadId: thread.id, action, name: $('threadRename').value });
      if (action === 'rename') { const cached = state.threads.get(thread.id); if (cached) cached.title = $('threadRename').value.trim(); }
      if (action === 'archive' || action === 'unarchive') { const cached = state.threads.get(thread.id); if (cached) cached.archived = action === 'archive'; }
      if (action === 'archive' && state.active === thread.id) await newThread();
      await loadHistory(); if (action === 'fork') await selectThread(result.threadId); render();
    }
    $('threadActionsDialog').close();
  } catch (error) { $('threadActionError').textContent = error.message; }
  finally { for (const control of document.querySelectorAll('[data-thread-action]')) control.disabled = false; threadOrganization?.sync(); }
});
for (const [id, tab] of [['workbenchButton', 'search'], ['quickSearch', 'search'], ['quickGit', 'git'], ['quickTerminal', 'terminal']]) $(id).addEventListener('click', () => workbench.show(tab));
const nativeLink = document.createElement('a'); nativeLink.href = 'codex://'; nativeLink.textContent = '打开本机桌面客户端 ↗'; nativeLink.className = 'secondary-button'; $('recordingDialog').append(nativeLink);
function notifyTask(text) { if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') { try { const notification = new Notification('柠檬', { body: text, tag: 'codex-desk-task' }); notification.onclick = () => { window.focus(); notification.close(); }; } catch {} } }
function renderQueue(thread) {
  $('messageQueue').replaceChildren();
  for (const item of thread?.queue || []) {
    const row = document.createElement('div'), label = document.createElement('span'), remove = document.createElement('button'); label.textContent = `待发送：${item.text}`; remove.type = 'button'; remove.className = 'text-button'; remove.textContent = '取消';
    remove.addEventListener('click', async () => { try { await api('/api/queue', { threadId: thread.id, id: item.id, action: 'remove' }); } catch (error) { notice(error.message); } }); row.append(label, remove); $('messageQueue').append(row);
  }
  if (thread?.queue?.length && thread.queuePaused) { const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = '队列已暂停 · 确认继续'; button.addEventListener('click', async () => { if (!confirm('继续执行排队消息？将重新校验原权限，不恢复完全访问。')) return; try { await api('/api/queue', { threadId: thread.id, action: 'resume' }); } catch (error) { notice(error.message); } }); $('messageQueue').append(button); }
}
async function openProjectLink(target) {
  try {
    const match = target.match(/^(.*?)(?::(\d+)|#L(\d+))?$/), line = Number(match[2] || match[3] || 0);
    let relative = match[1]; if (relative.startsWith(state.cwd + '/')) relative = relative.slice(state.cwd.length + 1);
    if (relative.startsWith('/')) throw new Error('此文件不在当前项目中，请先切换项目。');
    relative = relative.replace(/^\.\//, ''); await workbench.openFile({ cwd: state.cwd, path: relative, line });
  } catch (error) { notice(error.message); }
}
function renderMcpRequest(request) {
  const { params } = request, card = document.createElement('form'); card.className = 'request-card';
  const appApproval = computerUseApproval(params);
  const persistModes = state.mcpAppApprovalPersistence ? appApproval?.persistModes || [] : [];
  const title = document.createElement('h3'); title.textContent = appApproval ? `允许使用 ${appApproval.appName}？` : `插件请求：${params.serverName}`;
  const description = document.createElement('p'); description.textContent = appApproval ? '电脑操作可查看、截图并操作此应用。请选择授权范围。' : params.message || '请检查插件要求后决定是否继续。'; card.append(title, description);
  if (appApproval) {
    if (appApproval.highRisk || appApproval.subtitle) { const detail = document.createElement('p'); detail.textContent = [appApproval.highRisk ? '较高风险' : '', appApproval.subtitle].filter(Boolean).join(' · '); card.append(detail); }
    const scopeHint = document.createElement('p'); scopeHint.textContent = persistModes.includes('always') ? `“允许此会话”仅用于当前对话；“始终允许”可在${state.computerUseAppApprovals ? '设置 → 应用授权' : '官方桌面客户端的电脑操作设置'}中撤销。` : persistModes.includes('session') ? '授权仅用于当前对话。' : '本次仅允许当前操作。'; card.append(scopeHint);
  }
  let fields = null, supported = true;
  if (params.mode === 'url') {
    try { const url = new URL(params.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); const link = document.createElement('a'); link.href = url.href; link.textContent = `打开授权页面：${url.host}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link); } catch { supported = false; }
  } else if (mcpFormMode(params.mode)) {
    const form = mcpFormSchema(params);
    fields = renderMcpFields(card, form.schema, form); supported = fields.supported;
  } else supported = false;
  if (!supported) { const info = document.createElement('p'); info.textContent = fields?.error || '此表单包含网页暂不支持的字段或地址，请拒绝本次请求并在本机桌面客户端继续。'; const link = document.createElement('a'); link.href = 'codex://'; link.textContent = '打开本机桌面客户端 ↗'; card.append(info, link); }
  const errorText = document.createElement('p'); errorText.className = 'field-error'; errorText.setAttribute('role', 'alert');
  const actions = document.createElement('div'); actions.className = 'request-actions';
  const reject = document.createElement('button'); reject.type = 'button'; reject.textContent = '拒绝'; reject.className = 'secondary-button';
  const accept = document.createElement('button'); accept.type = 'submit'; accept.textContent = appApproval ? persistModes.includes('session') ? '允许此会话' : '允许一次' : params.mode === 'url' ? '我已完成授权，继续' : '提交给此插件'; accept.className = 'primary-button'; accept.disabled = !supported; if (!supported) accept.dataset.unsupported = 'true';
  const answer = async (decision, persist) => {
    if (decision === 'accept' && !supported) return;
    let content;
    try { if (decision === 'accept' && mcpFormMode(params.mode)) content = fields.read(); }
    catch (error) { errorText.textContent = error.message; return; }
    await approvalBatch.respond(request, { decision, ...(content !== undefined ? { content } : {}), ...(persist ? { persist } : {}) });
  };
  reject.addEventListener('click', () => answer('decline')); card.addEventListener('submit', event => { event.preventDefault(); answer('accept', persistModes.includes('session') ? 'session' : undefined); }); actions.append(reject);
  if (persistModes.includes('always')) { const always = document.createElement('button'); always.type = 'button'; always.className = 'secondary-button'; always.textContent = '始终允许'; always.addEventListener('click', () => answer('accept', 'always')); actions.append(always); }
  actions.append(accept); card.append(errorText, actions); $('requests').append(card); return card;
}

try {
  await bootstrap(true);
  startStream();
  if (state.connected) {
    await loadHistory();
    if (state.active) await selectThread(state.active, false, { preserveLayout: true });
    else restoreDraft();
  } else { render(); restoreDraft(); }
  updateDraftStatus();
} catch (error) { notice(error.message); }
