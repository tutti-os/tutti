import { join } from "node:path";

/**
 * Artifact path for a checkpoint PNG. Optional cassetteId nests under a
 * per-cassette directory (managed multi-cassette workspaces).
 */
export function replayCheckpointScreenshotPath({
  artifactDirectory,
  cassetteId,
  checkpointIndex,
  checkpoints
}) {
  if (
    typeof artifactDirectory !== "string" ||
    artifactDirectory.trim() === ""
  ) {
    throw new Error("checkpoint screenshot artifact directory is required");
  }
  if (!Number.isSafeInteger(checkpointIndex) || checkpointIndex < 0) {
    throw new Error(
      `checkpoint screenshot index is invalid: ${checkpointIndex}`
    );
  }
  const checkpoint = Array.isArray(checkpoints)
    ? checkpoints[checkpointIndex]
    : null;
  const id =
    typeof checkpoint?.id === "string" && checkpoint.id.trim()
      ? checkpoint.id.trim()
      : `checkpoint-${String(checkpointIndex).padStart(4, "0")}`;
  const scope =
    typeof cassetteId === "string" && cassetteId.trim()
      ? cassetteId.trim()
      : "";
  return scope
    ? join(artifactDirectory, scope, `${id}.png`)
    : join(artifactDirectory, `${id}.png`);
}

export function normalizeScreenshotClip(rect) {
  if (!rect || typeof rect !== "object") return null;
  const x = Math.max(0, Math.floor(Number(rect.x)));
  const y = Math.max(0, Math.floor(Number(rect.y)));
  const width = Math.floor(Number(rect.width));
  const height = Math.floor(Number(rect.height));
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 8 ||
    height < 8
  ) {
    return null;
  }
  return { x, y, width, height, scale: 1 };
}

export function screenshotEvidenceLabel(source) {
  if (typeof source === "string") {
    return source.trim();
  }
  if (!source || typeof source !== "object") return "";
  for (const key of ["caseId", "screenshotLabel", "scenario", "label"]) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function checkpointNeedsToolSettle(checkpoint) {
  if (!checkpoint) return false;
  const kind = String(checkpoint.kind ?? "");
  const tags = Array.isArray(checkpoint.tags) ? checkpoint.tags : [];
  // Forced expanded-tool PNG capture is only meaningful once a tool has
  // completed. tool.started often has no painted body yet (I10/L06 Agent
  // tool); requiring it hard-fails replay with tool-body-not-painted.
  return [kind, ...tags].some((token) =>
    /(?:^|[.])tool\.completed$/u.test(String(token))
  );
}

export function checkpointNeedsScreenshotSettle(checkpoint) {
  if (!checkpoint) return true;
  const kind = String(checkpoint.kind ?? "");
  const tags = Array.isArray(checkpoint.tags) ? checkpoint.tags : [];
  // Match checkpointNeedsToolSettle: tool.started is often paused mid-stream
  // before Bash/command input is painted (Claude tool_started arrives with
  // {toolName} only; command lands on the next tool_updated). Hard-settling
  // there deadlocks replay — provider is frozen until settle returns.
  return [kind, ...tags].some((token) =>
    /(?:^|[.])(?:tool\.completed|turn\.terminal|turn\.completed)$/u.test(
      String(token)
    )
  );
}

export function checkpointAllowsOptionalScreenshotSettle(checkpoint) {
  if (!checkpoint) return false;
  const kind = String(checkpoint.kind ?? "");
  const tags = Array.isArray(checkpoint.tags) ? checkpoint.tags : [];
  // Queue cases soft-wait for the composer blue bar on busy-queue submits.
  // Plan-waiting settle lets scenarios switch away for rail-waiting evidence
  // (I15) without hard-blocking settlers that ignore this kind.
  // Do not fold this into checkpointNeedsScreenshotSettle: tool-evidence
  // settlers (I10/L06/R*) would hang for the full timeout when no tool chrome
  // exists yet at submission.accepted / plan.waiting.
  return [kind, ...tags].some((token) =>
    /(?:^|[.])(?:submission\.accepted|plan\.waiting)$/u.test(String(token))
  );
}

export function scenarioPreparesToolEvidence(scenario) {
  return typeof scenario?.settleForScreenshot === "function";
}
