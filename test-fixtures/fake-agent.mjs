#!/usr/bin/env node
// Fake ACP agent for e2e tests. Mimics claude-agent-acp's edit flow:
// tool_call with empty locations -> unrelated tool completes -> update with
// locations/diff -> request_permission -> agent writes the file itself ->
// completed. The prompt names the file to edit (absolute, or relative to the
// session cwd).
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '../node_modules/@agentclientprotocol/sdk/dist/acp.js';

const delay = ms => new Promise(r => setTimeout(r, ms));

class FakeAgent {
  constructor(conn) { this.conn = conn; this.cwds = new Map(); }
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } } };
  }
  // Any session id resumes (a real agent reads its saved history from disk)
  async resumeSession(params) {
    this.cwds.set(params.sessionId, params.cwd || process.cwd());
    this.config ??= { model: 'fake-smart', effort: 'medium' };
    return { configOptions: this.configOptions() };
  }
  async newSession(params) {
    const sessionId = 'fake-' + Date.now();
    this.cwds.set(sessionId, params.cwd || process.cwd());
    this.config = { model: 'fake-smart', effort: 'medium' };
    return { sessionId, configOptions: this.configOptions() };
  }
  // Session Config Options, so the chat pickers have a model and effort to show
  configOptions() {
    return [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: this.config.model,
        options: [{ value: 'fake-fast', name: 'Fake Fast' }, { value: 'fake-smart', name: 'Fake Smart' }] },
      { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: this.config.effort,
        options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
    ];
  }
  async setSessionConfigOption(params) {
    this.config[params.configId] = params.value;
    return { configOptions: this.configOptions() };
  }
  async authenticate() { return {}; }
  async cancel() {}
  async prompt(params) {
    const sessionId = params.sessionId;
    const text = params.prompt.map(p => p.text ?? '').join(' ');
    const name = (text.match(/(\S+\.\w+)/) || [])[1];
    const path = name && nodePath.resolve(this.cwds.get(sessionId) || process.cwd(), name);
    const send = update => this.conn.sessionUpdate({ sessionId, update });
    if (!path || !fs.existsSync(path)) {
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'No path given.' } });
      return { stopReason: 'end_turn' };
    }
    const oldText = fs.readFileSync(path, 'utf8');
    const newText = oldText.includes('sleep(2)') ? oldText.replace('sleep(2)', 'sleep(10)') : oldText + '# edited\n';

    // Like an agent running `sed -i` in its terminal tool: no paths, no diff
    if (text.startsWith('shell-edit')) {
      await send({ sessionUpdate: 'tool_call', toolCallId: 's1', title: `sed -i '' 's/sleep(2)/sleep(10)/' ${name}`, kind: 'execute', status: 'in_progress' });
      fs.writeFileSync(path, newText);
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 's1', status: 'completed' });
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Edited with sed.' } });
      return { stopReason: 'end_turn' };
    }

    await send({ sessionUpdate: 'tool_call', toolCallId: 'e1', title: 'Preparing file…', kind: 'edit', status: 'pending', content: [], locations: [] });
    await send({ sessionUpdate: 'tool_call', toolCallId: 'g1', title: 'Grep sleep', kind: 'search', status: 'pending' });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'e1', title: 'Edit hello.py', locations: [{ path }],
      content: [{ type: 'diff', path, oldText: 'sleep(2)', newText: 'sleep(10)' }] });
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'g1', status: 'completed' });

    const perm = await this.conn.requestPermission({
      sessionId,
      toolCall: { toolCallId: 'e1', title: 'Edit hello.py', kind: 'edit', status: 'pending', locations: [{ path }],
        content: [{ type: 'diff', path, oldText: 'sleep(2)', newText: 'sleep(10)' }] },
      options: [
        { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'reject', name: 'No', kind: 'reject_once' },
      ],
    });
    const allowed = perm.outcome.outcome === 'selected' && perm.outcome.optionId === 'allow-once';
    if (allowed) { fs.writeFileSync(path, newText); }
    await delay(20);
    await send({ sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: allowed ? 'completed' : 'failed' });
    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'Edited the file.' : 'Edit rejected.' } });
    return { stopReason: 'end_turn' };
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection(conn => new FakeAgent(conn), stream);
