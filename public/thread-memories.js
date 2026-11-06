export function createThreadMemories({ root, api, getContext }) {
  const doc = root.ownerDocument;
  const panel = doc.createElement('section'); panel.className = 'thread-memory-settings';
  panel.innerHTML = '<h3>本聊天的记忆</h3><p class="field-hint">每个聊天独立保存。全局关闭时，本聊天不能单独开启。</p><form><label>使用已有记忆<select name="use" aria-label="本聊天使用已有记忆"><option value="inherit">跟随全局</option><option value="true">允许（受全局设置限制）</option><option value="false">关闭</option></select></label><label>允许本聊天贡献记忆<select name="contribute" aria-label="本聊天贡献记忆"><option value="inherit">跟随全局</option><option value="true">允许（受全局设置限制）</option><option value="false">关闭</option></select></label><div class="inline-fields"><button type="submit" class="secondary-button">保存本聊天设置</button><button type="button" class="secondary-button" data-refresh>刷新</button></div></form><p class="field-hint" role="status"></p><p class="field-hint">修改使用开关会在下次发送前重新加载此聊天；已进入聊天上下文的记忆不会被撤回。关闭贡献不会删除已生成的记忆。</p>';
  root.prepend(panel);
  const form = panel.querySelector('form'), hint = panel.querySelector('[role=status]'), use = form.elements.use, contribute = form.elements.contribute;
  let data, generation = 0, busy = false, key = null;
  const currentId = () => getContext().thread?.id;
  const controls = () => { for (const control of form.elements) control.disabled = busy || !data || !!getContext().thread?.busy; };
  function paint(value) {
    data = value; use.value = value.use === null ? 'inherit' : String(value.use); contribute.value = value.contribute === null ? 'inherit' : String(value.contribute);
    hint.textContent = `下次加载：使用记忆${value.effective.use ? '允许' : '关闭'} · 贡献记忆${value.effective.contribute ? '允许' : '关闭'}${getContext().thread?.busy ? '。请等待当前任务结束后修改。' : ''}`; controls();
  }
  async function load() {
    const id = currentId(), at = ++generation; key = id; data = null; busy = false; controls();
    if (!id) { hint.textContent = '请先打开或发送一条聊天，再设置此聊天的记忆。'; return; }
    hint.textContent = '正在读取本聊天设置…';
    try { const result = await api(`/api/threads/${encodeURIComponent(id)}/memories`); if (at === generation && currentId() === id) paint(result); }
    catch (error) { if (at === generation && currentId() === id) hint.textContent = error.message; }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!data || busy || key !== currentId()) return;
    const id = key, at = ++generation, decode = value => value === 'inherit' ? null : value === 'true'; busy = true; controls(); hint.textContent = '正在保存…';
    try { const result = await api('/api/threads/memories', { threadId: id, revision: data.revision, use: decode(use.value), contribute: decode(contribute.value) }); if (at === generation && id === currentId()) { paint(result); hint.textContent = '已保存。' + hint.textContent; } }
    catch (error) { if (at === generation && id === currentId()) hint.textContent = error.message; }
    finally { if (at === generation) { busy = false; controls(); } }
  });
  panel.querySelector('[data-refresh]').addEventListener('click', load);
  return { load, reset() { generation++; key = null; data = null; busy = false; controls(); hint.textContent = '请刷新本聊天设置。'; } };
}
