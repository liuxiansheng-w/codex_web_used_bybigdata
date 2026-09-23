// Read-only discovery. No user turns, command execution, or full-access sessions.
import { CodexBridge } from '../lib/bridge.mjs';
import { PermissionPolicy } from '../lib/permissions.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
const bridge = new CodexBridge({ cwd: path.resolve('..') });
bridge.on('request', request => bridge.unsupported(request.id));
try {
  await bridge.start();
  const permissions = await new PermissionPolicy(bridge).list();
  console.log(JSON.stringify({ permissions }));
  if (permissions.options.find(p => p.id === 'auto-review')?.enabled) {
    // Ephemeral read-only thread: inspect negotiated reviewer without starting a turn.
    const result = await bridge.request('thread/start', { cwd: path.resolve('..'), ephemeral: true, sandbox: 'read-only', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    assert.equal(result.approvalsReviewer, 'auto_review');
    assert.equal(result.sandbox.type, 'readOnly');
    console.log(JSON.stringify({ nativeAutoReviewAccepted: true, sandbox: result.sandbox.type, turnsStarted: 0, fullAccessEnabled: false }));
  }
} finally { bridge.close(); }
