import { markdown } from './markdown.js';
import { projectPath, createAgentCards, agentSummary, subtaskGroups } from './task-results.js';
import { popupLayout } from './interactions.js';
const $ = id => document.getElementById(id);
const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
const button = (text, fn) => { const el = node('button', text, 'secondary-button'); el.type = 'button'; el.addEventListener('click', fn); return el; };
export function createWorkbench({ api, editor, getContext, onContext, onThread, onProject, projects, refreshFiles, getDraftPreference, setDraftPreference, clearDrafts, restoreDrafts, bottomPanel, getArtifacts = () => [], getChanges = () => [] }) {
  let tab = 'search', searchResult = null, preview = null, git = null, sequence = 0, artifactUrl = null, pendingActions = 0, opener = null, contextKey = '', managedEntry = null, artifactSignature = '', changesSignature = '';
  let artifactViewer = null, lastArtifact = null, agentsTimer = null, agentGeneration = 0, restorePreview = null, reviewChanges = null;
  let agentsData = null, agentsPromise = null, agentsLast = 0, agentsError = '', agentsRevision = 0;
  let searchController, searchPage = 0, searchLoading = false;
  const inlineGroups = new Map();
  const dialog = node('section'); dialog.hidden = true; dialog.setAttribute('role', 'region'); dialog.id = 'workbenchDialog'; dialog.className = 'workbench-dialog'; dialog.setAttribute('aria-labelledby', 'workbenchTitle');
  dialog.innerHTML = `
    <header class="workbench-head"><div><span class="eyebrow">项目工具</span><h2 id="workbenchTitle">项目工具</h2></div><div class="workbench-groups"><button id="showTaskTools" type="button">工具</button><button id="showSettingsTools" type="button">设置</button></div><button id="closeWorkbench" type="button" class="icon-button" aria-label="收起工具面板">×</button></header>
    <div class="workbench-layout"><nav id="workbenchNav" role="tablist" aria-label="工作台功能"></nav><div class="workbench-main"><p id="workbenchProject" class="workbench-project"></p><p id="workbenchStatus" role="status" class="workbench-status"></p>
    <section data-panel="search"><h3>搜索与替换</h3><form id="projectSearchForm" class="workbench-form"><label>搜索内容<input id="projectSearchQuery" required maxlength="500" placeholder="查找代码，或定位文件…"></label><div class="inline-fields"><label><input id="searchFilenames" type="checkbox">仅文件名</label><label><input id="searchCase" type="checkbox">区分大小写</label><button class="primary-button">搜索项目</button></div></form><p class="field-hint">文件名搜索会分批遍历项目，结果可翻页；内容搜索若未完成会提示缩小范围。隐藏、依赖和项目忽略目录不参与搜索。</p><div id="projectSearchResults" class="workbench-results"></div><details><summary>替换搜索命中的文件</summary><p class="field-hint">替换区分大小写、按字面量匹配。先保存或关闭编辑器草稿；预览后需再次确认。</p><label>替换为<input id="projectReplaceText" maxlength="10000"></label><button id="projectReplacePreview" class="secondary-button" type="button">生成替换预览</button><div id="projectReplaceResults"></div><button id="projectReplaceApply" class="danger-button" type="button" hidden>确认应用这份预览</button></details></section>
    <section data-panel="files" hidden><h3>文件管理</h3><p class="field-hint">路径相对于当前项目。移动/重命名仅支持不超过 1 MB 的普通 UTF-8 文件；原文件保留在系统废纸篓。目录移动请使用本机文件管理器。</p><p id="manageSelection" class="selected-file">从左侧文件树选择文件，或输入路径。</p><details><summary>手工输入路径</summary><label>文件或目录路径<input id="managePath" placeholder="src/example.py"></label></details><label>新建文件或目录名称<input id="manageNewName" placeholder="例如 notes.md 或 reports"></label><p id="manageCreateParent" class="field-hint"></p><div class="action-grid"><button data-file="open">打开文件</button><button data-file="preview">预览 / 下载</button><button data-file="createFile">新建空文件</button><button data-file="createFolder">新建目录</button></div><label>移动 / 重命名为<input id="manageTarget" placeholder="src/new_name.py"></label><div class="action-grid"><button data-file="move">移动 / 重命名</button><button data-file="trash" class="danger-button">移到废纸篓</button></div></section>
    <section data-panel="git" hidden><h3>变更与代码审查</h3><div class="inline-fields"><button id="gitRefresh" class="secondary-button">刷新差异</button><span id="gitBranch"></span></div><section id="turnChanges" hidden aria-label="本轮记录的差异"></section><div id="gitFiles" class="git-files"></div><div id="gitFileDiff"></div><details><summary>完整工作区差异 / 手工操作</summary><pre id="gitStatus" class="workbench-output"></pre><details open><summary>未暂存差异</summary><pre id="gitUnstaged" class="workbench-output"></pre></details><details><summary>已暂存差异</summary><pre id="gitStaged" class="workbench-output"></pre></details><label>针对文件的 Git 操作<input id="gitPath" placeholder="项目内的文件相对路径"></label><div class="action-grid"><button data-git="stage">暂存此文件</button><button data-git="unstage">取消暂存</button></div></details><label>提交说明<input id="gitMessage" maxlength="1000"></label><button data-git="commit" class="secondary-button">提交已暂存修改…</button><p class="field-hint">写操作前校验刚查看的差异。提交不运行 Git hooks，不签名；按文件勾选提交与推送请使用顶部项目「⋯」菜单；PR 仍在本机客户端或终端完成。</p><hr><h4>原生代码审查</h4><label>审查范围<select id="reviewTarget"><option value="uncommittedChanges">未提交修改</option><option value="baseBranch">与基础分支比较</option><option value="commit">指定提交</option><option value="custom">自定义审查要求</option></select></label><input id="reviewValue" aria-label="分支、提交编号或审查要求" placeholder="按所选范围填写；未提交修改可留空"><button id="reviewStart" class="primary-button">在当前会话开始审查</button><p class="field-hint">原生 review/start，只读执行，会消耗模型额度；需要一个空闲会话。</p><label>行级反馈：文件:行号<input id="reviewLocation" placeholder="src/example.py:42"></label><label for="reviewComment">反馈意见</label><textarea id="reviewComment" rows="3" placeholder="针对该位置的修改意见"></textarea><button id="reviewFeedback" class="secondary-button">将行级反馈加入对话</button></section>
    <section data-panel="terminal" hidden></section>
    <section data-panel="connections" hidden><h3>插件与 MCP 连接</h3><div class="inline-fields"><button id="connectionsRefresh" class="secondary-button">刷新状态</button><button id="connectionsReload" class="secondary-button">重新载入 MCP 配置…</button></div><div id="connectionsResults"></div><div class="native-card"><strong>安装 / 移除插件</strong><p>当前官方插件管理 API 仍为开发中接口，网页不调用。已安装的技能与插件仍可从输入框「＋」选择。</p><a class="secondary-button" href="codex://">打开本机桌面客户端 ↗</a></div></section>
    <section data-panel="artifacts" hidden><h3>本轮成果与相关文件</h3><div id="artifactList" class="artifact-list"></div><details><summary>按路径打开其他文件</summary><form id="artifactForm"><label>项目内的文件路径<input id="artifactPath" required placeholder="report.html / chart.png / result.pdf"></label><button class="primary-button">预览 / 下载</button></form></details><p class="field-hint">支持图片、PDF、Excel 工作表、Markdown、文本和静态 HTML 预览。Office 文档保留原文件下载；HTML 禁止脚本、联网和表单。</p><div id="artifactResults"></div></section>
    <section data-panel="projects" hidden><h3>项目与工作树</h3><form id="projectForm"><label>工作目录绝对路径<input id="projectRoot" required placeholder="/Users/…/project"></label><div class="inline-fields"><button class="primary-button">切换主项目</button><button id="projectRemember" class="secondary-button" type="button">保存到项目列表</button><button id="projectAttach" class="secondary-button" type="button">作为附加目录引用</button></div></form><p class="field-hint">一个会话只有一个主工作目录；附加目录按引用加入对话，不会自动扩展写权限。</p><div id="projectFavorites"></div><hr><h4>创建隔离工作树</h4><label>新分支<input id="worktreeBranch" placeholder="lemon/my-task"></label><label>新工作树绝对路径<input id="worktreeDestination" placeholder="/Users/…/my-task"></label><button id="worktreeCreate" class="secondary-button">确认创建工作树…</button><pre id="worktreeList" class="workbench-output"></pre></section>
    <section data-panel="schedules" hidden><h3>本机定时任务</h3><p class="field-hint">仅服务运行、电脑唤醒且 助手已连接时触发。任务固定只读、无网络，不自动继承完全访问。重启服务后需重新启用；不补跑每一次错过的时间。会消耗模型额度，内容保存于本机 .local/schedules.json。</p><form id="scheduleForm"><label>任务内容<textarea id="scheduleText" rows="4" required maxlength="10000"></textarea></label><label>运行间隔（分钟）<input id="scheduleMinutes" type="number" value="60" min="15" max="43200" required></label><button class="primary-button">确认创建定时任务…</button></form><div id="scheduleResults"></div></section>
    <section data-panel="preferences" hidden><h3>偏好与用量</h3><label class="risk-confirm"><input id="persistDrafts" type="checkbox"><span>在此浏览器保存输入与编辑草稿（可能含敏感内容，不加密，不共享到其他设备）</span></label><div class="action-grid"><button id="recoverDrafts">恢复上次编辑草稿</button><button id="clearSavedDrafts">清除本机草稿缓存</button></div><label>输入框发送方式<select id="enterBehavior"><option value="enter">Enter 发送，Shift+Enter 换行</option><option value="cmd">⌘ / Ctrl + Enter 发送，Enter 换行</option></select></label><button id="notifyEnable" class="secondary-button">请求浏览器任务通知权限</button><p class="field-hint">通知只写任务状态，不显示代码或消息内容；关闭页面后无法接收。</p><button id="usageRefresh" class="secondary-button">刷新账户额度</button><pre id="usageResult" class="workbench-output"></pre><p class="field-hint">对话 token 用量在输入框下方显示；额度不等同于费用账单。</p></section>
    <section data-panel="native" hidden><h3>桌面客户端能力</h3><p>以下功能依赖本机桌面集成，当前网页暂不支持。点击入口不会自动授予录屏、麦克风或电脑控制权限。</p><div id="nativeCapabilities"></div><a class="primary-button" href="codex://">打开本机桌面客户端 ↗</a><p class="field-hint">若浏览器未唤起客户端，请手动打开本机桌面应用。</p><a href="https://learn.chatgpt.com/docs/overview" target="_blank" rel="noopener noreferrer">查看客户端说明 ↗</a></section>
    </div></div>`;
  $('workSurface').append(dialog);
  const agentsPanel = node('section'); agentsPanel.dataset.panel = 'agents'; agentsPanel.hidden = true;
  agentsPanel.innerHTML = '<h3>子任务</h3><div class="agents-toolbar"><span id="agentsSummary" role="status"></span><button id="agentsRefresh" class="text-button">刷新状态</button><button id="agentsParent" class="text-button" hidden>返回主任务</button></div><p id="agentsNotice" class="agent-hint" role="status"></p><p id="agentsEmpty" class="field-hint" hidden></p><div id="agentResults"></div>';
  dialog.querySelector('.workbench-main').append(agentsPanel);
  const history = node('section'); history.className = 'file-history'; history.innerHTML = '<h4>文件保存历史</h4><form id="fileHistoryForm"><label>文件路径<input id="fileHistoryPath" required placeholder="选择当前文件，或输入项目内路径"></label><div class="inline-fields"><button class="secondary-button">查看历史</button><button id="fileHistoryCurrent" type="button" class="secondary-button">当前编辑文件</button></div></form><p class="field-hint">记录启用后通过网页保存的旧版本；每文件最多 20 份，总计最多 100 份 / 24 MB，保存在本机。AI 改动可从下方修改记录回退。</p><div id="fileHistoryResults"></div>';
  $('turnChanges').before(history);
  const gitPanel = dialog.querySelector('[data-panel="git"]'), reviewSections = new Map(), reviewNav = node('div', null, 'review-navigation');
  reviewNav.setAttribute('role', 'tablist'); reviewNav.setAttribute('aria-label', '修改与历史');
  const reviewChildren = [...gitPanel.children]; let inReview = false;
  for (const [key, label] of [['changes', '本次修改'], ['history', '保存历史'], ['git', 'Git'], ['review', '代码检查']]) {
    const section = node('section'); section.dataset.reviewSection = key; section.setAttribute('role', 'tabpanel'); section.id = `review-section-${key}`;
    const tabButton = button(label, () => { selectReviewSection(key); if (key === 'git') void run(loadGit)(); }); tabButton.setAttribute('role', 'tab'); tabButton.id = `review-tab-${key}`; tabButton.setAttribute('aria-controls', section.id); section.setAttribute('aria-labelledby', tabButton.id);
    reviewNav.append(tabButton); reviewSections.set(key, section);
  }
  for (const child of reviewChildren) {
    if (child.tagName === 'H3') { child.textContent = '文件变更'; continue; }
    if (child.tagName === 'H4' && child.textContent.includes('审查')) { inReview = true; child.textContent = '检查代码'; }
    reviewSections.get(child === history ? 'history' : child.id === 'turnChanges' ? 'changes' : inReview ? 'review' : 'git').append(child);
  }
  gitPanel.append(reviewNav, ...reviewSections.values());
  const noChanges = node('p', '本轮没有记录文件修改。可在「保存历史」恢复旧版本，或在「Git」查看整个工作区。', 'field-hint'); noChanges.id = 'noTurnChanges'; reviewSections.get('changes').append(noChanges);
  function selectReviewSection(key) { for (const [id, section] of reviewSections) { section.hidden = id !== key; const control = $(`review-tab-${id}`); control.setAttribute('aria-selected', String(id === key)); control.tabIndex = id === key ? 0 : -1; } }
  selectReviewSection('changes');
  const restoreDialog = node('dialog'); restoreDialog.id = 'restoreFileDialog'; restoreDialog.className = 'restore-dialog'; restoreDialog.setAttribute('aria-labelledby', 'restoreTitle');
  restoreDialog.innerHTML = '<form method="dialog"><button class="icon-button restore-close" aria-label="取消恢复">×</button></form><h2 id="restoreTitle">预览文件恢复</h2><p id="restorePath"></p><p id="restoreLabel"></p><div id="restoreDiff"></div><p id="restoreStatus" role="status"></p><div class="inline-fields"><button id="restoreCancel" class="secondary-button">取消</button><button id="restoreApply" class="primary-button">确认恢复</button></div>';
  document.body.append(restoreDialog);
  const artifactPanel = dialog.querySelector('[data-panel="artifacts"]'), artifactBrowser = node('details');
  artifactBrowser.id = 'artifactBrowser'; artifactBrowser.open = true; artifactBrowser.append(node('summary', '选择其他文件'));
  for (const element of [...artifactPanel.children].filter(el => el.tagName !== 'H3' && el.id !== 'artifactResults')) artifactBrowser.append(element);
  $('artifactResults').before(artifactBrowser);
  function disposeArtifact() { artifactViewer?.dispose(); artifactViewer = null; }
  function close() { searchController?.abort(); dialog.hidden = true; $('workSurface').classList.remove('with-tools', 'terminal-dock'); if (!bottomPanel) terminalConsole.hide(); disposeArtifact(); sequence++; scheduleAgents(); opener?.focus(); }
  function contextChanged() {
    const key = JSON.stringify([context().cwd, context().thread?.id]); if (key === contextKey) return; searchController?.abort(); contextKey = key; managedEntry = null; artifactSignature = ''; changesSignature = ''; sequence++; searchResult = null; preview = null; git = null;
    disposeArtifact(); lastArtifact = null; artifactBrowser.open = true; dialog.classList.remove('has-artifact'); clearTimeout(agentsTimer); agentsTimer = null; agentGeneration++; agentsData = null; agentsPromise = null; agentsLast = 0; agentsError = ''; inlineGroups.clear(); panelAgentCards.update([]); reviewChanges = null; restorePreview = null; restoreDialog.close(); $('fileHistoryResults').replaceChildren(); $('agentResults').replaceChildren();
    artifactPanel.querySelector('h3').textContent = '成果与文件预览'; $('fileHistoryPath').value = '';
    for (const id of ['projectSearchResults', 'projectReplaceResults', 'gitFiles', 'gitFileDiff', 'gitStatus', 'gitUnstaged', 'gitStaged', 'artifactList', 'artifactResults', 'turnChanges', 'connectionsResults']) $(id).replaceChildren();
    for (const id of ['managePath', 'manageNewName', 'manageTarget', 'gitPath', 'gitMessage', 'reviewLocation', 'reviewComment', 'artifactPath']) $(id).value = '';
    terminalConsole.syncContext();
    updateManagedSelection();
    $('projectReplaceApply').hidden = true; $('turnChanges').hidden = true;
    if (artifactUrl) { URL.revokeObjectURL(artifactUrl); artifactUrl = null; }
    $('workbenchProject').textContent = context().cwd; status('');
    if (!dialog.hidden) { if (tab === 'artifacts') renderArtifacts(); if (tab === 'projects') renderProjects(); if (tab === 'git') renderTurnChanges(); if (tab === 'agents') void pollAgents(); }
  }
  const status = (text, terminal = false) => { (terminal && $('terminalStatus') || $('workbenchStatus')).textContent = text || ''; };
  const context = () => getContext();
  const scoped = route => `${route}?cwd=${encodeURIComponent(context().cwd)}`;
  const run = (fn, terminal = false) => async event => { const control = event?.currentTarget; if (control?.dataset?.pending) { event.preventDefault(); return; } if (control) control.dataset.pending = 'true'; if (control?.tagName === 'BUTTON') control.disabled = true; status('', terminal); pendingActions++; const expected = terminal ? context().cwd : contextKey; try { return await fn(event); } catch (error) { if ((terminal ? context().cwd : contextKey) === expected) status(error.message, terminal); } finally { pendingActions--; if (control) delete control.dataset.pending; if (control?.tagName === 'BUTTON') control.disabled = false; } };
  const bind = (id, fn) => $(id).addEventListener('click', run(fn));
  const form = (id, fn) => $(id).addEventListener('submit', run(async event => { event.preventDefault(); await fn(); }));
  const tabs = { search: '项目搜索', files: '文件管理', git: '变更与审查', agents: 'AI 子任务', terminal: '命令', artifacts: '文件预览', preferences: '常规与草稿', connections: '插件连接', projects: '项目管理', schedules: '定时任务', native: '帮助与客户端' };
  const taskTabs = new Set(['search', 'files', 'git', 'agents', 'terminal', 'artifacts']);
  for (const [id, title] of Object.entries(tabs)) { const el = button(title, () => show(id)); el.dataset.tab = id; el.id = `workbench-tab-${id}`; el.setAttribute('role', 'tab'); el.setAttribute('aria-controls', `workbench-${id}`); $('workbenchNav').append(el); }
  for (const panel of dialog.querySelectorAll('[data-panel]')) { panel.id = `workbench-${panel.dataset.panel}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `workbench-tab-${panel.dataset.panel}`); }
  const terminalPanel = dialog.querySelector('[data-panel=terminal]');
  const terminalConsole = createTerminalConsole({ root: terminalPanel, api, getContext,
    isVisible: () => bottomPanel ? bottomPanel.visible('terminal') : !dialog.hidden && tab === 'terminal',
    toolbar: document.querySelector('.bottom-panel-header'), before: $('bottomResultControls'),
  });
  if (bottomPanel) {
    bottomPanel.attachTerminal(terminalPanel); $('quickTerminal').textContent = '终端';
    bottomPanel.subscribe(() => { if (bottomPanel.visible('terminal')) void terminalConsole.refresh(); else terminalConsole.hide(); });
  }
  for (const text of ['录制技能与操作回放', '原生电脑 / 浏览器控制', '原生语音与屏幕上下文', 'Office 成果原生版式预览', '云端任务委派、托管环境及 Pull Request 流程']) { const item = node('div', null, 'native-card'); item.append(node('strong', text), node('p', '网页暂不支持 · 请在本机桌面客户端完成')); $('nativeCapabilities').append(item); }
  async function show(id = tab, entry) {
    if (id === 'terminal' && bottomPanel) { contextChanged(); close(); bottomPanel.show('terminal'); $('terminalCommand').focus(); return; }
    searchController?.abort();
    contextChanged(); tab = id; sequence++; status(''); searchLoading = false;
    if (id === 'search') renderSearchResults();
    if (id === 'git') reviewChanges = entry?.changes?.map(change => ({ ...change, path: projectPath(change.path, context().cwd) })).filter(change => change.path) || null; $('workbenchProject').textContent = context().cwd;
    if (id !== 'artifacts') disposeArtifact();
    dialog.classList.toggle('document-wide', id === 'artifacts'); dialog.classList.toggle('agents-view', id === 'agents');
    for (const panel of dialog.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== id;
    const task = taskTabs.has(id); $('workbenchTitle').textContent = task ? '项目工具' : '设置';
    for (const el of $('workbenchNav').children) { el.hidden = taskTabs.has(el.dataset.tab) !== task; el.setAttribute('aria-selected', String(el.dataset.tab === id)); el.tabIndex = el.dataset.tab === id ? 0 : -1; }
    $('showTaskTools').setAttribute('aria-pressed', String(task)); $('showSettingsTools').setAttribute('aria-pressed', String(!task));
    if (entry?.path) $('managePath').value = entry.path;
    if (dialog.hidden) opener = document.activeElement;
    dialog.hidden = false; $('workSurface').classList.add('with-tools'); $('workSurface').classList.toggle('terminal-dock', id === 'terminal');
    $('workbenchNav').querySelector(`[data-tab=${id}]`)?.focus();
    if (entry?.query != null) { $('projectSearchQuery').value = entry.query; $('searchFilenames').checked = !!entry.filenames; $('projectSearchForm').requestSubmit(); }
    if (id === 'git') { renderTurnChanges(); selectReviewSection(entry?.section || 'changes'); if (entry?.section === 'git') await run(loadGit)(); }
    if (id === 'files') { managedEntry = entry || null; $('manageNewName').value = ''; $('manageTarget').value = entry?.path || ''; updateManagedSelection(); }
    if (id === 'artifacts') { renderArtifacts(); if (!entry?.loadingArtifact && lastArtifact && !artifactViewer) void run(() => previewArtifact(lastArtifact))(); }
    if (id === 'agents') { renderAgentViews(); void pollAgents(true); }
    if (!bottomPanel) terminalConsole.hide();
    if (id === 'terminal') void terminalConsole.refresh();
    if (id === 'projects') renderProjects();
    if (id === 'preferences') { $('recoverDrafts').disabled = !editor.snapshots?.()?.length && !localStorage.getItem('codex-desk:editorDrafts'); $('clearSavedDrafts').disabled = !getDraftPreference() && !localStorage.getItem('codex-desk:editorDrafts'); $('persistDrafts').checked = getDraftPreference(); $('enterBehavior').value = localStorage.getItem('codex-desk:enterBehavior') || 'enter'; }
    if (id === 'connections') await run(loadConnections)();
    if (id === 'schedules') await run(loadSchedules)();
  }
  bind('closeWorkbench', close); bind('showTaskTools', () => show('search')); bind('showSettingsTools', () => show('preferences'));
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); close(); } });
  $('workbenchNav').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const items = [...$('workbenchNav').children].filter(el => !el.hidden); const index = items.findIndex(el => el.dataset.tab === tab); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length; show(items[next].dataset.tab); });
  async function openFile(entry) { if (await editor.open(entry)) { if (entry.line) { const content = editor.current?.content || ''; editor.select(content.split('\n').slice(0, entry.line - 1).reduce((n, line) => n + line.length + 1, 0)); } return true; } return false; }
  function renderSearchResults() {
    $('projectSearchResults').replaceChildren();
    if (!searchResult) return;
    for (const hit of searchResult.results.slice(searchPage * 200, (searchPage + 1) * 200)) { const item = button(`${hit.path}:${hit.line}\n${hit.text}`, run(() => openFile({ cwd: searchResult.cwd, ...hit }))); item.className = 'search-result'; $('projectSearchResults').append(item); }
    if (!searchLoading && (searchPage || searchResult.results.length > 200 || searchResult.nextCursor)) {
      const row = node('div', null, 'inline-fields'), previous = button('上一页', () => { searchPage--; renderSearchResults(); }); previous.disabled = searchPage === 0;
      const next = button('下一页', run(async () => { searchPage++; if (searchResult.nextCursor && searchResult.results.length < (searchPage + 1) * 200) await searchProject(true); else renderSearchResults(); })); next.disabled = !searchResult.nextCursor && searchResult.results.length <= (searchPage + 1) * 200;
      row.append(previous, node('span', `第 ${searchPage + 1} 页`), next); $('projectSearchResults').append(row);
    }
  }
  async function searchProject(append = false) {
    searchController?.abort(); searchController = new AbortController(); const controller = searchController;
    const expected = ++sequence, cwd = context().cwd, query = append ? searchResult.query : $('projectSearchQuery').value;
    const filenames = append ? searchResult.filenames : $('searchFilenames').checked, caseSensitive = append ? searchResult.caseSensitive : $('searchCase').checked;
    let cursor = append ? searchResult.nextCursor : null;
    const hits = new Map((append ? searchResult.results : []).map(hit => [`${hit.path}:${hit.line}`, hit]));
    if (!append) { searchPage = 0; searchResult = null; }
    preview = null; $('projectReplaceApply').hidden = true; $('projectReplaceResults').replaceChildren(); searchLoading = true; status('搜索中…'); renderSearchResults();
    try { do {
      const result = await api(`/api/project/search?cwd=${encodeURIComponent(cwd)}&query=${encodeURIComponent(query)}&filenames=${filenames ? 1 : 0}&caseSensitive=${caseSensitive ? 1 : 0}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, { signal: controller.signal });
      if (expected !== sequence) return;
      for (const hit of result.results) hits.set(`${hit.path}:${hit.line}`, hit);
      searchResult = { ...result, query, filenames, caseSensitive, results: [...hits.values()] }; cursor = result.nextCursor;
      status(`搜索中…已检查 ${result.scanned} 项，找到 ${hits.size} 条结果`); renderSearchResults();
    } while (cursor && hits.size < (searchPage + 1) * 200);
    if (!cursor) searchPage = Math.min(searchPage, Math.max(0, Math.ceil(hits.size / 200) - 1));
    status(`${hits.size} 条结果 · 已扫描 ${searchResult.scanned} 项${cursor ? ' · 下一页继续搜索' : ''}${searchResult.skipped ? ` · ${searchResult.skipped} 个目录无法读取` : ''}${searchResult.limited ? ' · 内容搜索结果不完整，请缩小搜索范围' : ''}`);
    } catch (error) { if (!controller.signal.aborted && expected === sequence) throw error; }
    finally { if (expected === sequence) { searchLoading = false; renderSearchResults(); } }
  }
  form('projectSearchForm', () => searchProject());
  bind('projectReplacePreview', async () => {
    if (editor.dirty) throw new Error('请先保存或关闭编辑器中的草稿，避免批量替换与未保存内容冲突。');
    if (!searchResult?.results.length || searchResult.cwd !== context().cwd) throw new Error('请先搜索当前项目。');
    preview = await api('/api/project/replace-preview', { cwd: searchResult.cwd, query: searchResult.query, replacement: $('projectReplaceText').value, paths: [...new Set(searchResult.results.map(hit => hit.path))] });
    $('projectReplaceResults').replaceChildren();
    for (const file of preview.files) { const item = node('details'); item.append(node('summary', `${file.path} · ${file.count} 处`)); const columns = node('div', null, 'version-columns'); for (const [title, text] of [['替换前', file.before], ['替换后', file.after]]) { const label = node('label', title), area = node('textarea'); area.value = text; area.readOnly = true; label.append(area); columns.append(label); } item.append(columns); $('projectReplaceResults').append(item); }
    $('projectReplaceApply').hidden = !preview.files.length;
  });
  bind('projectReplaceApply', async () => {
    if (editor.dirty) throw new Error('请先保存编辑草稿。');
    if (!preview || !confirm(`将这份预览中的 ${preview.files.length} 个文件写入磁盘？多文件写入不是原子操作，发生冲突时会停止并报告已保存的文件。`)) return;
    const result = await api('/api/project/replace-apply', { id: preview.id, confirmed: true }); status(`已保存：${result.saved.join('、') || '无'}${result.error ? `。${result.error}` : '。已打开的文件请重新载入。'}`); preview = null; $('projectReplaceApply').hidden = true; refreshFiles();
  });
  function managedParent() { return managedEntry?.kind === 'folder' ? managedEntry.path : $('managePath').value.trim().split('/').slice(0, -1).join('/'); }
  function updateManagedSelection() {
    $('manageSelection').textContent = managedEntry?.path || ($('managePath').value.trim() ? `手工路径：${$('managePath').value.trim()}` : '从左侧文件树选择文件，或输入路径。');
    $('manageCreateParent').textContent = `新建位置：${managedParent() || '项目根目录'}`;
    for (const el of dialog.querySelectorAll('[data-file]')) el.disabled = managedEntry?.kind === 'folder' && ['open', 'preview', 'move', 'trash'].includes(el.dataset.file);
  }
  $('managePath').addEventListener('input', () => { managedEntry = null; updateManagedSelection(); });
  for (const el of dialog.querySelectorAll('[data-file]')) el.addEventListener('click', run(async () => {
    const entry = { cwd: context().cwd, path: $('managePath').value.trim() }, action = el.dataset.file;
    if (['createFile', 'createFolder'].includes(action)) { const name = $('manageNewName').value.trim(); if (!name || name.includes('/') || name.includes('\\')) throw new Error('请输入一个文件或目录名称，不包含路径分隔符。'); const parent = managedParent(); entry.path = parent ? `${parent}/${name}` : name; }
    if (action === 'open') return openFile(entry);
    if (action === 'preview') return previewArtifact(entry);
    if (editor.tabs.some(t => t.cwd === entry.cwd && t.path === entry.path)) throw new Error('请先关闭此文件的编辑标签，以免移动后保留失效草稿。');
    let version;
    if (['move', 'trash'].includes(action)) { const file = await api(`/api/project/file?cwd=${encodeURIComponent(entry.cwd)}&path=${encodeURIComponent(entry.path)}`); version = file.version; if (!confirm(`${action === 'trash' ? '移到系统废纸篓' : '移动/重命名并将原文件备份到废纸篓'}：${entry.path}？`)) return; }
    const result = await api('/api/project/mutate', { ...entry, action, target: $('manageTarget').value.trim(), version, confirmed: true });
    status(result.message || '已创建。'); if (result.recovery) status(`${result.message} 可恢复路径：${result.recovery}`); refreshFiles();
    if (action === 'createFile') await openFile(entry);
  }));
  async function loadGit() {
    const cwd = context().cwd, expected = sequence; renderTurnChanges(); status('正在读取工作区变更…');
    const result = await api(scoped('/api/git')); if (cwd !== context().cwd || expected !== sequence) return;
    git = result; $('gitBranch').textContent = result.branch || 'detached HEAD'; $('gitStatus').textContent = result.status || '工作区干净'; $('gitUnstaged').textContent = result.unstaged || '无未暂存差异'; $('gitStaged').textContent = result.staged || '无已暂存差异'; $('worktreeList').textContent = result.worktrees;
    $('gitFiles').replaceChildren(); $('gitFileDiff').replaceChildren();
    if (!result.files?.length) $('gitFiles').append(node('p', '没有可显示的变更文件。完整状态可在下方展开。', 'field-hint'));
    for (const file of result.files || []) {
      const row = node('div', null, 'git-file-row');
      const label = button(file.path, () => { $('gitPath').value = file.path; renderFileDiff(file, result); }); label.className = 'git-file-name';
      row.append(label, node('span', file.untracked ? '未跟踪' : `${file.index === ' ' ? '' : '已暂存 '}${file.workingTree === ' ' ? '' : '工作区修改'}`, 'file-state'));
      const open = button('打开', run(() => openFile({ cwd, path: file.path }))); open.disabled = file.deleted; row.append(open);
      if (!file.deleted) {
        const action = file.untracked || file.workingTree !== ' ' ? 'stage' : 'unstage';
        row.append(button(action === 'stage' ? '暂存' : '取消暂存', run(() => gitAction(action, file.path, result))));
      }
      $('gitFiles').append(row);
    }
    status(result.stagedOutsideProject ? '仓库还有本项目之外的已暂存修改。请切换到仓库根目录检查后提交。' : '工作区变更包含所有来源的修改，不仅是本轮任务。');
  }
  function diffView(text, path, cwd) {
    const block = node('div', null, 'diff-lines'); let line = null;
    const lines = String(text || '').split('\n'), limited = lines.length > 1500;
    for (const content of lines.slice(0, 1500)) {
      const hunk = content.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/); if (hunk) line = Number(hunk[1]);
      const selectable = line != null && !hunk && /^[ +]/.test(content) && !content.startsWith('+++');
      const currentLine = line;
      const el = selectable ? button(`${currentLine}  ${content}`, () => { if (context().cwd !== cwd) return; $('reviewLocation').value = `${path}:${currentLine}`; selectReviewSection('review'); $('reviewComment').focus(); $('reviewComment').scrollIntoView({ block: 'nearest' }); }) : node('div', content);
      el.className = `diff-line${content.startsWith('+') ? ' diff-add' : content.startsWith('-') ? ' diff-remove' : ''}`;
      if (selectable) { el.title = `反馈 ${path}:${currentLine}`; line++; }
      block.append(el);
    }
    if (limited) block.append(node('p', '差异较长，仅呈现前 1500 行；请在完整差异中核对。', 'field-hint'));
    return block;
  }
  function renderFileDiff(file, result) {
    const target = $('gitFileDiff'); target.replaceChildren(node('h4', file.path));
    for (const [label, diff] of [['未暂存', result.unstaged], ['已暂存', result.staged]]) {
      const blocks = String(diff || '').split(/(?=^diff --git )/m).filter(block => block.split('\n').some(line => line.replace(/\t$/, '') === `+++ b/${file.path}` || line.replace(/\t$/, '') === `--- a/${file.path}`));
      if (blocks.length) { const details = node('details'); details.open = true; details.append(node('summary', `${label} · 点击新版本行号反馈`), diffView(blocks.join('\n'), file.path, result.cwd)); target.append(details); }
    }
    if (target.children.length === 1) target.append(node('p', file.untracked ? '新文件尚无 Git 差异，可直接打开检查内容。' : '该文件没有可定位的文本差异，请展开完整差异核对。', 'field-hint'));
  }
  function renderTurnChanges() {
    const changes = reviewChanges || getChanges(), target = $('turnChanges'); target.hidden = !changes.length; $('noTurnChanges').hidden = !!changes.length;
    const signature = JSON.stringify([context().cwd, context().thread?.id, changes]); if (signature === changesSignature) return; changesSignature = signature;
    target.replaceChildren(); if (!changes.length) return;
    target.append(node('h4', 'AI 文件修改记录'), node('p', '此处保留执行时的差异。磁盘可能已再次变化；命令产生的其他修改请查看工作区。', 'field-hint'));
    for (const change of changes) {
      const details = node('details'); details.open = true; details.append(node('summary', `${change.path} · ${change.status === 'completed' ? '已执行' : '结果需核对'}`), diffView(change.diff, change.path, context().cwd));
      if (context().features && change.status === 'completed') details.append(button('撤销这次改动…', run(() => previewRestore({ cwd: context().cwd, path: change.path, source: 'ai', threadId: context().thread.id, itemId: change.itemId }))));
      target.append(details);
    }
  }
  async function gitAction(action, path, expectedGit = git) {
    if (!expectedGit || expectedGit.cwd !== context().cwd) throw new Error('请先刷新当前项目的差异。');
    if (!confirm(`确认${action === 'stage' ? '暂存' : action === 'unstage' ? '取消暂存' : '提交已暂存修改'}${path ? `：${path}` : ''}？${action === 'commit' ? '提交不执行 hooks 或签名。' : ''}`)) return;
    await api('/api/git/action', { cwd: expectedGit.cwd, version: expectedGit.version, action, path, message: $('gitMessage').value.trim(), confirmed: true });
    await loadGit();
  }
  bind('gitRefresh', loadGit);
  function cleanDraft(entry) {
    const draft = editor.inspect(entry);
    if (draft && (draft.dirty || draft.saving || draft.loading)) throw new Error('这个文件有未保存草稿或正在读写，请先保存或关闭草稿，再预览恢复。');
  }
  async function previewRestore(input) {
    cleanDraft(input); const expected = contextKey;
    const result = await api('/api/project/restore-preview', input); if (contextKey !== expected) return;
    cleanDraft(input); restorePreview = result; $('restorePath').textContent = result.path; $('restoreLabel').textContent = result.label; $('restoreStatus').textContent = '− 标记将移除的内容，＋ 标记恢复后的内容。确认前不会修改文件。';
    $('restoreDiff').replaceChildren();
    if (result.diff) {
      const block = node('pre', null, 'restore-diff');
      for (const line of result.diff.split('\n').slice(0, 3000)) {
        if (/^=+$/.test(line) || line.startsWith('Index:')) continue;
        const label = line.startsWith('--- ') ? '--- 当前磁盘' : line.startsWith('+++ ') ? '+++ 恢复后' : line;
        block.append(node('span', `${label}\n`, line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : ''));
      }
      $('restoreDiff').append(block);
      if (result.diff.split('\n').length > 3000) $('restoreDiff').append(node('p', '差异超过 3,000 行，下方可展开完整内容核对。', 'field-hint'));
    }
    const full = node('details'); full.append(node('summary', '对照完整内容'));
    const columns = node('div', null, 'restore-columns');
    for (const [title, content] of [['当前磁盘', result.before], ['恢复后', result.remove ? '文件将移到系统废纸篓' : result.after]]) { const side = node('section'); side.append(node('h4', title), node('pre', content, 'workbench-output')); columns.append(side); }
    full.append(columns); $('restoreDiff').append(full); $('restoreApply').textContent = result.remove ? '确认移到废纸篓' : '确认恢复'; $('restoreApply').disabled = false;
    restoreDialog.showModal(); $('restoreCancel').focus();
  }
  bind('restoreCancel', () => restoreDialog.close());
  $('restoreApply').addEventListener('click', async () => {
    if (!restorePreview || $('restoreApply').disabled) return; const entry = restorePreview; $('restoreApply').disabled = true; pendingActions++;
    try {
      cleanDraft(entry); const result = await api('/api/project/restore-apply', { id: entry.id, confirmed: true });
      restorePreview = null; restoreDialog.close(); await editor.refresh({ all: true, cwd: entry.cwd }); refreshFiles();
      status(result.removed ? `已移到废纸篓：${result.recovery}` : '文件已恢复，编辑器已同步。恢复前的版本保留在保存历史中。');
      if ($('fileHistoryPath').value === entry.path) await loadFileHistory(entry.path);
    } catch (error) { $('restoreStatus').textContent = error.message; $('restoreApply').disabled = false; }
    finally { pendingActions--; }
  });
  async function loadFileHistory(path) {
    const cwd = context().cwd, expected = contextKey;
    const result = await api(`/api/project/history?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`); if (expected !== contextKey) return;
    $('fileHistoryResults').replaceChildren();
    if (!result.versions.length) $('fileHistoryResults').append(node('p', '暂无保存历史；首次保存修改后会自动保留旧版本。', 'field-hint'));
    for (const revision of result.versions) { const row = node('div', null, 'history-row'); row.append(node('span', new Date(revision.at).toLocaleString()), button('预览恢复', run(() => previewRestore({ cwd, path, source: 'history', revisionId: revision.id })))); $('fileHistoryResults').append(row); }
  }
  form('fileHistoryForm', () => loadFileHistory($('fileHistoryPath').value.trim()));
  bind('fileHistoryCurrent', async () => { const current = editor.current; if (!current || current.cwd !== context().cwd) throw new Error('请先打开当前项目中的文本文件。'); $('fileHistoryPath').value = current.path; await loadFileHistory(current.path); });
  async function showHistory(entry = editor.current) { if (!entry) return; await show('git', { section: 'history' }); $('fileHistoryPath').value = entry.path; await run(() => loadFileHistory(entry.path))(); history.scrollIntoView({ block: 'nearest' }); }
  async function openAgent(id) { pendingActions++; try { await onThread(id); } finally { pendingActions--; } }
  async function stopAgent(id) {
    const parent = context().thread?.id, expected = agentGeneration;
    await api(`/api/threads/${encodeURIComponent(parent)}/agents/interrupt`, { childId: id });
    if (expected === agentGeneration) await pollAgents(true);
  }
  const agentOptions = { onOpen: openAgent, onStop: stopAgent, onFile: (file, agent) => {
    const cwd = agent.cwd || context().cwd, path = projectPath(file, cwd);
    if (path && cwd === context().cwd) void run(() => openFile({ cwd, path }))();
    else void openAgent(agent.id);
  } };
  const panelAgentCards = createAgentCards($('agentResults'), agentOptions);
  function resolveAgents(group) {
    const latest = new Map((agentsData?.agents || []).map(agent => [agent.id, agent]));
    return group.agents.map(agent => {
      const fresh = latest.get(agent.id);
      const value = fresh && agent.live ? { ...agent, ...fresh } : { ...agent, name: fresh?.name || agent.name, canStop: false };
      return agentsError && agent.live ? { ...value, status: 'unknown', canStop: false } : value;
    });
  }
  function renderAgentGroup(container, group) {
    let view = inlineGroups.get(group.anchor);
    if (!view || view.container !== container) {
      const head = node('header', null, 'subtasks-heading'), summary = node('span'), notice = node('p', '', 'agent-hint'), cards = node('div', null, 'subtasks-cards');
      head.append(node('strong', '子任务'), summary, button('任务面板', () => show('agents'))); notice.setAttribute('role', 'status');
      container.replaceChildren(head, notice, cards); container.className = 'subtasks-inline'; container.setAttribute('aria-label', '子任务进展与结果');
      view = { container, group, summary, notice, cards: createAgentCards(cards, agentOptions) }; inlineGroups.set(group.anchor, view);
    } else if (JSON.stringify(view.group.agents) !== JSON.stringify(group.agents)) {
      const changed = group.agents.filter(agent => JSON.stringify(view.group.agents.find(old => old.id === agent.id)) !== JSON.stringify(agent));
      if (agentsData) agentsData.agents = agentsData.agents.filter(agent => !changed.some(next => next.id === agent.id));
      agentsRevision++; agentsLast = 0;
    }
    view.group = group; const agents = resolveAgents(group); view.summary.textContent = agentSummary(agents); view.cards.update(agents);
    view.notice.textContent = agentsError && group.agents.some(agent => agent.live) ? '同步暂时中断，保留已显示的内容，正在重试。' : ''; view.notice.hidden = !view.notice.textContent;
  }
  function renderAgentViews() {
    const area = $('scrollArea'), atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 100;
    for (const [id, view] of inlineGroups) { if (!view.container.isConnected) inlineGroups.delete(id); else renderAgentGroup(view.container, view.group); }
    if (!dialog.hidden && tab === 'agents') {
      const rows = agentsData?.agents || subtaskGroups(context().thread).flatMap(group => group.agents.filter(agent => agent.live));
      const agents = agentsError ? rows.map(agent => ({ ...agent, status: 'unknown', canStop: false })) : rows;
      panelAgentCards.update(agents); $('agentsSummary').textContent = agents.length ? agentSummary(agents) : '';
      $('agentsNotice').textContent = agentsError ? '同步暂时中断，已保留上次内容，正在自动重试。' : agentsData?.limited ? '部分子任务尚未展开，可刷新后查看。' : '自动更新';
      $('agentsEmpty').hidden = !!agents.length; $('agentsEmpty').textContent = !context().thread ? '选择一个会话，查看它的子任务。' : agentsData ? '这个会话还没有子任务。' : '正在同步子任务…';
      const parent = agentsData?.parentThreadId || context().thread?.parentThreadId;
      $('agentsParent').hidden = !parent; $('agentsParent').onclick = parent ? run(() => onThread(parent)) : null;
    }
    if (atBottom && document.getSelection?.()?.isCollapsed !== false) requestAnimationFrame(() => { if (context().thread) area.scrollTop = area.scrollHeight; });
  }
  function wantsAgents() { return context().features && context().thread && document.visibilityState !== 'hidden' && ((!dialog.hidden && tab === 'agents') || inlineGroups.size > 0); }
  function scheduleAgents() {
    clearTimeout(agentsTimer); agentsTimer = null; if (!wantsAgents()) return;
    const active = context().thread?.busy || agentsError || !agentsData || agentsData.agents.some(agent => ['pendingInit', 'running', 'waiting', 'unknown'].includes(agent.status));
    agentsTimer = setTimeout(() => void pollAgents(), active ? 2500 : 15000);
  }
  async function pollAgents(force = false) {
    if (!wantsAgents()) return;
    const id = context().thread.id;
    if (agentsPromise?.id === id) return agentsPromise.promise;
    if (!force && Date.now() - agentsLast < 2000) { scheduleAgents(); return; }
    clearTimeout(agentsTimer); agentsTimer = null; const expected = agentGeneration, revision = agentsRevision, request = { id };
    $('agentsRefresh').disabled = true;
    request.promise = (async () => {
      try {
        const result = await api(`/api/threads/${encodeURIComponent(id)}/agents`);
        if (expected !== agentGeneration || context().thread?.id !== id || revision !== agentsRevision) return;
        const old = new Map((agentsData?.agents || []).map(agent => [agent.id, agent]));
        result.agents = result.agents.map(agent => agent.status === 'unknown' && !agent.message && old.get(agent.id)?.message ? { ...agent, message: old.get(agent.id).message } : agent);
        agentsData = result; agentsError = ''; agentsLast = Date.now(); renderAgentViews();
      } catch (error) {
        if (expected === agentGeneration && context().thread?.id === id) { agentsError = error.message; agentsLast = Date.now(); renderAgentViews(); }
      } finally { if (agentsPromise === request) agentsPromise = null; if (expected === agentGeneration) { $('agentsRefresh').disabled = false; scheduleAgents(); } }
    })();
    agentsPromise = request; return request.promise;
  }
  // A read-only refresh must not lock navigation or unsent drafts.
  $('agentsRefresh').addEventListener('click', () => void pollAgents(true));
  document.addEventListener('visibilitychange', () => { clearTimeout(agentsTimer); agentsTimer = null; if (document.visibilityState !== 'hidden') void pollAgents(true); });
  for (const el of dialog.querySelectorAll('[data-git]')) el.addEventListener('click', run(async () => {
    await gitAction(el.dataset.git, $('gitPath').value.trim());
  }));
  bind('reviewStart', async () => {
    const thread = context().thread; if (!thread) throw new Error('请先选择一个已有会话。');
    if (!confirm('开始原生只读代码审查？会消耗模型额度。')) return;
    const type = $('reviewTarget').value, field = { baseBranch: 'branch', commit: 'sha', custom: 'instructions' }[type];
    await api('/api/review', { threadId: thread.id, target: { type, ...(field ? { [field]: $('reviewValue').value } : {}) } }); close();
  });
  bind('reviewFeedback', () => { if (!$('reviewLocation').value.trim() || !$('reviewComment').value.trim()) throw new Error('请填写文件行号和反馈。'); onContext(`代码审查反馈\n位置：${$('reviewLocation').value}\n${$('reviewComment').value}`); close(); });
  async function loadConnections() {
    const expected = sequence;
    const result = await api(`/api/connections${context().thread ? `?threadId=${encodeURIComponent(context().thread.id)}` : ''}`); if (expected !== sequence) return; $('connectionsResults').replaceChildren();
    for (const server of result.servers) {
      const card = node('div', null, 'native-card'); card.append(node('strong', server.name), node('p', `授权：${server.authStatus} · ${server.tools.length} 个工具`));
      const tools = node('details'); tools.append(node('summary', '工具清单'), node('pre', server.tools.join('\n'), 'workbench-output')); card.append(tools);
      card.append(button('授权连接…', run(async () => { if (!confirm(`为 ${server.name} 开始 OAuth 授权？下一步会显示登录地址，请检查网站再打开。`)) return; const result = await api('/api/connections/action', { action: 'login', name: server.name, threadId: context().thread?.id, confirmed: true }); const link = node('a', `打开授权网站：${new URL(result.authorizationUrl).host}`); link.href = result.authorizationUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link); }))); $('connectionsResults').append(card);
    }
    if (!result.servers.length) $('connectionsResults').append(node('p', '没有已配置的 MCP 连接。'));
  }
  bind('connectionsRefresh', loadConnections); bind('connectionsReload', async () => { if (!confirm('重新载入本机 MCP 配置？')) return; await api('/api/connections/action', { action: 'reload', confirmed: true }); await loadConnections(); });
  async function previewArtifact(entry) {
    if (/\.(pdf|xlsx|xls|xlsm)$/i.test(entry.path)) { close(); return editor.open(entry); }
    await show('artifacts', { loadingArtifact: true }); disposeArtifact(); lastArtifact = entry; $('artifactResults').replaceChildren(); $('artifactPath').value = entry.path; status('正在读取磁盘版本…');
    const expected = sequence;
    const result = await api(`/api/project/artifact?cwd=${encodeURIComponent(entry.cwd)}&path=${encodeURIComponent(entry.path)}`);
    if (expected !== sequence || entry.cwd !== context().cwd) return;
    artifactBrowser.open = false; artifactPanel.querySelector('h3').textContent = result.name; dialog.classList.add('has-artifact');
    if (artifactUrl) URL.revokeObjectURL(artifactUrl);
    const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0)), ext = result.extension;
    const type = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' })[ext] || 'application/octet-stream';
    artifactUrl = URL.createObjectURL(new Blob([bytes], { type })); const container = $('artifactResults'); container.replaceChildren();
    const download = node('a', `下载 ${result.name}`, 'secondary-button'); download.href = artifactUrl; download.download = result.name; container.append(download);
    container.append(button('重新读取', run(() => previewArtifact(entry))));
    if (result.richPreview && ['.pdf', '.xlsx', '.xls', '.xlsm'].includes(ext)) {
      const { createArtifactViewer } = await import('./artifact-viewer.js');
      if (expected !== sequence || entry.cwd !== context().cwd) return;
      artifactViewer = createArtifactViewer({ container, bytes, entry, result, api });
    }
    else if (type.startsWith('image/')) { const image = node('img'); image.src = artifactUrl; image.alt = result.name; image.className = 'artifact-image'; container.append(image); }
    else if (ext === '.html' || ext === '.htm') { const frame = node('iframe'); frame.setAttribute('sandbox', ''); frame.title = `静态预览：${result.name}`; frame.src = `/api/project/preview?cwd=${encodeURIComponent(entry.cwd)}&path=${encodeURIComponent(entry.path)}`; container.append(frame); }
    else if (['.md', '.txt', '.sql', '.py', '.json', '.csv', '.tsv', '.log'].includes(ext)) { const text = new TextDecoder().decode(bytes); if (ext === '.md') { const block = node('div', null, 'artifact-markdown'); block.innerHTML = markdown(text.slice(0, 200000)); container.append(block); } else container.append(node('pre', text.slice(0, 200000), 'workbench-output')); if (text.length > 200000) container.append(node('p', '预览已截断，下载保留完整文件。')); }
    else { container.append(node('p', '此格式不提供网页内版式预览，请下载后打开，或切换到本机桌面客户端。')); const link = node('a', '打开本机桌面客户端 ↗'); link.href = 'codex://'; container.append(link); }
    status('这是磁盘上的文件；编辑器未保存的草稿不会出现在此预览中。');
  }
  form('artifactForm', () => previewArtifact({ cwd: context().cwd, path: $('artifactPath').value.trim() }));
  function renderArtifacts() {
    const artifacts = getArtifacts();
    const signature = JSON.stringify([context().cwd, artifacts]); if (signature === artifactSignature) return; artifactSignature = signature;
    const container = $('artifactList'); container.replaceChildren();
    if (!artifacts.length) container.append(node('p', '本轮尚无已记录的成果文件。可从文件树选择文件预览，或展开下方路径输入。', 'field-hint'));
    for (const file of artifacts) { const relative = projectPath(file.path, context().cwd); if (!relative) continue; const row = node('div', null, 'artifact-row'); row.append(button(relative, run(() => previewArtifact({ cwd: context().cwd, path: relative }))), node('small', file.source || '本轮相关文件')); container.append(row); }
  }
  function renderProjects() { $('projectRoot').value = context().cwd; $('projectFavorites').replaceChildren(); for (const cwd of projects.list()) { const row = node('div', null, 'project-favorite'); row.append(button(cwd, run(async () => { if (await onProject(cwd)) close(); })), button('移除', run(() => { projects.forget(cwd); renderProjects(); }))); $('projectFavorites').append(row); } }
  form('projectForm', async () => { if (await onProject($('projectRoot').value.trim())) close(); });
  bind('projectRemember', async () => { const cwd = $('projectRoot').value.trim(); if (!cwd.startsWith('/')) throw new Error('请输入绝对路径。'); const result = await api(`/api/project/files?cwd=${encodeURIComponent(cwd)}`); projects.remember(result.cwd); renderProjects(); });
  bind('projectAttach', async () => { await context().attachDirectory($('projectRoot').value.trim()); status('附加目录已加入当前消息，未扩大写权限。'); });
  bind('worktreeCreate', async () => { await loadGit(); if (!confirm(`从当前 HEAD 新建分支 ${$('worktreeBranch').value}，并写入工作树 ${$('worktreeDestination').value}？不会复制未提交修改。`)) return; await api('/api/git/action', { action: 'worktree', cwd: context().cwd, version: git.version, branch: $('worktreeBranch').value, destination: $('worktreeDestination').value, confirmed: true }); await loadGit(); status('工作树已创建，可将其路径设为主项目。'); });
  async function loadSchedules() {
    const { jobs } = await api('/api/schedules'); $('scheduleResults').replaceChildren();
    for (const job of jobs) {
      const card = node('div', null, 'native-card'); card.append(node('strong', job.text), node('p', `${job.cwd} · ${job.enabled ? `下次 ${new Date(job.nextAt).toLocaleString()}` : '已暂停'} · 每 ${job.minutes} 分钟`));
      for (const [action, label] of [['toggle', job.enabled ? '暂停' : '启用'], ['run', '立即运行一次…']]) card.append(button(label, run(async () => { if (!confirm(`${label}此只读任务？${action === 'run' ? '会消耗模型额度。' : ''}`)) return; await api('/api/schedules/action', { action, id: job.id, confirmed: true }); await loadSchedules(); })));
      for (const history of job.history) { const item = node('div'); item.append(node('span', `${new Date(history.at).toLocaleString()} · ${history.status === 'submitted' ? '已提交，结果以会话为准' : history.error}`)); if (history.threadId) item.append(button('打开运行记录', run(async () => { await onThread(history.threadId); close(); }))); card.append(item); }
      $('scheduleResults').append(card);
    }
  }
  form('scheduleForm', async () => { if (!confirm('创建并启用定时只读任务？任务内容保存在本机，执行会消耗模型额度。')) return; await api('/api/schedules/action', { action: 'create', cwd: context().cwd, text: $('scheduleText').value, minutes: Number($('scheduleMinutes').value), confirmed: true }); await loadSchedules(); });
  $('persistDrafts').addEventListener('change', run(async () => { await setDraftPreference($('persistDrafts').checked); $('persistDrafts').checked = getDraftPreference(); }));
  bind('recoverDrafts', async () => { close(); await restoreDrafts(); }); bind('clearSavedDrafts', () => { if (confirm('清除浏览器里保存的输入/编辑草稿？不会删除磁盘文件或当前编辑区内容。')) { clearDrafts(); status('已清除本机缓存。'); } });
  $('enterBehavior').addEventListener('change', () => { localStorage.setItem('codex-desk:enterBehavior', $('enterBehavior').value); $('composerHelp').textContent = $('enterBehavior').value === 'cmd' ? '⌘ / Ctrl + Enter 发送 · Enter 换行' : 'Enter 发送 · Shift + Enter 换行'; });
  bind('notifyEnable', async () => { if (!('Notification' in window)) throw new Error('浏览器不支持系统通知。'); status(`通知权限：${await Notification.requestPermission()}`); });
  bind('usageRefresh', async () => { $('usageResult').textContent = JSON.stringify(await api('/api/usage'), null, 2); });
  document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); show('search'); } });
  return { show, showHistory, previewArtifact, openFile, contextChanged, renderAgentGroup, refreshResults() { if (wantsAgents() && !agentsPromise && !agentsTimer) void pollAgents(); if (dialog.hidden) return; if (tab === 'artifacts') renderArtifacts(); if (tab === 'git') renderTurnChanges(); }, get busy() { return pendingActions > 0 || terminalConsole.pending; }, get pending() { return pendingActions + Number(terminalConsole.pending); } };
}

