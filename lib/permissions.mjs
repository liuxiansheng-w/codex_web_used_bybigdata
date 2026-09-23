import { permissionPresets, permissionSettings } from '../public/permission-presets.js';

export class PermissionPolicy {
  constructor(bridge) { this.bridge = bridge; this.cached = null; }

  async list() {
    if (this.cached && Date.now() - this.cached.at < 30_000) return this.cached.value;
    let requirements = null, verified = true;
    try { requirements = (await this.bridge.request('configRequirements/read', {}, 10_000)).requirements; }
    catch { verified = false; }
    const options = permissionPresets.map(preset => {
      let reason = '';
      if (!verified && ['auto-review', 'danger-full-access'].includes(preset.id)) reason = '无法核验运行时权限策略，请重新连接后再试。';
      if (requirements?.allowedSandboxModes && !requirements.allowedSandboxModes.includes(preset.sandbox)) reason = '当前组织策略不允许此访问范围。';
      const profile = { 'workspace-write': ':workspace', 'read-only': ':read-only', 'danger-full-access': ':danger-full-access' }[preset.sandbox];
      if (requirements?.allowedPermissionProfiles && requirements.allowedPermissionProfiles[profile] !== true) reason = '当前组织策略不允许此权限配置。';
      if (requirements?.allowedApprovalPolicies && !requirements.allowedApprovalPolicies.includes(preset.approvalPolicy)) reason = '当前组织策略不允许此审批策略。';
      if (requirements?.allowedApprovalsReviewers && !requirements.allowedApprovalsReviewers.includes(preset.reviewer)) reason = '当前组织策略不允许此审批方式。';
      return { id: preset.id, enabled: !reason, reason };
    });
    const value = { options, verified };
    this.cached = { at: Date.now(), value };
    return value;
  }

  async resolve({ mode, cwd, plan, fullAccessConfirmed }) {
    const settings = permissionSettings(mode, cwd, plan);
    if (!plan && mode === 'danger-full-access' && fullAccessConfirmed !== true) throw Object.assign(new Error('请先阅读并确认完全访问权限的风险。'), { status: 400 });
    const permissions = await this.list();
    const option = permissions.options.find(p => p.id === (plan ? 'read-only' : mode));
    if (!option?.enabled) throw Object.assign(new Error(option?.reason || '此审批模式不可用。'), { status: 403 });
    return settings;
  }
}
