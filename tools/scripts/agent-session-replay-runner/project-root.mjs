import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const projectRootEnvironment = "TUTTI_AGENT_SESSION_REPLAY_PROJECT_ROOT";
const temporaryProjectPrefix = "tutti-agent-session-rec-";

export function resolveAgentSessionReplayProjectRoot() {
  const fromEnvironment = process.env[projectRootEnvironment]?.trim();
  if (fromEnvironment) {
    if (!isAbsolute(fromEnvironment)) {
      throw new Error(`${projectRootEnvironment} must be an absolute path`);
    }
    return resolve(fromEnvironment);
  }
  // Pure helpers may resolve portable paths before the CLI acquires its
  // run-scoped project. Keep that fallback outside the product checkout.
  return join(tmpdir(), "tutti-agent-session-rec", `unbound-${process.pid}`);
}

export async function acquireAgentSessionReplayProjectRoot({
  keepRuntime = false
} = {}) {
  const previous = process.env[projectRootEnvironment];
  if (previous?.trim()) {
    const root = resolveAgentSessionReplayProjectRoot();
    await mkdir(root, { recursive: true });
    return {
      owned: false,
      root,
      async dispose() {}
    };
  }

  const root = await mkdtemp(join(tmpdir(), temporaryProjectPrefix));
  try {
    await initializeTemporaryProject(root);
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
  process.env[projectRootEnvironment] = root;
  let disposed = false;
  return {
    owned: true,
    root,
    async dispose() {
      if (disposed) return;
      disposed = true;
      if (previous === undefined) {
        delete process.env[projectRootEnvironment];
      } else {
        process.env[projectRootEnvironment] = previous;
      }
      if (!keepRuntime) {
        await rm(root, { force: true, recursive: true });
      }
    }
  };
}

async function initializeTemporaryProject(root) {
  await runGit(root, ["init", "--quiet"]);
  await writeFile(
    join(root, "README.md"),
    [
      "# Tutti session-replay temporary project",
      "",
      "This run-scoped project is intentionally outside the product checkout.",
      ""
    ].join("\n")
  );
  await runGit(root, ["add", "README.md"]);
  await runGit(root, [
    "-c",
    "user.name=Tutti Session Replay",
    "-c",
    "user.email=session-replay@tutti.invalid",
    "commit",
    "--quiet",
    "-m",
    "chore: initialize session-replay project"
  ]);
  await access(join(root, ".git"));
}

function runGit(cwd, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `git ${args.join(" ")} failed (${code ?? signal ?? "unknown"})${
            stderr.trim() ? `: ${stderr.trim()}` : ""
          }`
        )
      );
    });
  });
}
