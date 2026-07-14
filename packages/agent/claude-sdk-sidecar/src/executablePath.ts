// Resolves which claude executable the SDK should spawn.
//
// The packaged desktop bundle no longer vendors the native
// @anthropic-ai/claude-agent-sdk-<platform> package (~230MB per platform);
// tuttid provisions a binary at runtime and advertises it through
// TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE (see
// packages/agent/runtimeprep/claude.go and
// services/tuttid/service/agentstatus/claude_binary.go). Precedence:
//
//   1. CLAUDE_CODE_EXECUTABLE — explicit operator override, always wins.
//   2. SDK self-resolution — when a native package sits next to the SDK
//      (dev tree via pnpm, or a legacy bundle), let the SDK use its exact
//      pinned binary by passing no override at all.
//   3. TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE — the tuttid-provisioned binary,
//      or a PATH-installed claude as last resort.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export type ClaudeExecutableEnv = Record<string, string | undefined>;

export function resolveClaudeCodeExecutablePath(
  env: ClaudeExecutableEnv,
  sdkResolvesNativeBinary: () => boolean = nativeSdkBinaryAvailable
): string | undefined {
  const explicit = env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (explicit) {
    return explicit;
  }
  if (sdkResolvesNativeBinary()) {
    return undefined;
  }
  const fallback = env.TUTTI_CLAUDE_CODE_FALLBACK_EXECUTABLE?.trim();
  if (fallback && existsSync(fallback)) {
    return fallback;
  }
  return undefined;
}

// Mirrors the SDK's own optional-dependency resolution: it resolves the
// binary subpath (`<package>/claude`) from the SDK package's location (pnpm
// places optional dependencies in the SDK's virtual-store node_modules; the
// vendored bundle uses one flat node_modules).
export function nativeSdkBinaryAvailable(): boolean {
  let sdkEntry: string;
  try {
    sdkEntry = createRequire(import.meta.url).resolve(
      "@anthropic-ai/claude-agent-sdk"
    );
  } catch {
    return false;
  }
  const sdkRequire = createRequire(sdkEntry);
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
  for (const platformKey of nativePlatformPackageKeys()) {
    const packageName = `@anthropic-ai/claude-agent-sdk-${platformKey}`;
    try {
      const binaryPath = sdkRequire.resolve(`${packageName}/${binaryName}`);
      if (existsSync(binaryPath)) {
        return true;
      }
    } catch {
      // Package not installed under this key; try the next candidate.
    }
  }
  return false;
}

function nativePlatformPackageKeys(): string[] {
  const arch = process.arch;
  switch (process.platform) {
    case "darwin":
      return [`darwin-${arch}`];
    case "win32":
      return [`win32-${arch}`];
    case "linux":
      return [`linux-${arch}`, `linux-${arch}-musl`];
    default:
      return [];
  }
}
