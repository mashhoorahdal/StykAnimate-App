#!/usr/bin/env node
// Registers the StykAnimate MCP server with local coding agents.
//
//   node mcp/install.mjs <agent...|all> [--name stykanimate] [--output <dir>] [--dry-run] [--remove]
//
// Agents with an MCP command (Claude Code, Codex, Gemini CLI, VS Code) are configured through it; the others
// (Cursor, opencode, Windsurf, Claude Desktop) by editing their config file in place. Paths are absolute,
// including the Node executable, so apps started without your shell's PATH can still launch the server.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(process.env.STYK_APP_ROOT || path.join(here, '..'));
const home = os.homedir();
const args = process.argv.slice(2);
const option = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args.splice(i, 2)[1]; };
const flag = name => { const i = args.indexOf(name); return i >= 0 && Boolean(args.splice(i, 1)); };
const name = option('--name', 'stykanimate');
const output = path.resolve(option('--output', path.join(home, 'styk-videos')));
const dryRun = flag('--dry-run'), remove = flag('--remove');

const server = {command: process.execPath, args: [path.join(here, 'src', 'index.mjs')], env: {STYK_APP_ROOT: appRoot, STYK_OUTPUT_DIR: output}};
const envPairs = Object.entries(server.env).map(([key, value]) => `${key}=${value}`);
const has = (command, versionFlag = '--version') => spawnSync(command, [versionFlag], {stdio: 'ignore'}).status === 0;
const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : configHome);

function run(command, commandArgs, {ignoreFailure = false} = {}) {
  console.log(`  $ ${[command, ...commandArgs].map(part => /\s|"/.test(part) ? `'${part}'` : part).join(' ')}`);
  if (dryRun) return true;
  const result = spawnSync(command, commandArgs, {stdio: ignoreFailure ? 'ignore' : 'inherit'});
  if (result.status !== 0 && !ignoreFailure) throw new Error(`${command} exited with ${result.status ?? result.error?.message}`);
  return result.status === 0;
}

