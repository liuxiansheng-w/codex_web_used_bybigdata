// Shared by the page and server: grant only scopes offered by this app request.
export function computerUseApproval(params) {
  const meta = params?._meta, schema = params?.requestedSchema;
  if (params?.mode !== 'form' || !['cua_repl', 'computer-use', 'node_repl'].includes(params.serverName)
    || meta?.codex_approval_kind !== 'mcp_tool_call' || meta.connector_id !== 'computer-use' || meta['openai/elicitation'] !== undefined
    || schema?.type !== 'object' || Object.keys(schema.properties || {}).length || schema.required?.length
    || typeof meta.tool_params?.app !== 'string' || !meta.tool_params.app.trim()) return null;
  const offered = Array.isArray(meta.persist) ? meta.persist : [meta.persist];
  const persistModes = ['session', 'always'].filter(mode => offered.includes(mode));
  const display = Array.isArray(meta.tool_params_display) && meta.tool_params_display.find(field => field?.name === 'app');
  return {
    appId: meta.tool_params.app,
    appName: typeof display?.value === 'string' && display.value.trim() ? display.value : meta.tool_params.app,
    persistModes,
    highRisk: meta.riskLevel === 'high',
    subtitle: typeof meta.subtitle === 'string' ? meta.subtitle : '',
  };
}
