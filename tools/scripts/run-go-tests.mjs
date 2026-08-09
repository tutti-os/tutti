import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverGoModuleRoots } from "./run-check-changed-targets.mjs";
import {
  readPositiveIntegerOption,
  runValidationLanes
} from "./run-validation-lanes.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const agentDaemonModule = "packages/agent/daemon";
const agentDaemonOnly = process.argv.includes("--agent-daemon-only");
const moduleRoots = discoverGoModuleRoots({ root: workspaceRoot }).filter(
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