// A command-line presentation of the existing bounded executor, not a PTY.
// Enter is the user's explicit execution action; permissions stay server-owned.
export function createTerminalConsole({ root, api, getContext, isVisible, toolbar, before }) {
  const doc = root.ownerDocument, win = doc.defaultView, states = new Map();
  root.classList.add('terminal-console');
  root.innerHTML = '<div id="terminalScreen" class="terminal-screen" aria-label="终端"><div id="terminalResults" role="log" aria-label="命令输出"></div><p id="terminalStatus" class="terminal-status" role="status"></p><form id="terminalForm" class="terminal-prompt-line"><span id="terminalPrompt" class="terminal-prompt" aria-hidden="true"></span><textarea id="terminalCommand" aria-label="终端命令" aria-describedby="terminalKeyboardHelp" rows="1" maxlength="10000" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea></form></div><span id="terminalKeyboardHelp" class="sr-only">Enter 执行命令或发送当前进程输入，Shift + Enter 换行，上下方向键选择历史命令，Ctrl + C 中断，Ctrl + L 清屏。</span>';
  const controls = doc.createElement('div'); controls.className = 'terminal-console-controls';
  controls.innerHTML = '<select id="terminalProcess" aria-label="接收输入的运行进程" hidden></select><button id="terminalStop" type="button" class="icon-button" aria-label="中断当前命令" title="中断当前命令 · Ctrl + C" hidden>■</button><button id="terminalSettingsToggle" type="button" class="icon-button" aria-label="终端设置" title="终端设置" aria-expanded="false" aria-controls="terminalSettings">⋯</button><div id="terminalSettings" class="terminal-settings" hidden><label><input id="terminalWritable" type="checkbox">允许命令写入当前项目</label><button id="terminalClear" type="button" class="text-button">清屏 · Ctrl + L</button><p>Enter 执行 · ↑ ↓ 历史 · Ctrl + C 中断<br>每条命令从项目目录启动。默认只读、无网络，单次最多 5 分钟 / 100 KB；支持按行输入，不支持全屏交互程序。业务 SQL 请使用查询功能。</p></div>';
  if (toolbar) toolbar.insertBefore(controls, before || null); else root.prepend(controls);
  const $ = id => doc.getElementById(id), screen = $('terminalScreen'), results = $('terminalResults'), input = $('terminalCommand');
  let current = null, displayed = null, timer = null, generation = 0, disposed = false;
  const projectName = cwd => cwd?.split('/').filter(Boolean).at(-1) || '项目';
  const stateFor = cwd => {
    if (!states.has(cwd)) states.set(cwd, { cwd, processes: [], drafts: new Map(), history: [], seen: new Set(), historyIndex: null, scratch: '', active: null, hidden: new Set(), offsets: new Map(), writable: false, pending: false, error: '' });
    return states.get(cwd);
  };
  const foreground = state => state.processes.find(p => p.running && p.id === state.active) || state.processes.findLast(p => p.running);
  const inputKey = state => foreground(state) ? `stdin:${foreground(state).id}` : 'command';
  const remember = (state, command) => { if (state.history.at(-1) !== command) state.history.push(command); state.history = state.history.slice(-100); state.historyIndex = null; };
  function capture() { if (displayed) displayed.state.drafts.set(displayed.key, input.value); }
  function fitInput() { input.style.height = 'auto'; input.style.height = `${Math.max(20, Math.min(200, input.scrollHeight))}px`; }
  function prompt(cwd) {
    const el = doc.createElement('span'); el.className = 'terminal-prompt';
    const arrow = doc.createElement('span'); arrow.className = 'terminal-prompt-arrow'; arrow.textContent = '❯';
    const path = doc.createElement('span'); path.textContent = projectName(cwd); path.title = cwd;
    el.append(arrow, path); return el;
  }
  // Never interpret terminal output as HTML or leave raw ANSI escape codes in it.
  const plainOutput = text => String(text || '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  function render() {
    if (!current || disposed) return;
    const state = current, atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 48;
    const active = foreground(state), key = inputKey(state);
    for (const process of state.processes) {
      if (state.hidden.has(process.id) && !process.running) continue;
      let entry = doc.getElementById(`terminal-${process.id}`);
      if (!entry) {
        entry = doc.createElement('section'); entry.id = `terminal-${process.id}`; entry.className = 'terminal-entry';
        const line = doc.createElement('div'); line.className = 'terminal-command-line';
        const command = doc.createElement('span'); command.className = 'terminal-command-text'; command.textContent = process.command;
        line.append(prompt(state.cwd), command);
        const output = doc.createElement('pre'); output.dataset.output = 'true';
        const result = doc.createElement('span'); result.className = 'terminal-exit';
        entry.append(line, output, result); results.append(entry);
      }
      const raw = String(process.output || ''), offset = Math.min(state.offsets.get(process.id) || 0, raw.length);
      const text = plainOutput(raw.slice(offset)); const output = entry.querySelector('pre');
      if (output.textContent !== text) output.textContent = text;
      entry.querySelector('.terminal-command-line').hidden = state.hidden.has(process.id);
      const exit = entry.querySelector('.terminal-exit');
      const detail = process.error || (!process.running && process.exitCode ? `退出码 ${process.exitCode}` : '');
      const note = [detail, process.truncated ? '输出已达到上限' : ''].filter(Boolean).join(' · ');
      if (exit.textContent !== note) exit.textContent = note; exit.hidden = !note;
    }
    const ids = new Set(state.processes.filter(p => p.running || !state.hidden.has(p.id)).map(p => `terminal-${p.id}`));
    for (const entry of [...results.children]) if (!ids.has(entry.id)) entry.remove();
    if (!displayed || displayed.state !== state || displayed.key !== key) {
      capture(); input.value = state.drafts.get(key) || ''; displayed = { state, key }; fitInput();
    }
    const promptNode = $('terminalPrompt');
    if (promptNode.dataset.cwd !== state.cwd) { promptNode.replaceChildren(...prompt(state.cwd).childNodes); promptNode.dataset.cwd = state.cwd; }
    promptNode.hidden = !!active; input.setAttribute('aria-label', active ? '终端标准输入' : '终端命令');
    input.readOnly = state.pending; input.setAttribute('aria-busy', String(state.pending));
    input.title = active ? '输入内容后按 Enter 发送给当前进程 · Ctrl + C 中断' : '输入命令，按 Enter 执行 · ↑ ↓ 历史';
    $('terminalStatus').textContent = state.error || (state.pending ? '正在提交…' : '');
    $('terminalStatus').classList.toggle('is-error', !!state.error);
    $('terminalStop').hidden = !active; $('terminalStop').disabled = state.pending;
    $('terminalWritable').checked = state.writable; $('terminalWritable').disabled = state.pending;
    const running = state.processes.filter(p => p.running), picker = $('terminalProcess'); picker.hidden = running.length < 2;
    const signature = JSON.stringify(running.map(p => [p.id, p.command]));
    if (picker.dataset.signature !== signature) {
      picker.replaceChildren(...running.map(p => { const option = doc.createElement('option'); option.value = p.id; option.textContent = p.command.slice(0, 80); return option; })); picker.dataset.signature = signature;
    }
    if (active) picker.value = active.id;
    controls.hidden = !isVisible();
    if (atBottom) screen.scrollTop = screen.scrollHeight;
  }
  function syncContext() {
    const cwd = getContext().cwd || '';
    if (current?.cwd === cwd) return;
    capture(); clearTimeout(timer); generation++; current = stateFor(cwd); results.replaceChildren(); render();
    if (cwd && isVisible()) void refresh();
  }
  async function refresh() {
    clearTimeout(timer); controls.hidden = !isVisible();
    if (disposed || !isVisible() || !getContext().cwd) return;
    if (current?.cwd !== getContext().cwd) { syncContext(); return; }
    const state = current, version = ++generation;
    if (state.pending) return;
    try {
      const { processes } = await api('/api/terminal');
      if (disposed || generation !== version || state !== current || !isVisible()) return;
      capture(); state.processes = processes.filter(p => p.cwd === state.cwd);
      for (const process of state.processes) if (!state.seen.has(process.id)) { state.seen.add(process.id); remember(state, process.command); }
      render();
    } catch (error) { if (state === current && generation === version) { state.error = error.message; render(); } }
    if (!disposed && generation === version && isVisible()) timer = setTimeout(refresh, foreground(state) ? 350 : 1500);
  }
  async function submit() {
    syncContext(); const state = current, active = foreground(state), text = input.value, key = inputKey(state);
    if (!state.cwd || state.pending || !active && !text.trim()) return;
    if (!active && text.trim() === 'clear') { remember(state, text); state.drafts.set(key, ''); input.value = ''; clearScreen(); return; }
    capture(); state.pending = true; state.error = ''; generation++; clearTimeout(timer); render();
    try {
      if (active) await api('/api/terminal/action', { id: active.id, action: 'input', text });
      else {
        const { id } = await api('/api/terminal/start', { cwd: state.cwd, command: text, writable: state.writable, confirmed: true });
        state.processes.push({ id, cwd: state.cwd, command: text, output: '', running: true }); state.active = id; state.seen.add(id); remember(state, text);
      }
      state.drafts.set(key, '');
      if (displayed?.state === state && displayed.key === key && input.value === text) { input.value = ''; fitInput(); }
    } catch (error) { state.error = error.message; }
    finally { state.pending = false; if (state === current) { render(); screen.scrollTop = screen.scrollHeight; void refresh(); } }
  }
  async function interrupt() {
    if (!current || current.pending) return;
    const state = current, active = foreground(state);
    if (!active) { input.value = ''; state.drafts.set('command', ''); state.historyIndex = null; state.error = ''; fitInput(); render(); return; }
    state.pending = true; state.error = ''; generation++; clearTimeout(timer); render();
    try { await api('/api/terminal/action', { id: active.id, action: 'stop' }); }
    catch (error) { state.error = error.message; }
    finally { state.pending = false; if (state === current) { render(); void refresh(); } }
  }
  function clearScreen() {
    if (!current) return;
    for (const process of current.processes) { current.hidden.add(process.id); if (process.running) current.offsets.set(process.id, String(process.output || '').length); }
    results.replaceChildren(); render(); input.focus();
  }
  input.addEventListener('input', () => { capture(); if (current) current.historyIndex = null; fitInput(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!event.repeat) void submit(); return; }
    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'c') {
      if (win.getSelection()?.toString()) return;
      event.preventDefault(); void interrupt(); return;
    }
    if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'l') { event.preventDefault(); clearScreen(); return; }
    if (!current || foreground(current) || current.pending || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    if (event.key === 'ArrowUp' && input.value.slice(0, input.selectionStart).includes('\n') || event.key === 'ArrowDown' && input.value.slice(input.selectionEnd).includes('\n')) return;
    if (!current.history.length) return;
    event.preventDefault(); if (current.historyIndex === null) { current.scratch = input.value; current.historyIndex = current.history.length; }
    current.historyIndex = Math.max(0, Math.min(current.history.length, current.historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
    input.value = current.history[current.historyIndex] ?? current.scratch; capture(); input.setSelectionRange(input.value.length, input.value.length); fitInput();
  });
  $('terminalForm').addEventListener('submit', event => { event.preventDefault(); void submit(); });
  $('terminalStop').addEventListener('click', () => void interrupt());
  $('terminalClear').addEventListener('click', clearScreen);
  $('terminalWritable').addEventListener('change', () => { if (current) current.writable = $('terminalWritable').checked; });
  $('terminalProcess').addEventListener('change', () => { capture(); current.active = $('terminalProcess').value; render(); input.focus(); });
  const settings = $('terminalSettings'), settingsButton = $('terminalSettingsToggle');
  function closeSettings() { settings.hidden = true; settingsButton.setAttribute('aria-expanded', 'false'); }
  settingsButton.addEventListener('click', () => {
    settings.hidden = !settings.hidden; settingsButton.setAttribute('aria-expanded', String(!settings.hidden));
    if (!settings.hidden) {
      const box = popupLayout(settingsButton.getBoundingClientRect(), { width: win.innerWidth, height: win.innerHeight }, 285, settings.getBoundingClientRect().height);
      Object.assign(settings.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, maxHeight: `${box.maxHeight}px`, overflow: 'auto' });
    }
  });
  win.addEventListener('resize', closeSettings);
  doc.addEventListener('pointerdown', event => { if (!controls.contains(event.target)) closeSettings(); });
  controls.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closeSettings(); settingsButton.focus(); } });
  screen.addEventListener('click', event => { if ((event.target === screen || event.target === results) && !win.getSelection()?.toString()) input.focus(); });
  return { syncContext, refresh, hide() { generation++; clearTimeout(timer); controls.hidden = true; closeSettings(); }, get pending() { return [...states.values()].some(state => state.pending); }, dispose() { disposed = true; clearTimeout(timer); controls.remove(); } };
}
