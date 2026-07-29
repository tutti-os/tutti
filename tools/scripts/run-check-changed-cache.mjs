import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const laneFingerprintVersion = 1;
export const gitFingerprintMaxBuffer = 128 * 1024 * 1024;

export class LaneCacheError extends Error {}

export function resolveRetryPushReady(requestedPushReady, previousSummary) {
  return requestedPushReady || previousSummary?.pushReady === true;
}

export function buildLaneInputFingerprint(input) {
  const root = input.workspaceRoot;
  const inputFiles = Array.from(new Set(input.lane.inputFiles)).sort();
  const hash = createHash("sha256");
  const addGitOutput = (label, args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: null,
      maxBuffer: gitFingerprintMaxBuffer
    });
    if (result.status !== 0) {
      throw new Error(
        `check:changed failed to fingerprint git ${args.join(" ")}`
      );
    }
    hash.update(label);
    hash.update(result.stdout);
  };

  hash.update(`version:${laneFingerprintVersion}\n`);
  hash.update(`base-ref:${input.baseRef}\n`);
  hash.update(`key:${input.lane.key}\n`);
  hash.update(`label:${input.lane.label}\n`);
  hash.update(`command:${JSON.stringify(input.lane.command)}\n`);
  hash.update(`input-files:${JSON.stringify(inputFiles)}\n`);

  if (inputFiles.length === 0) {
    return hash.digest("hex");
  }

  const pathspec = ["--", ...inputFiles];
  addGitOutput("base-diff", [
    "diff",
    "--binary",
    `${input.baseRef}...HEAD`,
    ...pathspec
  ]);
  addGitOutput("staged-diff", [
    "diff",
    "--cached",
    "--binary",
    "HEAD",
    ...pathspec
  ]);
  addGitOutput("working-diff", ["diff", "--binary", ...pathspec]);

  const untrackedResult = spawnSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z", "--", ...inputFiles],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: gitFingerprintMaxBuffer
    }
  );
  if (untrackedResult.status !== 0) {
    throw new Error("check:changed failed to fingerprint untracked files");
  }
  for (const file of untrackedResult.stdout
    .split("\0")
    .filter(Boolean)
    .sort()) {
    hash.update(`untracked:${file}\n`);
    hash.update(readFileSync(join(root, file)));
  }

  return hash.digest("hex");
}

export function selectFailedOnlyLanes(currentLanes, summary) {
  if (summary.laneFingerprintVersion !== laneFingerprintVersion) {
    throw new LaneCacheError(
      "cannot reuse legacy failed-lane state; run pnpm check:changed"
    );
  }

  const previousByKey = new Map(
    (summary.results ?? []).map((result) => [result.key, result])
  );
  const lanesToRun = [];
  const reusedResults = [];

  for (const lane of currentLanes) {
    const previous = previousByKey.get(lane.key);
    if (
      previous?.exitCode === 0 &&
      previous.inputFingerprint === lane.inputFingerprint
    ) {
      reusedResults.push({
        ...previous,
        command: lane.command,
        inputFiles: lane.inputFiles,
        inputFingerprint: lane.inputFingerprint,
        key: lane.key,
        label: lane.label,
        reused: true
      });
    } else {
      lanesToRun.push(lane);
    }
  }

  return { lanesToRun, reusedResults };
}

export function mergeLaneResults(currentLanes, executedResults, reusedResults) {
  const executedByKey = new Map(
    executedResults.map((result) => [result.key, result])
  );
  const reusedByKey = new Map(
    reusedResults.map((result) => [result.key, result])
  );

  return currentLanes.map((lane, index) => {
    const result = executedByKey.get(lane.key) ?? reusedByKey.get(lane.key);
    if (!result) {
      throw new Error(`check:changed missing lane result for ${lane.key}`);
    }
    return {
      ...result,
      command: lane.command,
      index,
      inputFiles: lane.inputFiles,
      inputFingerprint: lane.inputFingerprint,
      key: lane.key,
      label: lane.label,
      reused: reusedByKey.has(lane.key)
    };
  });
}
