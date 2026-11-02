// Shared visibility policy for file browsing and explicitly listed results.
const roots = new Set(['祥誉-交接', 'zyhl_to_policyskilltask', '旧版工作流', '待删除', '业务流程', 'AIdata', 'openclaw']);
const names = new Set(['node_modules', '__pycache__']);
const hidden = new Set(['.git', '.hg', '.svn', '.DS_Store', '.idea', '.vscode', '.specstory', '.local', '.cache', '.codex', '.ssh', '.aws', '.azure', '.gnupg']);
export function excludedProjectPart(part, index, showHidden = false) {
  return names.has(part) || hidden.has(part) || /^\.env(?:\.|$)/i.test(part) || /^\.codex-edit-/.test(part) || (index === 0 && roots.has(part)) || (!showHidden && part.startsWith('.'));
}

// Keep path normalization independent of message rendering so the backend can
// reuse the same boundary without loading Markdown and syntax highlighters.
export function projectPath(value, cwd) {
  if (typeof value !== 'string' || !cwd) return null;
  let path = value.replace(/^(?:<)|(?:>)$/g, '').replace(/(?::\d+|#L\d+)$/, '');
  if (path.startsWith(cwd.replace(/\/$/, '') + '/')) path = path.slice(cwd.replace(/\/$/, '').length + 1);
  if (!path || path.startsWith('/') || /^[a-z][\w+.-]*:/i.test(path) || path.includes('\\') || path.split('/').some((p, i) => !p || p === '.' || p === '..' || excludedProjectPart(p, i, true) && !(i === 0 && p === 'AIdata' && /\.(xlsx|xls|xlsm)$/i.test(path)))) return null;
  return path;
}
