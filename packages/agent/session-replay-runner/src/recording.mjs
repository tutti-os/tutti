import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

/**
 * Resolve a record-scenario project under replayCWD into a portable binding.
 * Products may pass `canonicalizePath` (e.g. realpath) without embedding FS
 * policy in the kernel.
 *
 * @param {{ relativePath: string, label?: string }} project
 * @param {string} replayCWD
 * @param {{ canonicalizePath?: (path: string) => string, portableReplayCWDToken?: string }} [options]
 */
export function resolveRecordScenarioProject(project, replayCWD, options = {}) {
  const canonicalize =
    typeof options.canonicalizePath === "function"
      ? options.canonicalizePath
      : (path) => resolve(String(path ?? "").trim());
  const portableReplayCWDToken =
    typeof options.portableReplayCWDToken === "string" &&
    options.portableReplayCWDToken
      ? options.portableReplayCWDToken
      : "${REPLAY_CWD}";
  const root = canonicalize(replayCWD);
  const path = canonicalize(resolve(root, project.relativePath));
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

/**
 * Verify portable project binding evidence in a recorded cassette directory.
 * File names and activity-event parsing stay product-supplied so cassette
 * policy ownership remains outside this kernel.
 *
 * @param {string} recordingDirectory
 * @param {string} portableProjectPath
 * @param {{
 *   activityEventsPath: string,
 *   checkpointPlanPath: string,
 *   expectedStatePath: string,
 *   initialStatePath: string,
 *   parseActivityEvents: (contents: string) => Array<object>
 * }} options
 */
export async function verifyRecordedProjectBindingArtifacts(
  recordingDirectory,
  portableProjectPath,
  options
) {
  const activityEventsPath = requiredOption(options, "activityEventsPath");
  const checkpointPlanPath = requiredOption(options, "checkpointPlanPath");
  const expectedStatePath = requiredOption(options, "expectedStatePath");
  const initialStatePath = requiredOption(options, "initialStatePath");
  const parseActivityEvents = options?.parseActivityEvents;
  if (typeof parseActivityEvents !== "function") {
    throw new Error("parseActivityEvents option is required");
  }

  const events = parseActivityEvents(
    await readFile(join(recordingDirectory, activityEventsPath), "utf8")
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
      [initialStatePath, expectedStatePath].map(async (name) =>
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
    await readFile(join(recordingDirectory, checkpointPlanPath), "utf8")
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
    `${String(scenarioId).toUpperCase()} rejected tool unexpectedly executed`
  );
}

/**
 * Seed a user_projects row for recording. Optional canonicalizePath mirrors
 * Tutti's realpath binding without forcing it on TSH.
 */
export async function seedRecordingUserProject(
  databasePath,
  project,
  options = {}
) {
  const canonicalize =
    typeof options.canonicalizePath === "function"
      ? options.canonicalizePath
      : (path) => path;
  const now = Date.now();
  const path = canonicalize(project.path);
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

function requiredOption(options, key) {
  const value = options?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} option is required`);
  }
  return value.trim();
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
