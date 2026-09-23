import { CodexBridge } from '../lib/bridge.mjs';
import path from 'node:path';
const cwd = path.resolve('..');
const bridge = new CodexBridge({ cwd });
bridge.on('request', message => bridge.unsupported(message.id));
try {
  await bridge.start();
  console.log('Codex runtime:', bridge.executable);
  for (const [method, params] of [
    ['model/list', { limit: 100 }], ['collaborationMode/list', {}],
    ['skills/list', { cwds: [cwd] }], ['plugin/installed', { cwds: [cwd] }],
  ]) {
    try {
      const result = await bridge.request(method, params, 30_000);
      if (method === 'model/list') console.log(JSON.stringify({ method, data: result.data.map(m => ({ model: m.model, default: m.isDefault, efforts: m.supportedReasoningEfforts, modalities: m.inputModalities })) }));
      if (method === 'skills/list') console.log(JSON.stringify({ method, data: result.data.map(e => ({ cwd: e.cwd, skills: e.skills.map(s => ({ name: s.name, path: s.path, enabled: s.enabled })), errors: e.errors })) }));
      if (method === 'plugin/installed') console.log(JSON.stringify({ method, data: result.marketplaces.map(m => ({ name: m.name, plugins: m.plugins.map(p => ({ id: p.id, name: p.name, installed: p.installed, enabled: p.enabled, displayName: p.interface?.displayName })) })) }));
      if (method === 'collaborationMode/list') console.log(JSON.stringify({ method, result }));
    } catch (error) { console.log(JSON.stringify({ method, error: error.message })); }
  }
} finally { bridge.close(); }
