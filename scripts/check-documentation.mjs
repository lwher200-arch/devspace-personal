import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function within(root, path) {
  const tail = relative(root, path);
  return tail === '' || !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`);
}

/** Repository documentation only: never crawl runtime data, dependencies or linked directories. */
export function checkDocumentation(root) {
  root = realpathSync(root);
  const files = [];
  const errors = [];
  let localLinks = 0, externalLinks = 0, fragments = 0;
  function collect(directory, recursive) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (recursive || entry.name.endsWith('.md')) errors.push({ file: relative(root, path), message: 'Documentation links must not be crawled as source files.' });
      } else if (recursive && entry.isDirectory()) collect(path, true);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
    }
  }
  collect(root, false);
  for (const scope of ['docs', 'examples', 'skills']) {
    const directory = join(root, scope);
    if (scope !== 'docs' && !existsSync(directory)) continue;
    try {
      if (lstatSync(directory).isSymbolicLink()) errors.push({ file: scope, message: 'Documentation root must not be a link.' });
      else collect(directory, true);
    } catch { errors.push({ file: scope, message: 'Documentation directory is missing or unreadable.' }); }
  }
  for (const file of files) {
    const label = relative(root, file).split(sep).join('/');
    if (lstatSync(file).size > 2 * 1024 * 1024) {
      errors.push({ file: label, message: 'Documentation exceeds the 2 MiB scan limit.' }); continue;
    }
    const source = readFileSync(file, 'utf8').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]+`/g, '');
    const targets = [
      ...[...source.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^\s)\n]+)(?:\s+["'][^\n]*?["'])?\s*\)/g)].map(match => match[1]),
      ...[...source.matchAll(/^\s*\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm)].map(match => match[1]),
    ];
    for (let target of targets) {
      target = target.replace(/^<|>$/g, '');
      if (/^(?:https?:|mailto:|data:|\/\/)/i.test(target)) { externalLinks++; continue; }
      if (target.startsWith('#')) { fragments++; continue; }
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        errors.push({ file: label, message: 'Absolute/local URI in documentation link.' }); continue;
      }
      let decoded;
      try { decoded = decodeURIComponent(target.split(/[?#]/)[0]); }
      catch { errors.push({ file: label, message: 'Malformed percent encoding in link.' }); continue; }
      if (!decoded) { fragments++; continue; }
      localLinks++;
      const resolved = decoded.startsWith('/') ? resolve(root, `.${decoded}`) : resolve(dirname(file), decoded);
      if (!within(root, resolved)) {
        errors.push({ file: label, target, message: 'Link escapes the repository.' }); continue;
      }
      try {
        if (!within(root, realpathSync(resolved))) errors.push({ file: label, target, message: 'Link resolves outside the repository.' });
      } catch (error) {
        errors.push({ file: label, target, message: error.code === 'ENOENT' ? 'Missing link target.' : 'Unreadable link target.' });
      }
    }
  }
  if (files.length === 0) errors.push({ file: '.', message: 'No documentation files found.' });
  return { documents: files.length, localLinks, externalLinks, fragments, errors,
    scope: 'Root Markdown and Markdown under docs, examples and skills; local file/directory targets only. External availability, heading anchors and code examples are not evaluated.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = checkDocumentation(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.errors.length ? 1 : 0;
}
