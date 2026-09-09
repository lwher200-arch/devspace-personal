import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkDocumentation } from './check-documentation.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'devspace-doc-check-'));
  mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'src'));
  t.after(() => { assert.equal(dirname(realpathSync(root)), realpathSync(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('checks local links, reference definitions and encoded paths without executing examples', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'README.md'), '[guide](docs/guide.md)\n[web](https://example.com)\n[heading](#heading)\n```md\n[not-a-link](missing.md)\n```');
  writeFileSync(join(root, 'docs/guide.md'), '[source](../src/my%20file.ts)\n[ref]: <../README.md>\n');
  writeFileSync(join(root, 'src/my file.ts'), '');
  const result = checkDocumentation(root);
  assert.equal(result.documents, 2);
  assert.equal(result.localLinks, 3);
  assert.equal(result.externalLinks, 1);
  assert.equal(result.fragments, 1);
  assert.deepEqual(result.errors, []);
});

test('reports missing, escaping and malformed links', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'README.md'), '[missing](docs/no.md)\n[escape](../outside.md)\n[bad](%xx)\n[local](file:///private/path)');
  const result = checkDocumentation(root);
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.some(error => error.message === 'Link escapes the repository.'));
});

test('does not crawl linked documentation directories or silently pass oversized documents', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(root, 'docs/linked'), 'junction');
  writeFileSync(join(root, 'README.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  const result = checkDocumentation(root);
  assert.equal(result.errors.length, 2);
});

test('a missing documentation directory is reported instead of silently excluded', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'README.md'), 'Root guide');
  rmdirSync(join(root, 'docs'));
  assert.ok(checkDocumentation(root).errors.some(error => error.file === 'docs'));
});

test('includes bundled examples and skills in the public documentation inventory', t => {
  const root = fixture(t);
  mkdirSync(join(root, 'examples')); mkdirSync(join(root, 'skills'));
  writeFileSync(join(root, 'README.md'), 'Root guide');
  writeFileSync(join(root, 'docs/index.md'), 'Documentation');
  writeFileSync(join(root, 'examples/profile.md'), '[guide](../docs/index.md)');
  writeFileSync(join(root, 'skills/SKILL.md'), '[source](../src)');
  const result = checkDocumentation(root);
  assert.equal(result.documents, 4);
  assert.equal(result.localLinks, 2);
  assert.deepEqual(result.errors, []);
});
