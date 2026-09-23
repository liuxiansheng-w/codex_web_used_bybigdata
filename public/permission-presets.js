export const permissionPresets = [
  { id: 'workspace-write', title: '请求批准', description: '访问网络或修改工作区外文件前询问你', sandbox: 'workspace-write', approvalPolicy: 'on-request', reviewer: 'user' },
  { id: 'auto-review', title: '帮我批准', description: '由助手自动审查，保留工作区权限边界', sandbox: 'workspace-write', approvalPolicy: 'on-request', reviewer: 'auto_review' },
  { id: 'danger-full-access', title: '完全访问权限', description: '无需审批即可访问网络和电脑上的文件', sandbox: 'danger-full-access', approvalPolicy: 'never', reviewer: 'user' },
  { id: 'read-only', title: '只读模式', description: '禁止文件写入、网络访问和权限提升', sandbox: 'read-only', approvalPolicy: 'never', reviewer: 'user' },
];

export function permissionSettings(mode, cwd, plan = false) {
  const preset = permissionPresets.find(p => p.id === mode);
  if (!preset) throw Object.assign(new Error('无效的审批模式。'), { status: 400 });
  const effective = plan ? permissionPresets.find(p => p.id === 'read-only') : preset;
  const sandboxPolicy = effective.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : effective.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { sandbox: effective.sandbox, approvalPolicy: effective.approvalPolicy, approvalsReviewer: effective.reviewer, sandboxPolicy };
}
