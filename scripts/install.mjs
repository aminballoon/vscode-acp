#!/usr/bin/env node
// One-step installer for ACP Chat (macOS, Linux, Windows).
//
//   npm run setup                      build the .vsix, install it, enable proposed APIs
//   npm run setup -- --vsix <file>     install a prebuilt .vsix (skips the build)
//   npm run setup -- --insiders        target VS Code Insiders
//   npm run setup -- --uninstall       remove the extension and the argv.json entry
//
// What it does:
//   1. Builds acp-chat-<version>.vsix (unless --vsix is given)
//   2. Uninstalls the original ACP Client (formulahendry.acp-client) if present
//   3. Installs the .vsix with the `code` CLI
//   4. Adds the extension to "enable-proposed-api" in ~/.vscode/argv.json
//      (a backup is written next to it as argv.json.bak)
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXT_ID = `${pkg.publisher}.${pkg.name}`;
const OLD_EXT_ID = 'formulahendry.acp-client';
const SUPPORTED_VSCODE = '1.140.';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const insiders = flag('--insiders');
const isWin = process.platform === 'win32';

const step = msg => console.log(`\n▸ ${msg}`);
const ok = msg => console.log(`  ✓ ${msg}`);
const warn = msg => console.log(`  ! ${msg}`);
const fail = msg => { console.error(`\n✗ ${msg}`); process.exit(1); };

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', shell: isWin, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/** Locate the VS Code CLI: PATH first, then the default install locations. */
function findCodeCli() {
  const name = insiders ? 'code-insiders' : 'code';
  try { run(name, ['--version']); return name; } catch { /* not on PATH */ }
  const candidates = process.platform === 'darwin'
    ? [insiders
      ? '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code'
      : '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']
    : isWin
      ? [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', insiders ? 'Microsoft VS Code Insiders' : 'Microsoft VS Code', 'bin', `${name}.cmd`)]
      : [`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/snap/bin/${name}`];
  const found = candidates.find(c => fs.existsSync(c));
  if (!found) {
    fail(`VS Code CLI "${name}" not found. In VS Code run "Shell Command: Install 'code' command in PATH", then retry.`);
  }
  return found;
}

function argvPath() {
  if (process.env.ACP_ARGV_PATH) { return process.env.ACP_ARGV_PATH; } // for testing
  return path.join(os.homedir(), insiders ? '.vscode-insiders' : '.vscode', 'argv.json');
}

/**
 * Add or remove EXT_ID in "enable-proposed-api" of a JSONC argv.json,
 * keeping comments and the rest of the file untouched.
 * Returns the new text, or null when nothing changes.
 */
export function updateArgv(text, add) {
  const re = /"enable-proposed-api"\s*:\s*\[([^\]]*)\]/;
  const m = text.match(re);
  const ids = m ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : [];
  const has = ids.includes(EXT_ID);
  if (add === has) { return null; }

  const next = add ? [...ids, EXT_ID] : ids.filter(id => id !== EXT_ID);
  const value = `[${next.map(id => `"${id}"`).join(', ')}]`;
  if (m) {
    if (next.length) { return text.replace(re, `"enable-proposed-api": ${value}`); }
    // Last id removed: drop the whole entry. Prefer the exact block this
    // script inserts (comment + entry), so the file returns to its original text.
    const ours = /\r?\n[ \t]*\/\/ Allow proposed APIs for the ACP Chat[^\n]*\r?\n[ \t]*"enable-proposed-api"\s*:\s*\[[^\]]*\],?\r?\n/;
    if (ours.test(text)) { return text.replace(ours, ''); }
    return text.replace(/[ \t]*"enable-proposed-api"\s*:\s*\[[^\]]*\]\s*,?[ \t]*\r?\n?/, '');
  }
  const brace = text.indexOf('{');
  if (brace < 0) { return `{\n\t"enable-proposed-api": ${value}\n}\n`; }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const rest = text.slice(brace + 1);
  const hasOtherKeys = /"[^"]+"\s*:/.test(rest.replace(/\/\/[^\n]*/g, ''));
  const entry = `${nl}\t// Allow proposed APIs for the ACP Chat extension (VS Code chat participant).${nl}`
    + `\t"enable-proposed-api": ${value}${hasOtherKeys ? ',' : ''}${nl}`;
  return text.slice(0, brace + 1) + entry + rest;
}

