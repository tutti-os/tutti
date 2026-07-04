import { spawn } from "node:child_process";
import readline from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDirectory, "..", "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const phases = [
  {
    title: "Preflight checks",
    tasks: [
      { label: "defaults", script: "check:defaults-generated" },
      { label: "api", script: "check:api-generated" },
      { label: "event-protocol", script: "check:event-protocol-generated" },
      { label: "codexproto", script: "check:codexproto-generated" },
      { label: "tutti-names", script: "check:tutti-names" },
      { label: "i18n", script: "check:i18n" },
      {
        label: "electron-runtime-boundaries",
        script: "check:electron-runtime-boundaries"
      },
      { label: "ui-boundaries", script: "check:ui-boundaries" },
      { label: "renderer-boundaries", script: "check:renderer-boundaries" },
      {
        label: "agent-activity-runtime-boundaries",
        script: "check:agent-activity-runtime-boundaries"
      }
    ]
  },
  {
    title: "Validation checks",
    tasks: [
      { label: "lint:ts", script: "lint:ts" },
      { label: "lint:go", script: "lint:go" },
      { label: "typecheck", script: "typecheck" },
      { label: "test:ts", script: "test:ts" },
      { label: "test:go", script: "test:go" }
    ]
  }
];

let failed = false;

for (const phase of phases) {
  console.log(`\n==> ${phase.title}`);
  const results = await Promise.all(phase.tasks.map(runTask));
  const failures = results.filter((result) => result.exitCode !== 0);

  if (failures.length > 0) {
    process.stderr.write(`\n${phase.title} failed:\n`);
    for (const failure of failures) {
      process.stderr.write(
        `- ${failure.task.script} exited with code ${failure.exitCode}\n`
      );
    }
    failed = true;
    break;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("\ncheck:full passed");
}

function runTask(task) {
  console.log(`[${task.label}] starting`);

  return new Promise((resolve) => {
    const child = spawn(pnpmCommand, ["run", task.script], {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });

    pipeWithPrefix(child.stdout, task.label, process.stdout);
    pipeWithPrefix(child.stderr, task.label, process.stderr);

    child.on("error", (error) => {
      process.stderr.write(`[${task.label}] ${error.message}\n`);
      resolve({ task, exitCode: 1 });
    });

    child.on("close", (code) => {
      const exitCode = typeof code === "number" ? code : 1;
      const status = exitCode === 0 ? "passed" : "failed";
      console.log(`[${task.label}] ${status}`);
      resolve({ task, exitCode });
    });
  });
}

function pipeWithPrefix(stream, label, output) {
  const rl = readline.createInterface({ input: stream });

  rl.on("line", (line) => {
    output.write(`[${label}] ${line}\n`);
  });
}
