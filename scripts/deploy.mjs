import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredBuild = ['cli.js', 'config.js', 'user-config.js', 'server.js', 'server-shutdown.js', 'process-platform.js', 'ui/.vite/manifest.json'];

function configDirectory(value) {
  return resolve(value === '~' ? homedir() : /^~[\\/]/.test(value) ? join(homedir(), value.slice(2)) : value);
}

export function parseOptions(args, env = process.env) {
  const options = { help: false, check: false, yes: false, rebuild: false, prepareOnly: false, noStart: false,
    configDir: configDirectory(env.DEVSPACE_CONFIG_DIR ?? join(homedir(), '.devspace')) };
  const flags = { '--help': 'help', '--check': 'check', '--yes': 'yes', '--rebuild': 'rebuild', '--prepare-only': 'prepareOnly', '--no-start': 'noStart' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === '--config-dir') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--config-dir needs a directory.');
      options.configDir = configDirectory(args[++i]);
    } else if (flags[arg]) options[flags[arg]] = true;
    else throw new Error(`Unknown option: ${arg}. See docs/setup.md.`);
  }
  if (options.check && (options.rebuild || options.prepareOnly || options.noStart)) throw new Error('--check cannot be combined with deployment actions.');
  if (options.prepareOnly && options.noStart) throw new Error('Choose --prepare-only or --no-start, not both.');
  return options;
}

export function supportedNode(version, range) {
  const constraint = /^>=(\d+)\.(\d+)\s+<(\d+)$/.exec(range);
  const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!constraint || !parsed) return false;
  const [major, minor] = parsed.slice(1).map(Number);
  return major < Number(constraint[3]) && (major > Number(constraint[1]) || major === Number(constraint[1]) && minor >= Number(constraint[2]));
}

export function sourceFingerprint(root) {
  const hash = createHash('sha256');
  const visit = path => {
    const absolute = join(root, path);
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) throw new Error('Build inputs must not be symbolic links.');
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (name === 'test-support' || /\.test\.[cm]?[jt]sx?$/.test(name)) continue;
        visit(`${path}/${name}`);
      }
    } else { hash.update(path); hash.update('\0'); hash.update(readFileSync(absolute)); }
  };
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.build.json', 'vite.config.ts', 'src', 'bin', 'scripts/local-server.mjs', 'scripts/fix-node-pty-permissions.mjs']) visit(path);
  return hash.digest('hex');
}

export function configState(configDir) {
  const config = existsSync(join(configDir, 'config.jsonc'));
  const auth = existsSync(join(configDir, 'auth.json'));
  if (!config && existsSync(join(configDir, 'config.json'))) return 'legacy';
  return config && auth ? 'existing' : config || auth ? 'partial' : 'new';
}

export function buildState(root, fingerprint, node, packageManager) {
  if (!requiredBuild.every(path => existsSync(join(root, 'dist', path)))) return 'missing';
  const path = join(root, 'dist/.deploy-manifest.json');
  if (!existsSync(path)) return 'unmanaged';
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); } catch { return 'invalid'; }
  if (manifest?.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.fingerprint ?? '') ||
      typeof manifest.node !== 'string' || typeof manifest.packageManager !== 'string') return 'invalid';
  return manifest.fingerprint === fingerprint && manifest.node === node && manifest.packageManager === packageManager ? 'current' : 'stale';
}

function configurationFingerprint(configDir) {
  return ['config.jsonc', 'auth.json', 'config.json'].map(name => {
    const path = join(configDir, name);
    return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
  }).join(':');
}

export function localOrigin(config) {
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}

