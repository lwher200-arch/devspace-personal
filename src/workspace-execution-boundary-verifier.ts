import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINUX_BWRAP_MACHINE_CONTROL_SOCKET_PATHS,
  linuxUserRuntimeDirectory,
  type WorkspaceExecutionBoundary,
} from "./workspace-execution-boundary.js";

const SELF_TEST_PREFIX = "DEVSPACE_BOUNDARY_SELF_TEST:";

export type WorkspaceExecutionBoundaryVerificationReason =
  | "verified"
  | "boundary_unavailable"
  | "verification_error"
  | "prepare_failed"
  | "profile_mismatch"
  | "spawn_failed"
  | "probe_failed"
  | "probe_protocol_invalid"
  | "workspace_write_failed"
  | "outside_write_allowed"
  | "protected_env_write_allowed"
  | "host_control_socket_exposed"
  | "sensitive_environment_exposed"
  | "network_isolation_failed";

export interface WorkspaceExecutionBoundaryVerification {
  verified: boolean;
  profile?: string;
  reason: WorkspaceExecutionBoundaryVerificationReason;
  checks: {
    profileMatch: boolean;
    workspaceWrite: boolean;
    outsideWriteBlocked: boolean;
    protectedEnvWriteBlocked: boolean;
    hostControlSocketsMasked: boolean;
    sensitiveEnvironmentBlocked: boolean;
    networkNoneIsolated: boolean;
  };
}

export type WorkspaceExecutionBoundaryVerifier = (
  boundary: WorkspaceExecutionBoundary | undefined,
) => WorkspaceExecutionBoundaryVerification;

export const DEFAULT_WORKSPACE_EXECUTION_BOUNDARY_VERIFICATION_TTL_MS = 30_000;

interface ProbeReport {
  workspaceWrite: boolean;
  outsideWriteAllowed: boolean;
  protectedEnvWriteAllowed: boolean;
  hostControlSockets: boolean[];
  networkNamespace: string;
}

