#!/usr/bin/env node
// Vendors a pinned chrome-devtools-mcp into apps/desktop/build/browser-mcp so the
// packaged app can run browser use without fetching it over the network at
// runtime. electron-builder ships build/browser-mcp via extraResources, and the
// daemon launcher (resolveBrowserMcpDaemonEnv in tuttidManager.ts) points the
// daemon at the entry script below.
//
// Keep BROWSER_MCP_VERSION in sync with browserMCPPinnedVersion in
// services/tuttid/service/agentsidecar/browseruse.go.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BROWSER_MCP_VERSION = "1.2.0";
const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(__dirname, "..");
const outDir = join(desktopDir, "build", "browser-mcp");
const entryRelPath = join(
  "node_modules",
  "chrome-devtools-mcp",
  "build",
  "src",
  "bin",
  "chrome-devtools-mcp.js"
);

function log(msg) {
  process.stderr.write(`[vendor-browser-mcp] ${msg}\n`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// A minimal package.json so `npm install` materializes a self-contained tree.
writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify(
    {
      name: "tutti-vendored-browser-mcp",
      private: true,
      version: "0.0.0",
      dependencies: { "chrome-devtools-mcp": BROWSER_MCP_VERSION }
    },
    null,
    2
  ) + "\n"
);

log(`installing chrome-devtools-mcp@${BROWSER_MCP_VERSION} into ${outDir}`);
execFileSync(
  "npm",
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"],
  { cwd: outDir, stdio: "inherit" }
);

const entry = join(outDir, entryRelPath);
if (!existsSync(entry)) {
  log(`ERROR: expected entry not found: ${entry}`);
  process.exit(1);
}
log(`OK: vendored entry at ${entry}`);