export async function portBusy(config) {
  const url = new URL(localOrigin(config));
  return new Promise((resolveBusy, reject) => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: config.port });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolveBusy(true); });
    socket.once('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolveBusy(false); else reject(error); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Port check timed out; refusing to replace or start a service.')); });
  });
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Command failed (${signal ?? code}): ${command}`)));
  });
}

export async function checkDependencies(root, env = process.env, buildDir = join(root, 'dist')) {
  const git = spawnSync('git', ['--version'], { env, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (git.status !== 0) throw new Error('Git is required. Install it from https://git-scm.com/ and reopen the terminal.');
  // The provider package has an import-only export. Resolve it as ESM from the
  // target checkout instead of applying CommonJS require.resolve semantics.
  const platformUrl = pathToFileURL(join(buildDir, 'process-platform.js')).href;
  const code = `import {createReadTool} from '@earendil-works/pi-coding-agent';
import {resolveShellCommand} from ${JSON.stringify(platformUrl)};
import Database from 'better-sqlite3'; import {spawnSync} from 'node:child_process';
if(typeof createReadTool!=='function')throw new Error('Required file tool API is unavailable.');
const shell=resolveShellCommand('echo DEVSPACE_SHELL_READY');const result=spawnSync(shell.executable,shell.args,{encoding:'utf8',windowsHide:true,timeout:5000});
if(result.status!==0||!result.stdout.includes('DEVSPACE_SHELL_READY'))throw new Error('The configured command shell did not execute successfully; see docs/setup.md.');
const db=new Database(':memory:');db.close();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.status !== 0) throw new Error(`Runtime dependency check failed: ${result.stderr?.trim().slice(-2000) || result.error?.message || result.status}`);
}

async function confirmPreparation() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Dependency preparation needs an interactive terminal, or explicit --yes.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(y|yes)$/i.test((await prompt.question('Install locked dependencies and prepare a local build? [y/N] ')).trim()); }
  finally { prompt.close(); }
}