export function verifyWorkspaceExecutionBoundary(
  boundary: WorkspaceExecutionBoundary | undefined,
  timeoutMs = 5_000,
): WorkspaceExecutionBoundaryVerification {
  const emptyChecks = {
    profileMatch: false,
    workspaceWrite: false,
    outsideWriteBlocked: false,
    protectedEnvWriteBlocked: false,
    hostControlSocketsMasked: false,
    sensitiveEnvironmentBlocked: false,
    networkNoneIsolated: false,
  };
  if (!boundary) {
    return {
      verified: false,
      reason: "boundary_unavailable",
      checks: emptyChecks,
    };
  }

  const root = mkdtempSync(join(tmpdir(), "devspace-boundary-self-test-"));
  const workspace = join(root, "workspace");
  const inside = join(workspace, "inside.txt");
  const outside = join(root, "outside.txt");
  const protectedEnv = join(workspace, ".env");
  mkdirSync(workspace);
  writeFileSync(protectedEnv, "before\n");
  const hostControlSockets = discoverHostControlSockets();
  const parentNetworkNamespace = currentNetworkNamespace();
  const filteredEnvironment = boundary.filterEnvironment?.({
    PATH: "/usr/bin",
    DEVSPACE_BOUNDARY_SELF_TEST_VISIBLE: "visible",
    DEVSPACE_BOUNDARY_SELF_TEST_TOKEN: "secret",
    SSH_AUTH_SOCK: "/tmp/devspace-self-test-agent.sock",
  });
  const sensitiveEnvironmentBlocked =
    filteredEnvironment?.PATH === "/usr/bin" &&
    filteredEnvironment.DEVSPACE_BOUNDARY_SELF_TEST_VISIBLE === "visible" &&
    filteredEnvironment.DEVSPACE_BOUNDARY_SELF_TEST_TOKEN === undefined &&
    filteredEnvironment.SSH_AUTH_SOCK === undefined;

  try {
    const code = [
      "const fs=require('node:fs');",
      `const inside=${JSON.stringify(inside)};`,
      `const outside=${JSON.stringify(outside)};`,
      `const protectedEnv=${JSON.stringify(protectedEnv)};`,
      `const sockets=${JSON.stringify(hostControlSockets)};`,
      "const result={workspaceWrite:false,outsideWriteAllowed:false,protectedEnvWriteAllowed:false,hostControlSockets:[],networkNamespace:''};",
      "try{fs.writeFileSync(inside,'inside');result.workspaceWrite=true;}catch{}",
      "try{fs.writeFileSync(outside,'outside');result.outsideWriteAllowed=true;}catch{}",
      "try{fs.writeFileSync(protectedEnv,'after');result.protectedEnvWriteAllowed=true;}catch{}",
      "result.hostControlSockets=sockets.map(path=>{try{return fs.statSync(path).isSocket();}catch{return false;}});",
      "try{result.networkNamespace=fs.readlinkSync('/proc/self/ns/net');}catch{}",
      `process.stdout.write(${JSON.stringify(SELF_TEST_PREFIX)}+JSON.stringify(result)+'\\n');`,
    ].join("");

    let prepared;
    try {
      prepared = boundary.prepare({
        workspaceRoot: workspace,
        cwd: workspace,
        executable: process.execPath,
        args: ["-e", code],
        networkProfile: "none",
      });
    } catch {
      return {
        verified: false,
        profile: boundary.profile,
        reason: "prepare_failed",
        checks: emptyChecks,
      };
    }

    const profileMatch =
      Boolean(boundary.profile) && prepared.boundaryProfile === boundary.profile;
    if (!profileMatch) {
      return {
        verified: false,
        profile: boundary.profile,
        reason: "profile_mismatch",
        checks: { ...emptyChecks, profileMatch: false },
      };
    }

    const result = spawnSync(prepared.executable, prepared.args, {
      encoding: "utf8",
      timeout: Math.max(1, timeoutMs),
      windowsHide: true,
    });
    if (result.error) {
      return {
        verified: false,
        profile: boundary.profile,
        reason: "spawn_failed",
        checks: { ...emptyChecks, profileMatch: true },
      };
    }
    if (result.status !== 0) {
      return {
        verified: false,
        profile: boundary.profile,
        reason: "probe_failed",
        checks: { ...emptyChecks, profileMatch: true },
      };
    }

    const line = result.stdout
      .split("\n")
      .find((value) => value.startsWith(SELF_TEST_PREFIX));
    if (!line) {
      return {
        verified: false,
        profile: boundary.profile,
        reason: "probe_protocol_invalid",
        checks: { ...emptyChecks, profileMatch: true },
      };
    }

    let report: ProbeReport;
    try {
      report = JSON.parse(line.slice(SELF_TEST_PREFIX.length)) as ProbeReport;
    } catch {
      return {
        verified: false,
        profile: boundary.profile,
        reason: "probe_protocol_invalid",
        checks: { ...emptyChecks, profileMatch: true },
      };
    }
    if (
      typeof report.workspaceWrite !== "boolean" ||
      typeof report.outsideWriteAllowed !== "boolean" ||
      typeof report.protectedEnvWriteAllowed !== "boolean" ||
      !Array.isArray(report.hostControlSockets) ||
      report.hostControlSockets.some((value) => typeof value !== "boolean") ||
      typeof report.networkNamespace !== "string"
    ) {
      return {
        verified: false,
        profile: boundary.profile,
        reason: "probe_protocol_invalid",
        checks: { ...emptyChecks, profileMatch: true },
      };
    }

    const checks = {
      profileMatch: true,
      workspaceWrite:
        report.workspaceWrite &&
        existsSync(inside) &&
        readFileSync(inside, "utf8") === "inside",
      outsideWriteBlocked:
        !report.outsideWriteAllowed &&
        !existsSync(outside),
      protectedEnvWriteBlocked:
        !report.protectedEnvWriteAllowed &&
        readFileSync(protectedEnv, "utf8") === "before\n",
      hostControlSocketsMasked:
        report.hostControlSockets.length === hostControlSockets.length &&
        report.hostControlSockets.every((visible) => !visible),
      sensitiveEnvironmentBlocked,
      networkNoneIsolated:
        prepared.networkProfile === "none" &&
        parentNetworkNamespace !== undefined &&
        report.networkNamespace.length > 0 &&
        report.networkNamespace !== parentNetworkNamespace,
    };
    const reason = firstFailure(checks);
    return {
      verified: reason === "verified",
      profile: boundary.profile,
      reason,
      checks,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export class WorkspaceExecutionBoundaryVerificationCache {
  private cached?: {
    checkedAt: number;
    receipt: WorkspaceExecutionBoundaryVerification;
  };

  constructor(
    private readonly boundary: WorkspaceExecutionBoundary | undefined,
    private readonly options: {
      verify?: WorkspaceExecutionBoundaryVerifier;
      now?: () => number;
      ttlMs?: number;
    } = {},
  ) {}

  current(force = false): WorkspaceExecutionBoundaryVerification {
    const now = this.options.now?.() ?? Date.now();
    const ttlMs = Math.max(
      0,
      this.options.ttlMs ?? DEFAULT_WORKSPACE_EXECUTION_BOUNDARY_VERIFICATION_TTL_MS,
    );
    if (
      !force &&
      this.cached &&
      now >= this.cached.checkedAt &&
      now - this.cached.checkedAt < ttlMs
    ) {
      return this.cached.receipt;
    }

    let receipt: WorkspaceExecutionBoundaryVerification;
    try {
      receipt = (this.options.verify ?? verifyWorkspaceExecutionBoundary)(this.boundary);
    } catch {
      receipt = {
        verified: false,
        profile: this.boundary?.profile,
        reason: "verification_error",
        checks: {
          profileMatch: false,
          workspaceWrite: false,
          outsideWriteBlocked: false,
          protectedEnvWriteBlocked: false,
          hostControlSocketsMasked: false,
          sensitiveEnvironmentBlocked: false,
          networkNoneIsolated: false,
        },
      };
    }
    this.cached = { checkedAt: now, receipt };
    return receipt;
  }
}

function firstFailure(
  checks: WorkspaceExecutionBoundaryVerification["checks"],
): WorkspaceExecutionBoundaryVerificationReason {
  if (!checks.profileMatch) return "profile_mismatch";
  if (!checks.workspaceWrite) return "workspace_write_failed";
  if (!checks.outsideWriteBlocked) return "outside_write_allowed";
  if (!checks.protectedEnvWriteBlocked) return "protected_env_write_allowed";
  if (!checks.hostControlSocketsMasked) return "host_control_socket_exposed";
  if (!checks.sensitiveEnvironmentBlocked) return "sensitive_environment_exposed";
  if (!checks.networkNoneIsolated) return "network_isolation_failed";
  return "verified";
}

function currentNetworkNamespace(): string | undefined {
  try {
    return readlinkSync("/proc/self/ns/net");
  } catch {
    return undefined;
  }
}

function discoverHostControlSockets(): string[] {
  const sockets = new Set<string>();
  for (const path of LINUX_BWRAP_MACHINE_CONTROL_SOCKET_PATHS) {
    if (isSocket(path)) sockets.add(path);
  }

  const runtimeDirectory = linuxUserRuntimeDirectory();
  if (existsSync(runtimeDirectory)) {
    for (const path of collectSockets(runtimeDirectory, 0, 3)) sockets.add(path);
  }
  return [...sockets].sort();
}

function collectSockets(directory: string, depth: number, maxDepth: number): string[] {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const sockets: string[] = [];
  for (const entry of entries.slice(0, 256)) {
    const path = join(directory, entry.name);
    try {
      if (entry.isSocket() || lstatSync(path).isSocket()) {
        sockets.push(path);
      } else if (entry.isDirectory()) {
        sockets.push(...collectSockets(path, depth + 1, maxDepth));
      }
    } catch {
      // Runtime state can disappear concurrently; absence is safe for this probe.
    }
    if (sockets.length >= 32) break;
  }
  return sockets.slice(0, 32);
}

function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}
