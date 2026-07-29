import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { selectRepositoryChecks } from "./repository-checks.mjs";
import { runValidationLanes } from "./run-validation-lanes.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "../..");
const group = readOption("--group");
const base = readOption("--base");

if (!group || !base) {
  throw new Error("--group and --base are required");
}

const changedFiles = execFileSync(
  "git",
  ["diff", "--name-only", `${base}...HEAD`],
  { cwd: workspaceRoot, encoding: "utf8" }
)
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);
const checks = selectRepositoryChecks(changedFiles, { group });

if (checks.length === 0) {
  console.log(`repository checks skipped for ${group}`);
  process.exit(0);
}

const pnpmCommand = resolvePnpmCommand();
const result = await runValidationLanes({
  lanes: checks.map((check) => ({
    command: [...pnpmCommand, "run", check.script],
    key: check.key,
    label: check.label
  })),
  maxParallel: 3,
  summaryLabel: `${group} repository checks`,
  tailLines: 100,
  tmpDirectoryName: `repository-checks/${group}`,
  workspaceRoot
});
process.exit(result.exitCode);

function resolvePnpmCommand() {
  const fallback = [process.platform === "win32" ? "pnpm.cmd" : "pnpm"];
  try {
    const packageJson = JSON.parse(
      readFileSync(join(workspaceRoot, "package.json"), "utf8")
    );
    const match = /^pnpm@(.+)$/u.exec(String(packageJson.packageManager ?? ""));
    return match
      ? [
          process.platform === "win32" ? "corepack.cmd" : "corepack",
          `pnpm@${match[1]}`
        ]
      : fallback;
  } catch {
    return fallback;
  }
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