export async function buildCandidate(root, packageManager, env, run = runCommand, verify = checkDependencies, beforePromote = async () => {}) {
  const fingerprint = sourceFingerprint(root);
  const runtime = join(root, '.runtime');
  if (existsSync(runtime) && lstatSync(runtime).isSymbolicLink()) throw new Error('Build staging directory must not be a link.');
  mkdirSync(runtime, { recursive: true });
  const stage = join(runtime, `deploy-stage-${randomUUID()}`);
  mkdirSync(stage);
  const result = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 10000 });
  const pnpmVersion = packageManager.slice('pnpm@'.length);
  const command = result.status === 0 && result.stdout.trim() === pnpmVersion ? (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm') : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const args = command.startsWith('pnpm') ? ['install', '--frozen-lockfile'] : ['exec', '--yes', `--package=${packageManager}`, '--', 'pnpm', 'install', '--frozen-lockfile'];
  await run(command, args, { cwd: root, env, shell: process.platform === 'win32' });
  await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', 'tsconfig.json'], { cwd: root, env });
  await run(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', join(stage, 'ui')], { cwd: root, env });
  await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', stage], { cwd: root, env });
  for (const path of requiredBuild) if (!existsSync(join(stage, path))) throw new Error(`Incomplete candidate build: ${path}`);
  await verify(root, env, stage);
  if (sourceFingerprint(root) !== fingerprint) throw new Error('Sources changed during preparation; candidate was not promoted.');
  writeFileSync(join(stage, '.deploy-manifest.json'), JSON.stringify({ version: 1, fingerprint, node: process.versions.node, packageManager }), { mode: 0o600 });
  const dist = join(root, 'dist');
  if (existsSync(dist) && lstatSync(dist).isSymbolicLink()) throw new Error('Existing dist must not be a link.');
  await beforePromote();
  if (sourceFingerprint(root) !== fingerprint) throw new Error('Sources changed before promotion; candidate was not promoted.');
  const backup = existsSync(dist) ? join(runtime, `deploy-backup-${randomUUID()}`) : undefined;
  if (backup) renameSync(dist, backup);
  try { renameSync(stage, dist); }
  catch (error) { if (backup && !existsSync(dist)) renameSync(backup, dist); throw error; }
  return { backup };
}

async function loadConfiguration(root, env) {
  // Inspect in a fresh process so a rebuilt config module is never shadowed by
  // modules cached while checking the previous build. Never return the token.
  const url = pathToFileURL(join(root, 'dist/config.js')).href;
  const code = `import { loadConfig } from ${JSON.stringify(url)}; const c=loadConfig(); console.log(JSON.stringify({host:c.host,port:c.port}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.status !== 0) throw new Error(`Configuration inspection failed: ${result.stderr?.trim() || result.error?.message || result.status}`);
  return JSON.parse(result.stdout);
}

export async function startOwnedService(root, env, config, { say = console.log, timeoutMs = 30000, signal } = {}) {
  if (signal?.aborted) throw new Error('Service start cancelled.');
  const child = spawn(process.execPath, [join(root, 'scripts/local-server.mjs')], { cwd: root, env, windowsHide: true, stdio: ['inherit', 'pipe', 'pipe', 'ipc'] });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  let exited = false;
  const completion = new Promise(resolveExit => child.once('exit', (code, exitSignal) => { exited = true; resolveExit({ code, signal: exitSignal }); }));
  let stopTimer;
  const stop = () => {
    if (exited || stopTimer) return;
    if (child.connected) child.send({ type: 'devspace.stop' }, () => {});
    stopTimer = setTimeout(() => { if (!exited) child.kill(); }, 5000);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => finish(new Error('Service readiness timed out.')), timeoutMs);
      const onExit = () => finish(new Error('Service exited before readiness.'));
      const onError = error => finish(error);
      const onMessage = message => {
        if (message?.type !== 'devspace.ready') return;
        if (message.host !== config.host || message.port !== config.port) finish(new Error('Service reported unexpected readiness identity.'));
        else finish();
      };
      const finish = error => { clearTimeout(timer); child.off('exit', onExit); child.off('error', onError); child.off('message', onMessage); error ? reject(error) : resolveReady(); };
      child.once('exit', onExit); child.once('error', onError); child.on('message', onMessage);
    });
    const response = await fetch(`${localOrigin(config)}/healthz`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    const body = await response.json();
    if (exited || !response.ok || body.ok !== true || body.name !== 'devspace') throw new Error('Local health verification failed.');
    say(`[5/5] Ready: ${localOrigin(config)}/mcp`);
    say('Keep this terminal open. Ctrl+C stops this service. Remote ChatGPT access needs your own HTTPS endpoint.');
    const result = await completion;
    if (result.code !== 0 && !stopTimer) throw new Error(`Service exited (${result.signal ?? result.code}).`);
    return { status: 'stopped' };
  } finally {
    stop();
    if (child.pid && !exited) await completion;
    clearTimeout(stopTimer);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    signal?.removeEventListener('abort', stop);
  }
}

export async function deploy(options, { root = repository, env = process.env, say = console.log,
  run = runCommand, prepare = buildCandidate, load = loadConfiguration, busy = portBusy, start = startOwnedService,
  confirm = confirmPreparation, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  root = realpathSync(root);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!supportedNode(process.versions.node, pkg.engines?.node)) throw new Error(`Node ${pkg.engines?.node} is required; see https://nodejs.org/.`);
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager)) throw new Error('Expected an exact pnpm version in package.json.');
  const effectiveEnv = { ...env, DEVSPACE_CONFIG_DIR: options.configDir };
  const state = configState(options.configDir);
  const fingerprint = sourceFingerprint(root);
  const build = buildState(root, fingerprint, process.versions.node, pkg.packageManager);
  if (options.check) {
    const report = { node: process.versions.node, packageManager: pkg.packageManager, configState: state,
      build,
      writesPerformed: false };
    say(JSON.stringify(report, null, 2)); return report;
  }
  if (state === 'legacy' || state === 'partial') throw new Error('Existing configuration is legacy or incomplete. Inspect it explicitly; deployment will not migrate or reset it.');
  if (!options.prepareOnly && state === 'new' && !interactive) throw new Error('First configuration needs an interactive terminal. --yes does not authorize project access.');
  say('[1/5] Checking environment and existing configuration.');
  let config;
  const configurationBefore = configurationFingerprint(options.configDir);
  const canInspect = existsSync(join(root, 'dist/config.js'));
  if (state === 'existing' && !canInspect) {
    throw new Error('This unbuilt checkout cannot safely inspect existing configuration. Prepare a separate checkout with --prepare-only and an unused --config-dir first.');
  }
  if (canInspect && (state === 'existing' || effectiveEnv.DEVSPACE_OAUTH_OWNER_TOKEN)) {
    config = await load(root, effectiveEnv);
    if (await busy(config)) {
      say('Configured port is in use. No installation, build, configuration update or second service was performed.');
      throw new Error('Port is occupied. Existing service was left unchanged.');
    }
  }
  const lockPath = join(root, '.devspace-deploy.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) { throw new Error(`Deployment lock unavailable. Inspect any previous deployment before retrying: ${error.code}`); }
  const identity = statSync(lockPath);
  try {
    writeFileSync(lock, String(process.pid));
    const shouldBuild = build === 'missing' || build === 'unmanaged' || options.rebuild;
    if (!shouldBuild && build !== 'current') {
      throw new Error('Build is stale for these sources/Node. Stop active services, then use --rebuild.');
    }
    if (shouldBuild) {
      if (!options.yes && !await confirm()) throw new Error('Preparation cancelled; no build was changed.');
      say('[2/5] Installing locked dependencies and preparing a candidate build.');
      const beforePromote = async () => {
        if (configurationFingerprint(options.configDir) !== configurationBefore) throw new Error('Configuration changed during preparation; candidate was not promoted.');
        if (config && await busy(await load(root, effectiveEnv))) throw new Error('Configured port became occupied; candidate was not promoted.');
        if (configurationFingerprint(options.configDir) !== configurationBefore) throw new Error('Configuration changed before promotion; candidate was not promoted.');
      };
      const result = await prepare(root, pkg.packageManager, effectiveEnv, run, checkDependencies, beforePromote);
      if (result.backup) say(`Previous build retained at ${result.backup}`);
    } else say('[2/5] Reusing the existing build; no dependency or build files changed.');
    if (options.prepareOnly) return { status: 'prepared' };
    say('[3/5] Configuring local access (existing files are preserved).');
    if (state === 'new') {
      if (configState(options.configDir) !== 'new') throw new Error('Configuration changed during preparation; inspect before retrying.');
      await run(process.execPath, [join(root, 'bin/devspace.js'), 'init', '--local'], { cwd: root, env: effectiveEnv });
    }
    if (configState(options.configDir) !== 'existing') throw new Error('Setup did not complete. No service was started.');
    config = await load(root, effectiveEnv);
    if (options.noStart) { say('Configuration ready. Run the launcher again to start.'); return { status: 'configured' }; }
    if (await busy(config)) throw new Error('Configured port is occupied. No other process was stopped.');
    say('[4/5] Starting the owned local service and verifying health.');
    return await start(root, effectiveEnv, config, { say });
  } finally {
    closeSync(lock);
    if (existsSync(lockPath)) {
      const current = lstatSync(lockPath);
      if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(lockPath);
    }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/deploy.mjs [--check | --prepare-only | --no-start] [--config-dir PATH] [--rebuild] [--yes]');
      console.log('Default: prepare once, guide local setup, verify and serve in this terminal. --yes only approves dependency preparation.');
      console.log('No system packages, global PATH, startup tasks, tunnels or model permissions are changed. See docs/setup.md.');
      return;
    }
    return deploy(options);
  }).catch(error => {
    console.error(`Deployment stopped: ${error.message}`);
    console.error('Existing configuration/credentials are not reset. See docs/setup.md for recovery.');
    process.exitCode = 1;
  });
}
