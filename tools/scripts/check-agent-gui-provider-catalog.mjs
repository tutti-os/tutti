import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "../..");
const packageJson = JSON.parse(
  readFileSync(join(workspaceRoot, "package.json"), "utf8")
);
const packageManager = String(packageJson.packageManager ?? "");
const match = /^pnpm@(.+)$/u.exec(packageManager);
if (!match) {
  throw new Error(`unsupported packageManager value: ${packageManager}`);
}

execFileSync(
  process.execPath,
  [join(scriptDirectory, "generate-agent-gui-provider-catalog.mjs"), "--check"],
  {
    cwd: workspaceRoot,
    stdio: "inherit"
  }
);

execFileSync(
  process.execPath,
  [join(scriptDirectory, "check-agent-provider-strategy-boundaries.mjs")],
  {
    cwd: workspaceRoot,
    stdio: "inherit"
  }
);

execFileSync(
  process.platform === "win32" ? "corepack.cmd" : "corepack",
  [
    `pnpm@${match[1]}`,
    "--filter",
    "@tutti-os/agent-gui",
    "exec",
    "vitest",
    "run",
    "providerIdentityCatalog.spec.ts",
    "providerIconAssets.spec.ts"
  ],
  {
    cwd: workspaceRoot,
    stdio: "inherit"
  }
);
