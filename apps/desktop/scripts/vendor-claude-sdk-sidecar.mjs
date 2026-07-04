#!/usr/bin/env node
// Vendors the Claude SDK sidecar source and production dependencies into
// apps/desktop/build/claude-sdk-sidecar so packaged desktop can launch it
// without relying on repository sources.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(__dirname, "..");
const repoRoot = join(desktopDir, "..", "..");
const sidecarDir = join(repoRoot, "packages", "agent", "claude-sdk-sidecar");
const sourcePackage = JSON.parse(
  readFileSync(join(sidecarDir, "package.json"), "utf8")
);
const outDir = join(desktopDir, "build", "claude-sdk-sidecar");
const entryRelPath = join("src", "main.ts");

function log(msg) {
  process.stderr.write(`[vendor-claude-sdk-sidecar] ${msg}\n`);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(sidecarDir, "src"), join(outDir, "src"), { recursive: true });

writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify(
    {
      name: "tutti-vendored-claude-sdk-sidecar",
      private: true,
      version: sourcePackage.version,
      type: "module",
      dependencies: sourcePackage.dependencies ?? {}
    },
    null,
    2
  ) + "\n"
);

log(`installing production dependencies into ${outDir}`);
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
