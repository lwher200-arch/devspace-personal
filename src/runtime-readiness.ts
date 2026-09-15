import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, resolve } from "node:path";
import { resolveShellCommand } from "./process-platform.js";

export interface ExecutorReadiness {
  native: boolean;
  shell: boolean;
  pty: boolean;
}

function executableAvailable(command: string): boolean {
  const candidates = command.includes("/") || command.includes("\\")
    ? [command]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => resolve(directory, command));
  return candidates.some(candidate => {
    try { accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
    catch { return false; }
  });
}

/** Load the optional native binding once; readiness requests never spawn subprocesses. */
export function createExecutorReadiness(): () => ExecutorReadiness {
  let pty = false;
  try {
    const module = createRequire(import.meta.url)("node-pty") as { spawn?: unknown };
    pty = typeof module.spawn === "function";
  } catch { /* PTY is optional; native argv and pipe execution remain usable. */ }
  return () => ({
    native: executableAvailable(process.execPath),
    shell: executableAvailable(resolveShellCommand("").executable),
    pty,
  });
}
