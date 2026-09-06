import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(expandHomePath(path));
  const resolvedRoot = resolve(expandHomePath(root));
  const relationship = relative(resolvedRoot, resolvedPath);

  return (
    relationship === "" ||
    (!isAbsolute(relationship) &&
      !relationship.startsWith(`..${sep}`) &&
      relationship !== ".." &&
      !relationship.includes(`..${sep}`))
  );
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolve(expandHomePath(path));
  const matchingRoots = allowedRoots.filter((root) => isPathInsideRoot(resolvedPath, root));
  if (matchingRoots.length && matchingRoots.some((root) =>
    isPathInsideRoot(canonicalAllowedPath(resolvedPath), canonicalAllowedPath(root)))) {
    return resolvedPath;
  }

  throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}

// Resolve existing ancestors too, so a new file cannot escape through a junction.
// lstat distinguishes a genuinely missing suffix from an existing dangling link.
export function canonicalAllowedPath(path: string): string {
  let candidate = resolve(expandHomePath(path));
  const missing: string[] = [];
  while (true) {
    let entry;
    try {
      entry = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(basename(candidate));
      candidate = parent;
      continue;
    }
    const physical = realpathSync(candidate);
    if (missing.length && !entry.isDirectory() && !entry.isSymbolicLink()) {
      throw new AccessDeniedError(`Parent is not a directory: ${candidate}`);
    }
    return resolve(physical, ...missing);
  }
}

export function resolveAllowedPath(inputPath: string, cwd: string, allowedRoots: string[]): string {
  const absolutePath = resolve(cwd, inputPath);
  return assertAllowedPath(absolutePath, allowedRoots);
}
