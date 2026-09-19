import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_APP_URI } from "./tool-surfaces/types.js";

export type RuntimeFreshness = "verified" | "mismatch" | "unverified";

export interface RuntimeBuildIdentity {
  productVersion: string;
  buildFingerprint: string | null;
  startupSourceFingerprint: string | null;
  freshness: RuntimeFreshness;
  buildNode: string | null;
  packageManager: string | null;
  uiManifestSha256: string | null;
  widgetUri: string;
}

interface IdentityOptions {
  root?: string;
  startupSourceFingerprint?: string;
}

function fingerprint(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function runtimeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function readProductVersion(root = runtimeRoot()): string {
  const pkg = readJson(resolve(root, "package.json"));
  return typeof pkg?.version === "string" ? pkg.version : "unknown";
}

function sha256(path: string): string | null {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  catch { return null; }
}

export function readRuntimeBuildIdentity(options: IdentityOptions = {}): RuntimeBuildIdentity {
  const root = options.root ?? runtimeRoot();
  const manifest = readJson(resolve(root, "dist/.deploy-manifest.json"));
  const buildFingerprint = fingerprint(manifest?.fingerprint);
  const startupSourceFingerprint = fingerprint(options.startupSourceFingerprint ?? process.env.DEVSPACE_SOURCE_FINGERPRINT);
  const freshness: RuntimeFreshness = startupSourceFingerprint
    ? buildFingerprint === startupSourceFingerprint ? "verified" : "mismatch"
    : "unverified";
  const uiManifest = resolve(root, "dist/ui/.vite/manifest.json");
  return {
    productVersion: readProductVersion(root),
    buildFingerprint,
    startupSourceFingerprint,
    freshness,
    buildNode: typeof manifest?.node === "string" ? manifest.node : null,
    packageManager: typeof manifest?.packageManager === "string" ? manifest.packageManager : null,
    uiManifestSha256: existsSync(uiManifest) ? sha256(uiManifest) : null,
    widgetUri: WORKSPACE_APP_URI,
  };
}
