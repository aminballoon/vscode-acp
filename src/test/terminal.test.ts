import * as assert from 'assert';
import { TerminalHandler } from '../handlers/TerminalHandler';

/** Run a command to completion and return its output. */
async function run(terminals: TerminalHandler, command: string, args?: string[]): Promise<string> {
  const { terminalId } = await terminals.createTerminal({ sessionId: 's', command, args });
  await terminals.waitForTerminalExit({ sessionId: 's', terminalId });
  const { output } = await terminals.terminalOutput({ sessionId: 's', terminalId });
  await terminals.releaseTerminal({ sessionId: 's', terminalId });
  return output;
}

function isRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

suite('Agent terminals (TerminalHandler)', () => {
  const terminals = new TerminalHandler();
  suiteTeardown(() => terminals.dispose());

  test('arguments reach the command as given, spaces and shell characters included', async () => {
    const output = await run(terminals, process.execPath, ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', 'fix bug', 'a && b']);
    assert.strictEqual(output, 'fix bug|a && b');
  });

  test('a command line without arguments runs in a shell', async () => {
    const output = await run(terminals, 'echo hi && echo there');
    assert.strictEqual(output, 'hi\nthere\n');
  });

  test('multi-byte characters split across output chunks are kept', async () => {
    const script = "const b=Buffer.from('สวัสดี');(async()=>{for(const x of b){process.stdout.write(Buffer.from([x]));await new Promise(q=>setTimeout(q,2));}})()";
    const output = await run(terminals, process.execPath, ['-e', script]);
    assert.strictEqual(output, 'สวัสดี');
  });

  test('a command that cannot start reports an exit and why', async () => {
    const { terminalId } = await terminals.createTerminal({ sessionId: 's', command: 'acp-no-such-command-xyz', args: ['x'] });
    await terminals.waitForTerminalExit({ sessionId: 's', terminalId });
    const result = await terminals.terminalOutput({ sessionId: 's', terminalId });
    assert.ok(result.exitStatus, 'exit status is reported');
    assert.match(result.output, /ENOENT|not found/);
  });

  test('kill stops the processes the command started', async function () {
    if (process.platform === 'win32') { this.skip(); }
    const { terminalId } = await terminals.createTerminal({ sessionId: 's', command: 'sleep 30 & echo $!; wait' });
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) {
      await new Promise(r => setTimeout(r, 100));
      pid = Number((await terminals.terminalOutput({ sessionId: 's', terminalId })).output.trim());
    }
    assert.ok(pid > 0, 'background process started');
    await terminals.killTerminal({ sessionId: 's', terminalId });
    await terminals.waitForTerminalExit({ sessionId: 's', terminalId });
    await new Promise(r => setTimeout(r, 200));
    const alive = isRunning(pid);
    if (alive) { process.kill(pid, 'SIGKILL'); }
    assert.strictEqual(alive, false, 'background process was killed');
  });
});
