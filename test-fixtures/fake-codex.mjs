#!/usr/bin/env node
// Fake ACP agent that replays edit turns in codex-acp's message shapes (see
// codex-scenarios.json). Like codex-acp 2.x: one `tool_call` (in_progress,
// "Editing files") carrying a diff block per hunk with `_meta.kind` and no
// locations, then a `tool_call_update` carrying only the status. Codex writes
// the files itself, without waiting for the client.
// Prompt: `codex-scenario <scenario name> <dir> <result file>`: dir holds the
// scenario files; the result file gets what the agent left in each file
// (null: deleted), so tests can check nothing overwrote it.
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '../node_modules/@agentclientprotocol/sdk/dist/acp.js';

const delay = ms => new Promise(r => setTimeout(r, ms));
const fixtures = JSON.parse(fs.readFileSync(new URL('./codex-scenarios.json', import.meta.url), 'utf8'));

function read(path) {
  try { return fs.readFileSync(path, 'utf8'); } catch { return null; }
}

/** Diff blocks (as codex-acp sends them) and resulting content of one edit. */
function applyEdit(edit, path) {
  const current = read(path);
  const block = (oldText, newText, kind) => ({ type: 'diff', path, oldText, newText, _meta: { kind } });
  switch (edit.kind) {
    case 'add': return { blocks: [block(null, edit.text, 'add')], content: edit.text };
    case 'delete': return { blocks: [block(current, '', 'delete')], content: null };
    case 'rewrite': return { blocks: [block(current, '', 'delete'), block(null, edit.text, 'add')], content: edit.text };
    default: {
      let content = '', cursor = 0;
      for (const [oldText, newText] of edit.hunks) {
        const at = current.indexOf(oldText, cursor);
        if (at < 0) { throw new Error(`hunk not found in ${path}: ${oldText}`); }
        content += current.slice(cursor, at) + newText;
        cursor = at + oldText.length;
      }
      return { blocks: edit.hunks.map(([o, n]) => block(o, n, 'update')), content: content + current.slice(cursor) };
    }
  }
}

function write(path, content) {
  if (content === null) { fs.rmSync(path, { force: true }); } else { fs.writeFileSync(path, content); }
}

class FakeCodex {
  constructor(conn) { this.conn = conn; this.calls = 0; }
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: '@agentclientprotocol/codex-acp', title: 'Codex', version: 'fake' },
      agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: true } },
    };
  }
  async newSession() { return { sessionId: 'fake-codex-' + Date.now() }; }
  async authenticate() { return {}; }
  async cancel() {}

  async prompt(params) {
    const sessionId = params.sessionId;
    const send = update => this.conn.sessionUpdate({ sessionId, update });
    const text = params.prompt.map(p => p.text ?? '').join(' ');
    const m = text.match(/^codex-scenario (.+) (\/\S+) (\/\S+)$/);
    const scenario = m && fixtures.scenarios[m[1]];
    if (!scenario) {
      await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Unknown scenario: ${text}` } });
      return { stopReason: 'end_turn' };
    }
    const result = {};
    for (const call of scenario.calls) { Object.assign(result, await this.runCall(call, m[2], sessionId, send)); }
    fs.writeFileSync(m[3], JSON.stringify(result));
    await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
    return { stopReason: 'end_turn' };
  }

  async runCall(call, dir, sessionId, send) {
    const toolCallId = `exec-fake-${++this.calls}`;
    const edits = call.edits.map(e => typeof e === 'string' ? fixtures.edits[e] : e);
    const results = edits.map(e => ({ path: nodePath.join(dir, e.file), ...applyEdit(e, nodePath.join(dir, e.file)) }));
    const writeAll = async (list, gaps = []) => {
      for (const [i, r] of list.entries()) { await delay(gaps[i] ?? 0); write(r.path, r.content); }
    };

    if (call.shell) {
      await send({ sessionUpdate: 'tool_call', toolCallId, kind: 'execute', title: `sed -i 's/.../.../' ${edits.map(e => e.file).join(' ')}`,
        status: 'in_progress', rawInput: { command: 'sed -i ...', cwd: dir } });
      await writeAll(results, call.gapsMs);
      await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
      return Object.fromEntries(results.map(r => [r.path, r.content]));
    }

    const toolCall = list => ({ sessionUpdate: 'tool_call', toolCallId, kind: 'edit', title: 'Editing files', status: 'in_progress',
      content: list.flatMap(r => r.blocks) });
    if (call.write === 'before') { await writeAll(results); }
    if (call.split) {
      // codex-acp's PatchApplyUpdated: the patch grows while it streams in
      await send(toolCall(results.slice(0, 1)));
      await writeAll(results.slice(0, 1), call.gapsMs);
      await send({ ...toolCall(results), sessionUpdate: 'tool_call_update' });
      await writeAll(results.slice(1), call.gapsMs?.slice(1));
    } else {
      await send(toolCall(results));
    }
    if (call.write === 'during' && !call.split) { await writeAll(results, call.gapsMs); }
    if (call.write === 'after') { await delay(300); await writeAll(results); }

    let status = 'completed';
    if (call.write === 'permission') {
      await send({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'active', activeFlags: ['waitingOnApproval'] } } } });
      const res = await this.conn.requestPermission({
        sessionId,
        toolCall: { toolCallId, title: 'Edit files', locations: results.map(r => ({ path: r.path })), kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
          { optionId: 'allow_for_session', name: 'Yes, and don\'t ask again for these files', kind: 'allow_always' },
          { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
        ],
      });
      await send({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type: 'active', activeFlags: [] } } } });
      const allowed = res.outcome.outcome === 'selected' && res.outcome.optionId.startsWith('allow');
      if (allowed) { await writeAll(results); } else { status = 'failed'; }
    }
    await delay(40);
    await send({ sessionUpdate: 'tool_call_update', toolCallId, status });
    return status === 'completed' ? Object.fromEntries(results.map(r => [r.path, r.content])) : {};
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new acp.AgentSideConnection(conn => new FakeCodex(conn), stream);
