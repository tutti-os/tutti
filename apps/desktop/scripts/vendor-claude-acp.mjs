#!/usr/bin/env node
// Vendors a pinned @agentclientprotocol/claude-agent-acp into
// apps/desktop/build/claude-acp so the packaged app can run Claude Code without
// fetching the ACP bridge over the network at runtime (which fails on slow or
// blocked networks during onboarding). electron-builder ships build/claude-acp
// via extraResources, and the daemon launcher (resolveClaudeAcpDaemonEnv in
// tuttidManager.ts) points the daemon at the run entry below; the Go side
// (claude_acp_bundled.go) then runs it directly instead of installing via npm.
//
// The bridge is pre-patched here with the same codemod the daemon applies
// post-install on the registry-fallback path (fast mode + /goal forwarding +
// background task lifecycle), because the bundled path never runs the
// installer's post-step. The committed unified diff
// (services/tuttid/service/agentstatus/assets/claude-agent-acp.patch) is the
// reviewable representation of that codemod's effect; CI keeps them in lockstep
// via tools/scripts/verify-claude-acp-patch.sh.
//
// Keep CLAUDE_ACP_VERSION in sync with claudeACPPinnedVersion in
// services/tuttid/service/agentstatus/claude_acp_bundled.go and PINNED_VERSION
// in tools/scripts/verify-claude-acp-patch.sh.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLAUDE_ACP_VERSION = "0.53.0";
const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(__dirname, "..");
const repoRoot = join(desktopDir, "..", "..");
// stageDir is the extraResources `from` root (shipped to Resources/bin/claude-acp).
// We install one level BELOW it, under bridge/, because electron-builder's file
// matcher hard-excludes a `node_modules` directory that sits at the ROOT of an
// extraResources `from` dir (app-builder-lib util/filter.js: `relative ===
// "node_modules"` -> excluded) but KEEPS a nested one. Without this nesting the
// vendored dependency tree is silently stripped from the packaged app.
const stageDir = join(desktopDir, "build", "claude-acp");
const outDir = join(stageDir, "bridge");
const packageDistDir = join(
  "node_modules",
  "@agentclientprotocol",
  "claude-agent-acp",
  "dist"
);
// The package's `claude-agent-acp` bin is dist/index.js (the run entry). The
// codemod targets the bundled dist/acp-agent.js that index.js imports.
const runEntry = join(outDir, packageDistDir, "index.js");
const patchTarget = join(outDir, packageDistDir, "acp-agent.js");
const patchScript = join(
  repoRoot,
  "services",
  "tuttid",
  "service",
  "agentstatus",
  "assets",
  "patch-claude-agent-acp.mjs"
);

function log(msg) {
  process.stderr.write(`[vendor-claude-acp] ${msg}\n`);
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// A minimal package.json so `npm install` materializes a self-contained tree.
writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify(
    {
      name: "tutti-vendored-claude-acp",
      private: true,
      version: "0.0.0",
      dependencies: {
        "@agentclientprotocol/claude-agent-acp": CLAUDE_ACP_VERSION
      }
    },
    null,
    2
  ) + "\n"
);

log(
  `installing @agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_VERSION} into ${outDir}`
);
execFileSync(
  "npm",
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"],
  { cwd: outDir, stdio: "inherit" }
);

if (!existsSync(runEntry)) {
  log(`ERROR: expected run entry not found: ${runEntry}`);
  process.exit(1);
}
if (!existsSync(patchTarget)) {
  log(`ERROR: expected patch target not found: ${patchTarget}`);
  process.exit(1);
}

// Pre-apply the Tutti bridge codemod (fast mode + /goal forwarding + background
// task lifecycle). The script is idempotent and exits non-zero if the bridge
// layout drifts, which fails the build loudly rather than shipping an unpatched
// bridge.
log(`patching bridge at ${patchTarget}`);
execFileSync("node", [patchScript, "--dist", patchTarget], {
  stdio: "inherit"
});

// Prune the SDK's bundled Claude Code CLI. @anthropic-ai/claude-agent-sdk ships
// the full CLI as a ~200MB platform-specific optional dependency
// (@anthropic-ai/claude-agent-sdk-<os>-<arch>). We must not bundle it:
//   1. Only the build host's arch is installed, which breaks @electron/universal
//      packaging (it cannot merge a single-arch native binary across x64/arm64).
//   2. The daemon points the bridge at Tutti's system-managed `claude` binary
//      via CLAUDE_CODE_EXECUTABLE (see claude_acp_bundled.go), so the bundled CLI
//      is never used. The bridge's claudeCliPath() honors that env var first.
const anthropicScope = join(outDir, "node_modules", "@anthropic-ai");
if (existsSync(anthropicScope)) {
  for (const name of readdirSync(anthropicScope)) {
    if (name.startsWith("claude-agent-sdk-")) {
      rmSync(join(anthropicScope, name), { recursive: true, force: true });
      log(`pruned bundled CLI package @anthropic-ai/${name}`);
    }
  }
}

log(`OK: vendored entry at ${runEntry}`);
