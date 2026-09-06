import { existsSync, readFileSync } from "node:fs";
import { delimiter, resolve, sep } from "node:path";

export function removeDevspaceNodeModulesBinFromPath(pathValue: string): string {
  return pathValue
    .split(delimiter)
    .filter((entry) => entry && !isDevspaceNodeModulesBin(entry))
    .join(delimiter);
}

function isDevspaceNodeModulesBin(pathEntry: string): boolean {
  const resolvedEntry = resolve(pathEntry);
  if (!resolvedEntry.endsWith(`${sep}node_modules${sep}.bin`)) {
    return false;
  }

  const packageJson = resolve(resolvedEntry, "..", "..", "package.json");
  if (!existsSync(packageJson)) return false;

  try {
    const packageInfo = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
    return packageInfo.name === "@waishnav/devspace";
  } catch {
    return false;
  }
}

export function normalizeCommandPathEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const next = { ...env };
  if (platform !== "win32") return next;

  // Cloning process.env loses Windows' case-insensitive lookup. Match the
  // child-process environment so command discovery and execution use one PATH.
  for (const name of ["PATH", "PATHEXT"]) {
    const aliases = Object.keys(next).filter((key) => key.toUpperCase() === name).sort();
    if (!aliases.length) continue;
    const value = next[aliases[0]];
    for (const alias of aliases) delete next[alias];
    next[name] = value;
  }
  return next;
}
