import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('npm package excludes private deployment files even when present locally', t => {
  const root = mkdtempSync(join(tmpdir(), 'devspace-pack-contract-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  cpSync(join(repo, 'package.json'), join(root, 'package.json'));
  mkdirSync(join(root, 'scripts/windows'), { recursive: true });
  writeFileSync(join(root, 'scripts/windows/private.ps1'), 'private-fixture');
  writeFileSync(join(root, 'scripts/fix-node-pty-permissions.mjs'), '// public');
  writeFileSync(join(root, 'auth.json'), '{}');
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd: root, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
  assert.ok(files.includes('scripts/fix-node-pty-permissions.mjs'));
  assert.equal(files.some(path => path.startsWith('scripts/windows/') || path === 'auth.json'), false);
});
