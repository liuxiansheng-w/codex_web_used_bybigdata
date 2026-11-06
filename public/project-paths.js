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

// Explicit file links validate every directory, including those outside an
// added project. AIdata spreadsheets retain their read-only preview exception.
export function explicitFilePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length >= 4096 || /[\x00-\x1f\x7f\\]/.test(value)) return false;
  const parts = value.slice(1).split('/'), spreadsheet = /\.(xlsx|xls|xlsm)$/i.test(parts.at(-1));
  return parts.every((part, index) => part && part !== '.' && part !== '..' && (!excludedProjectPart(part, 0, true) || (part === 'AIdata' && index < parts.length - 1 && spreadsheet)));
}

// Resolve the clicked file only; do not add or browse its containing project.
// The original file APIs still check symlinks, type, permissions and size.
export function chatFileLink(target, { cwd, projects = [] }) {
  if (typeof target !== 'string' || !cwd) throw new Error('文件链接无效。');
  let decoded;
  try { decoded = decodeURIComponent(target); } catch { throw new Error('文件链接编码无效。'); }
  decoded = decoded.replace(/^<|>$/g, '');
  if (/[\x00-\x1f\x7f\\]/.test(decoded) || decoded.startsWith('//')) throw new Error('文件链接无效。');
  const match = decoded.match(/^(.*?)(?::(\d+)|#L(\d+))?$/), source = match[1];
  if (/^[a-z][\w+.-]*:/i.test(source)) throw new Error('文件链接无效。');
  const normalize = root => root === '/' ? root : root.replace(/\/+$/, '');
  const current = normalize(cwd), within = (root, file) => file.startsWith(root === '/' ? '/' : root + '/');
  let root = current;
  if (source.startsWith('/') && !within(current, source)) {
    if (!explicitFilePath(source)) throw new Error('文件路径无效，或属于凭据、缓存及项目排除项。');
    root = [...new Set(projects.filter(value => typeof value === 'string' && value.startsWith('/')).map(normalize))].sort((a, b) => b.length - a.length).find(value => within(value, source));
    // Start at the filesystem root so the backend checks every ancestor.
    // /tmp and /var are standard macOS aliases; the original API canonicalizes
    // these roots and checks every child without following file symlinks.
    root ||= ['/private/tmp', '/private/var', '/tmp', '/var'].find(value => within(value, source)) || '/';
  }
  const relative = source.startsWith('/') ? source.slice(root === '/' ? 1 : root.length + 1) : source.replace(/^\.\//, '');
  const path = projectPath(relative, root);
  if (!path) throw new Error('文件路径无效，或属于凭据、缓存及项目排除项。');
  const line = Number(match[2] || match[3] || 0);
  if (!Number.isSafeInteger(line) || line > 1e9) throw new Error('文件行号无效。');
  return { cwd: root, path, line, ...(root !== current ? { viewCwd: cwd } : {}) };
}
