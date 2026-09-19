import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type WorkspaceExecutionNetworkProfile = "inherit" | "none";

export interface WorkspaceExecutionRequest {
  workspaceRoot: string;
  cwd: string;
  executable: string;
  args: string[];
  networkProfile?: WorkspaceExecutionNetworkProfile;
}

export interface PreparedWorkspaceExecution {
  executable: string;
  args: string[];
  boundaryProfile: string;
  networkProfile?: WorkspaceExecutionNetworkProfile;
}

export interface WorkspaceExecutionBoundary {
  readonly profile: string;
  prepare(input: WorkspaceExecutionRequest): PreparedWorkspaceExecution;
  filterEnvironment?(environment: Readonly<Record<string, string>>): Record<string, string>;
}

export const LINUX_BWRAP_WORKSPACE_PROFILE =
  "linux-bwrap-workspace-rw-host-ipc-masked-env-filtered-net-profile-v4";

export const LINUX_BWRAP_MACHINE_CONTROL_SOCKET_PATHS = [
  "/run/docker.sock",
  "/run/containerd/containerd.sock",
  "/run/podman/podman.sock",
  "/run/dbus/system_bus_socket",
  "/run/systemd/private",
] as const;

export function linuxUserRuntimeDirectory(): string {
  return join("/run/user", String(userInfo().uid));
}

export function createWorkspaceExecutionBoundary(): WorkspaceExecutionBoundary | undefined {
  if (process.platform !== "linux") return undefined;
  return new BubblewrapWorkspaceExecutionBoundary();
}

export class BubblewrapWorkspaceExecutionBoundary implements WorkspaceExecutionBoundary {
  readonly profile = LINUX_BWRAP_WORKSPACE_PROFILE;

  constructor(private readonly bubblewrapExecutable = process.env.DEVSPACE_BWRAP_PATH ?? "bwrap") {}

  filterEnvironment(environment: Readonly<Record<string, string>>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(environment).filter(([name]) => !sensitiveEnvironmentName(name)),
    );
  }

  prepare(input: WorkspaceExecutionRequest): PreparedWorkspaceExecution {
    if (process.platform !== "linux") {
      throw new Error("Bubblewrap workspace execution boundary requires Linux.");
    }
    const workspaceRoot = canonicalDirectory(input.workspaceRoot, "workspace root");
    const cwd = canonicalDirectory(input.cwd, "working directory");
    if (!pathInside(workspaceRoot, cwd)) {
      throw new Error("Execution working directory is outside the workspace boundary.");
    }

    const networkProfile = input.networkProfile ?? "inherit";
    const args = [
      "--ro-bind", "/", "/",
      "--proc", "/proc",
      "--dev", "/dev",
    ];
    if (networkProfile === "none") args.push("--unshare-net");

    // A private writable /tmp keeps normal tooling functional. Tests and
    // unusual workspaces rooted under the host temp directory retain that
    // subtree instead so the workspace bind is not hidden by the tmpfs mount.
    const hostTmp = canonicalDirectory(tmpdir(), "temporary directory");
    if (!pathInside(hostTmp, workspaceRoot)) args.push("--tmpfs", "/tmp");

    // The host root is read-only. Overlay exactly one writable project root.
    args.push("--bind", workspaceRoot, workspaceRoot);

    // Read-only mounts do not neutralize Unix-domain sockets: connecting to a
    // host control socket can mutate host state without writing its inode. Hide
    // the current user's runtime directory (user-systemd/D-Bus/rootless container
    // sockets) and mask common machine-control sockets while leaving resolver
    // state under /run/systemd/resolve available for inherited networking.
    const runtimeDirectory = linuxUserRuntimeDirectory();
    if (existsSync(runtimeDirectory)) args.push("--tmpfs", runtimeDirectory);
    for (const socket of protectedHostControlSockets()) {
      if (existsSync(socket)) args.push("--ro-bind", "/dev/null", socket);
    }

    // Keep common host credential locations unreadable inside project
    // processes. These masks are deliberately narrower than the writable
    // boundary and do not grant access when a path is absent.
    for (const directory of protectedCredentialDirectories()) {
      if (existsSync(directory)) args.push("--tmpfs", directory);
    }
    for (const file of protectedCredentialFiles()) {
      if (existsSync(file)) args.push("--ro-bind", "/dev/null", file);
    }

    // Project environment files stay readable to normal tooling but cannot be
    // overwritten by native execution. Symlinks resolving outside the
    // workspace are already protected by the read-only host root.
    for (const name of [".env", ".env.local"]) {
      const candidate = join(workspaceRoot, name);
      if (!existsSync(candidate)) continue;
      const resolved = realpathSync(candidate);
      if (pathInside(workspaceRoot, resolved)) args.push("--ro-bind", resolved, resolved);
    }

    args.push(
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-ipc",
      "--new-session",
      "--die-with-parent",
      "--chdir", cwd,
      "--",
      input.executable,
      ...input.args,
    );

    return {
      executable: this.bubblewrapExecutable,
      args,
      boundaryProfile: this.profile,
      networkProfile,
    };
  }
}

function canonicalDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`Execution ${label} does not exist: ${path}`);
  return realpathSync(absolute);
}

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function protectedCredentialDirectories(): string[] {
  const home = homedir();
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".azure"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
    join(home, ".config", "gh"),
    join(home, ".config", "glab-cli"),
    join(home, ".config", "rclone"),
    join(home, ".config", "op"),
  ];
}

function protectedCredentialFiles(): string[] {
  const home = homedir();
  return [join(home, ".netrc"), join(home, ".npmrc")];
}

function protectedHostControlSockets(): string[] {
  return [...LINUX_BWRAP_MACHINE_CONTROL_SOCKET_PATHS];
}

const SENSITIVE_ENVIRONMENT_EXACT = new Set([
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "SSH_ASKPASS",
  "GIT_ASKPASS",
  "GPG_AGENT_INFO",
  "DBUS_SESSION_BUS_ADDRESS",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "CONTAINER_HOST",
  "KUBECONFIG",
  "AZURE_CONFIG_DIR",
  "CLOUDSDK_CONFIG",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "GH_CONFIG_DIR",
  "NETRC",
  "NPM_CONFIG_USERCONFIG",
  "DATABASE_URL",
  "POSTGRES_URL",
  "MYSQL_URL",
  "MONGODB_URI",
  "REDIS_URL",
]);

function sensitiveEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  if (SENSITIVE_ENVIRONMENT_EXACT.has(upper)) return true;
  return /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|AUTH_?TOKEN|BEARER)(?:$|_)/.test(upper);
}
