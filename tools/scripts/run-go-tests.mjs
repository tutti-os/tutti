import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readPositiveIntegerOption,
  runValidationLanes
} from "./run-validation-lanes.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const agentDaemonModule = "packages/agent/daemon";
const agentDaemonOnly = process.argv.includes("--agent-daemon-only");
const moduleRoots = loadGoWorkspaceModuleRoots().filter(
  (moduleRoot) => !agentDaemonOnly || moduleRoot === agentDaemonModule
);

if (agentDaemonOnly && moduleRoots.length === 0) {
  console.error(`${agentDaemonModule} is not present in go.work`);
  process.exit(1);
}

const result = await runValidationLanes({
  lanes: moduleRoots.map((moduleRoot) => ({
    command: ["go", "test", "./..."],
    cwd: join(workspaceRoot, moduleRoot),
    key: moduleRoot,
    label: moduleRoot
  })),
  maxParallel: readPositiveIntegerOption("--max-parallel", 3),
  summaryLabel: agentDaemonOnly ? "agent daemon tests" : "Go workspace tests",
  tailLines: readPositiveIntegerOption("--tail-lines", 80),
  tmpDirectoryName: agentDaemonOnly
    ? "test-runs/go-agent-daemon"
    : "test-runs/go",
  workspaceRoot
});
process.exit(result.exitCode);

function loadGoWorkspaceModuleRoots() {
  const result = spawnSync("go", ["work", "edit", "-json"], {
    cwd: workspaceRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "go work edit -json failed");
  }
  const workspace = JSON.parse(result.stdout);
  return (workspace.Use ?? [])
    .map((entry) =>
      relative(workspaceRoot, join(workspaceRoot, entry.DiskPath)).replaceAll(
        "\\",
        "/"
      )
    )
    .sort();
}
