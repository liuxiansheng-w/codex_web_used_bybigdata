// Shared visibility policy for file browsing and explicitly listed results.
const roots = new Set(['祥誉-交接', 'zyhl_to_policyskilltask', '旧版工作流', '待删除', '业务流程', 'AIdata', 'openclaw']);
const names = new Set(['node_modules', '__pycache__']);
const hidden = new Set(['.git', '.hg', '.svn', '.DS_Store', '.idea', '.vscode', '.specstory', '.local', '.cache', '.codex', '.ssh', '.aws', '.azure', '.gnupg']);
export function excludedProjectPart(part, index, showHidden = false) {
  return names.has(part) || hidden.has(part) || /^\.env(?:\.|$)/i.test(part) || /^\.codex-edit-/.test(part) || (index === 0 && roots.has(part)) || (!showHidden && part.startsWith('.'));
}