/** Edits a JSON config file in place, keeping everything else in it; refuses files it cannot parse. */
async function editJson(file, edit) {
  let config = {};
  if (existsSync(file)) {
    const text = await readFile(file, 'utf8');
    try { config = text.trim() ? JSON.parse(text) : {}; }
    catch { throw new Error(`${file} is not plain JSON (comments?); add the server by hand: ${JSON.stringify(server)}`); }
  }
  edit(config);
  console.log(`  ${dryRun ? 'would write' : 'writing'} ${file}`);
  if (dryRun) return;
  await mkdir(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`);
  await rename(temporary, file);
}
const setEntry = (key, value) => config => { config[key] ??= {}; if (remove) delete config[key][name]; else config[key][name] = value; };
const mcpServersEntry = setEntry('mcpServers', server);

const AGENTS = {
  claude: {label: 'Claude Code', detect: () => has('claude'), apply: () => {
    run('claude', ['mcp', 'remove', '--scope', 'user', name], {ignoreFailure: true});
    if (!remove) run('claude', ['mcp', 'add', '--scope', 'user', name, ...envPairs.flatMap(pair => ['-e', pair]), '--', server.command, ...server.args]);
  }},
  codex: {label: 'Codex CLI', detect: () => has('codex'), apply: () => {
    run('codex', ['mcp', 'remove', name], {ignoreFailure: true});
    if (!remove) run('codex', ['mcp', 'add', name, ...envPairs.flatMap(pair => ['--env', pair]), '--', server.command, ...server.args]);
  }},
  gemini: {label: 'Gemini CLI', detect: () => has('gemini') || existsSync(path.join(home, '.gemini')), apply: () =>
    has('gemini')
      ? (run('gemini', ['mcp', 'remove', '--scope', 'user', name], {ignoreFailure: true}),
        remove || run('gemini', ['mcp', 'add', '--scope', 'user', ...envPairs.flatMap(pair => ['-e', pair]), name, server.command, ...server.args]))
      : editJson(path.join(home, '.gemini', 'settings.json'), mcpServersEntry)},
  // Cursor's agent reads ~/.cursor/mcp.json; its --add-mcp flag writes VS Code-style settings instead.
  cursor: {label: 'Cursor', detect: () => has('cursor') || existsSync(path.join(home, '.cursor')), apply: () =>
    editJson(path.join(home, '.cursor', 'mcp.json'), mcpServersEntry)},
  vscode: {label: 'VS Code', detect: () => has('code'), apply: () =>
    remove
      ? editJson(path.join(appData, 'Code', 'User', 'mcp.json'), setEntry('servers', null))
      : run('code', ['--add-mcp', JSON.stringify({name, type: 'stdio', ...server})])},
  opencode: {label: 'opencode', detect: () => has('opencode') || existsSync(path.join(configHome, 'opencode')), apply: () =>
    editJson(path.join(configHome, 'opencode', 'opencode.json'), config => {
      config.$schema ??= 'https://opencode.ai/config.json';
      setEntry('mcp', {type: 'local', command: [server.command, ...server.args], environment: server.env, enabled: true})(config);
    })},
  windsurf: {label: 'Windsurf', detect: () => existsSync(path.join(home, '.codeium', 'windsurf')), apply: () =>
    editJson(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), mcpServersEntry)},
  'claude-desktop': {label: 'Claude Desktop', detect: () => existsSync(path.join(appData, 'Claude')), apply: () =>
    editJson(path.join(appData, 'Claude', 'claude_desktop_config.json'), mcpServersEntry)},
};

/** Warnings about what the server needs at run time; registration still goes ahead. */
function checkPrerequisites() {
  const missing = [];
  if (!existsSync(path.join(appRoot, 'node_modules', 'playwright'))) missing.push(`app dependencies: run "npm ci" in ${appRoot}`);
  if (!existsSync(path.join(here, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
    console.log('Installing the MCP server\'s dependencies (npm ci in mcp/)…');
    if (!dryRun && spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], {cwd: here, stdio: 'inherit'}).status !== 0)
      missing.push(`MCP dependencies: run "npm ci" in ${here}`);
  }
  const python = process.env.STYK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  if (!has(python)) missing.push('Python 3.11+ for the codec service (or set STYK_PYTHON)');
  if (!has(process.env.STYK_FFMPEG || 'ffmpeg', '-version')) missing.push('ffmpeg, only for MP4 exports with sound');
  for (const item of missing) console.log(`  ! ${item}`);
}

const detected = Object.entries(AGENTS).filter(([, agent]) => agent.detect()).map(([id]) => id);
if (!args.length) {
  console.log(`Usage: node mcp/install.mjs <agent...|all> [--name ${name}] [--output <dir>] [--dry-run] [--remove]\n`);
  for (const [id, agent] of Object.entries(AGENTS)) console.log(`  ${detected.includes(id) ? '✓' : ' '} ${id.padEnd(15)} ${agent.label}`);
  console.log('\n✓ = found on this machine. "all" means every agent found.');
  process.exit(0);
}
const chosen = args.includes('all') ? detected : args;
const unknown = chosen.filter(id => !AGENTS[id]);
if (unknown.length) { console.error(`Unknown agent: ${unknown.join(', ')}. Known: ${Object.keys(AGENTS).join(', ')}`); process.exit(1); }
if (!remove) { console.log(`Server: ${server.command} ${server.args.join(' ')}\nVideos: ${output}`); checkPrerequisites(); }

let failures = 0;
for (const id of chosen) {
  console.log(`\n${remove ? 'Removing from' : 'Adding to'} ${AGENTS[id].label}`);
  try { await AGENTS[id].apply(); }
  catch (error) { failures++; console.error(`  ✗ ${error.message}`); }
}
console.log(failures ? `\n${failures} agent(s) failed.` : `\nDone.${remove ? '' : ' Restart the agent (or start a new session) to load the tools.'}`);
process.exitCode = failures ? 1 : 0;
