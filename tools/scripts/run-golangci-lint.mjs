import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGolangciLintBinary } from "./golangci-lint-tool.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const sharedConfigPath = join(
  workspaceRoot,
  "services",
  "tuttid",
  ".golangci.yml"
);
const goModuleRoots = [
  join(workspaceRoot, "packages", "agent", "activity-replication"),
  join(workspaceRoot, "packages", "agent", "host"),
  join(workspaceRoot, "packages", "agent", "store-sqlite", "canonical"),
  join(workspaceRoot, "packages", "agent", "runtimeprep"),
  join(workspaceRoot, "packages", "appcli", "core"),
  join(workspaceRoot, "packages", "device-link"),
  join(workspaceRoot, "packages", "workbench", "service"),
  join(workspaceRoot, "packages", "workspace", "files"),
  join(workspaceRoot, "services", "tuttid")
];
const args = [
  "run",
  "--config",
  sharedConfigPath,
  "./...",
  ...process.argv.slice(2)
];
const golangciLintBinary = resolveGolangciLintBinary({ cwd: workspaceRoot });

for (const moduleRoot of goModuleRoots) {
  const result = spawnSync(golangciLintBinary, args, {
    cwd: moduleRoot,
    encoding: "utf8",
    stdio: "inherit"
  });

  if (result.error?.code === "ENOENT") {
    process.stderr.write(
      "golangci-lint is required for `pnpm lint:go`.\nInstall a compatible version and rerun the command, or rely on PR CI for final verification.\n"
    );
    process.exitCode = 1;
    break;
  }
  if (typeof result.status !== "number" || result.status !== 0) {
    process.exitCode = typeof result.status === "number" ? result.status : 1;
    break;
  }
}
