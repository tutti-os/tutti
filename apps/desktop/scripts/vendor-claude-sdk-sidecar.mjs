#!/usr/bin/env node
// Vendors the Claude SDK sidecar source and production dependencies into
// apps/desktop/build/claude-sdk-sidecar so packaged desktop can launch it
// without relying on repository sources.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DARWIN_CLAUDE_NATIVE_PACKAGES,
  resolveDarwinClaudeNativePackageSpecs,
  verifyDarwinClaudeNativePackages
} from "./claude-sdk-sidecar-packaging.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(__dirname, "..");
const repoRoot = join(desktopDir, "..", "..");
const sidecarDir = join(repoRoot, "packages", "agent", "claude-sdk-sidecar");
const sourcePackage = JSON.parse(
  readFileSync(join(sidecarDir, "package.json"), "utf8")
);
const outDir = join(desktopDir, "build", "claude-sdk-sidecar");
const entryRelPath = join("src", "main.ts");
const includeDarwinNativePackages = process.argv.includes(
  "--include-darwin-native-packages"
);

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

if (includeDarwinNativePackages) {
  const installedAgentSdkPackage = JSON.parse(
    readFileSync(
      join(
        outDir,
        "node_modules",
        "@anthropic-ai",
        "claude-agent-sdk",
        "package.json"
      ),
      "utf8"
    )
  );
  const nativePackageSpecs = resolveDarwinClaudeNativePackageSpecs(
    installedAgentSdkPackage
  );
  const stagingDir = mkdtempSync(join(tmpdir(), "tutti-claude-native-"));
  log(`vendoring macOS native packages: ${nativePackageSpecs.join(", ")}`);
  try {
    for (const [index, packageSpec] of nativePackageSpecs.entries()) {
      const packOutput = execFileSync(
        "npm",
        ["pack", packageSpec, "--json", "--pack-destination", stagingDir],
        {
          cwd: outDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"]
        }
      );
      const packResult = JSON.parse(packOutput);
      const filename = packResult[0]?.filename;
      if (typeof filename !== "string" || filename.length === 0) {
        throw new Error(
          `npm pack did not return a filename for ${packageSpec}`
        );
      }

      const packageName = DARWIN_CLAUDE_NATIVE_PACKAGES[index].name;
      const destination = join(outDir, "node_modules", packageName);
      rmSync(destination, { recursive: true, force: true });
      mkdirSync(destination, { recursive: true });
      execFileSync(
        "tar",
        [
          "-xzf",
          join(stagingDir, filename),
          "--strip-components=1",
          "-C",
          destination
        ],
        { stdio: "inherit" }
      );
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  verifyDarwinClaudeNativePackages(join(outDir, "node_modules"));
}

const entry = join(outDir, entryRelPath);
if (!existsSync(entry)) {
  log(`ERROR: expected entry not found: ${entry}`);
  process.exit(1);
}
log(`OK: vendored entry at ${entry}`);