function editArgv(add) {
  const file = argvPath();
  const exists = fs.existsSync(file);
  const before = exists ? fs.readFileSync(file, 'utf8') : '{\n}\n';
  const after = updateArgv(before, add);
  if (after === null) {
    ok(`${file} already ${add ? 'enables' : 'does not list'} ${EXT_ID}`);
    return;
  }
  if (exists) { fs.copyFileSync(file, `${file}.bak`); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  ok(`${add ? 'Enabled' : 'Removed'} proposed APIs for ${EXT_ID} in ${file}${exists ? ' (backup: argv.json.bak)' : ''}`);
}

function listExtensions(code) {
  return run(code, ['--list-extensions']).split(/\r?\n/).map(s => s.trim().toLowerCase());
}

function buildVsix() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    step('Installing npm dependencies');
    run('npm', ['install'], { stdio: 'inherit' });
  }
  step('Building the .vsix');
  const out = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);
  fs.rmSync(out, { force: true });
  run('npx', ['--yes', '@vscode/vsce', 'package', '--no-dependencies', '--out', out], { stdio: 'inherit' });
  ok(path.basename(out));
  return out;
}

function main() {
  if (flag('--help') || flag('-h')) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const uninstall = flag('--uninstall');
  console.log(`ACP Chat installer — ${uninstall ? 'uninstall' : 'install'} ${EXT_ID}`);

  step('Checking VS Code');
  const code = findCodeCli();
  const version = run(code, ['--version']).split(/\r?\n/)[0];
  ok(`VS Code ${version} (${code})`);
  if (!uninstall && !version.startsWith(SUPPORTED_VSCODE)) {
    warn(`This extension was built and tested against VS Code ${SUPPORTED_VSCODE}x.`);
    warn('It relies on proposed APIs, which may change in other versions. Continuing anyway.');
  }

  if (uninstall) {
    step('Removing the extension');
    if (listExtensions(code).includes(EXT_ID.toLowerCase())) {
      run(code, ['--uninstall-extension', EXT_ID]);
      ok(`Uninstalled ${EXT_ID}`);
    } else {
      ok(`${EXT_ID} is not installed`);
    }
    step('Updating argv.json');
    editArgv(false);
    console.log('\nDone. Restart VS Code to apply.');
    return;
  }

  const vsixArg = option('--vsix');
  const vsix = vsixArg ? path.resolve(vsixArg) : buildVsix();
  if (!fs.existsSync(vsix)) { fail(`.vsix not found: ${vsix}`); }

  step('Installing the extension');
  if (listExtensions(code).includes(OLD_EXT_ID)) {
    run(code, ['--uninstall-extension', OLD_EXT_ID]);
    ok(`Uninstalled the original ACP Client (${OLD_EXT_ID}); it registers the same commands`);
  }
  run(code, ['--install-extension', vsix, '--force']);
  ok(`Installed ${path.basename(vsix)}`);

  step('Enabling proposed APIs');
  editArgv(true);

  console.log(`
Done! Next steps:
  1. Quit VS Code completely (${process.platform === 'darwin' ? 'Cmd+Q' : 'File > Exit'}) and open it again.
     argv.json is only read at startup.
  2. Open the ACP view in the Activity Bar and connect an agent.
  3. Open Chat, start a Local chat, and type @acp <your request>.

Tip: set "update.mode": "manual" in VS Code settings so updates can't
break the proposed APIs unexpectedly.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    fail(e?.stderr?.toString() || e?.message || String(e));
  }
}
