import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, readFile, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  cassettePolicy,
  parseActivityEvents,
  portableReplayCWDToken,
  resolveAgentSessionReplayProjectRoot
} from "./cassette.mjs";

export { resolveAgentSessionReplayProjectRoot };

const activityEventsName = cassettePolicy.files.activityEvents.path;
const checkpointPlanName = cassettePolicy.files.checkpointPlan.path;
const expectedStateName = cassettePolicy.files.expectedState.path;
const initialStateName = cassettePolicy.files.initialState.path;

function canonicalizeProjectPath(path) {
  const absolute = resolve(String(path ?? "").trim());
  if (!absolute) return absolute;
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function resolveRecordScenarioProject(project, replayCWD) {
  const root = canonicalizeProjectPath(replayCWD);
  const path = canonicalizeProjectPath(resolve(root, project.relativePath));
  const relativePath = relative(root, path);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error("record scenario project must be inside replay cwd");
  }
  const label = String(project.label ?? basename(path)).trim();
  if (!label) throw new Error("record scenario project label is required");
  const portableRelative = relativePath.split("\\").join("/");
  return {
    id: `replay-project-${createHash("sha256")
      .update(path)
      .digest("hex")
      .slice(0, 16)}`,
    label,
    path,
    portablePath:
      portableRelative && portableRelative !== "."
        ? `${portableReplayCWDToken}/${portableRelative}`
        : portableReplayCWDToken
  };
}

export async function seedRecordingUserProject(databasePath, project) {
  const now = Date.now();
  const path = canonicalizeProjectPath(project.path);
  await runCommand("sqlite3", [
    databasePath,
    `
INSERT INTO user_projects (
  id, path, label, created_at_unix_ms, updated_at_unix_ms,
  last_used_at_unix_ms, sort_order, pinned_at_unix_ms
) VALUES (
  '${sqlString(project.id)}',
  '${sqlString(path)}',
  '${sqlString(project.label)}',
  ${now}, ${now}, ${now}, 0, 0
)
ON CONFLICT(path) DO UPDATE SET
  label = excluded.label,
  updated_at_unix_ms = excluded.updated_at_unix_ms,
  last_used_at_unix_ms = excluded.last_used_at_unix_ms;
`
  ]);
}

export async function verifyRecordedProjectBindingArtifacts(
  recordingDirectory,
  portableProjectPath
) {
  const events = parseActivityEvents(
    await readFile(join(recordingDirectory, activityEventsName), "utf8")
  );
  const activation = events.find(
    (event) =>
      event.kind === "effect" &&
      event.type === "session/activate" &&
      event.payload?.outcome === "succeeded"
  );
  if (activation) {
    if (
      activation.payload?.railPlacement?.kind !== "project" ||
      activation.payload.railPlacement.projectPath !== portableProjectPath ||
      activation.payload.cwd !== portableProjectPath
    ) {
      throw new Error(
        "recorded project activation is missing portable project binding"
      );
    }
  } else {
    const [initialState, expectedState] = await Promise.all(
      [initialStateName, expectedStateName].map(async (name) =>
        JSON.parse(await readFile(join(recordingDirectory, name), "utf8"))
      )
    );
    const initialProjectSession = initialState?.agent?.sessions?.find(
      (session) =>
        session?.cwd === portableProjectPath &&
        session?.railProjectPath === portableProjectPath &&
        session?.railSectionKey === `project:${portableProjectPath}`
    );
    const expectedProjectSession = expectedState?.agent?.sessions?.find(
      (session) =>
        session?.id === initialProjectSession?.id &&
        session?.cwd === portableProjectPath &&
        session?.railProjectPath === portableProjectPath &&
        session?.railSectionKey === `project:${portableProjectPath}`
    );
    if (!initialProjectSession || !expectedProjectSession) {
      throw new Error(
        "recorded continue-session state did not preserve portable project binding"
      );
    }
    return;
  }
  const plan = JSON.parse(
    await readFile(join(recordingDirectory, checkpointPlanName), "utf8")
  );
  const checkpoint = plan.checkpoints?.find(
    (candidate) => candidate.kind === "project.binding-ready"
  );
  if (
    !checkpoint ||
    !checkpoint.readiness?.all?.some(
      (predicate) =>
        predicate.type === "project.binding" && predicate.equals === "recorded"
    )
  ) {
    throw new Error(
      "recorded project activation has no project.binding-ready checkpoint"
    );
  }
}

export async function assertForbiddenPathAbsent(path, scenarioId) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await rm(path, { force: true });
  throw new Error(
    `${scenarioId.toUpperCase()} rejected tool unexpectedly executed`
  );
}

function runCommand(command, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveCommand(stdout);
        return;
      }
      rejectCommand(
        new Error(
          `${command} failed (${code ?? signal ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`
        )
      );
    });
  });
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}
