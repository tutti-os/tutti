import { normalizeAgentPatchText } from "./agentPatchMetadata";

const UNIFIED_DIFF_HUNK_PATTERN =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

export function isAgentUnifiedDiffText(value: string): boolean {
  const normalized = normalizeAgentPatchText(value).replace(/\r/g, "\n").trim();
  if (!normalized) {
    return false;
  }

  const lines = normalized.split("\n");
  const isApplyPatch =
    normalized.includes("*** Begin Patch") &&
    (normalized.includes("*** Add File:") ||
      normalized.includes("*** Delete File:") ||
      normalized.includes("*** Update File:"));
  let hasHunk = false;
  let hunkActive = false;
  let hunkHasCounts = false;
  let hunkHasChange = false;
  let oldCount = 0;
  let newCount = 0;
  let expectedOld = 0;
  let expectedNew = 0;

  const finishHunk = (): boolean => {
    if (!hunkActive) {
      return true;
    }
    if (!hunkHasCounts) {
      return isApplyPatch && hunkHasChange;
    }
    return (
      oldCount === expectedOld && newCount === expectedNew && hunkHasChange
    );
  };

  for (const line of lines) {
    const hunkMatch = line.match(UNIFIED_DIFF_HUNK_PATTERN);
    if (hunkMatch) {
      if (!finishHunk()) {
        return false;
      }
      hasHunk = true;
      hunkActive = true;
      hunkHasCounts = true;
      hunkHasChange = false;
      oldCount = 0;
      newCount = 0;
      expectedOld = hunkCount(hunkMatch[2]);
      expectedNew = hunkCount(hunkMatch[4]);
      continue;
    }

    if (line === "@@" && isApplyPatch) {
      if (!finishHunk()) {
        return false;
      }
      hasHunk = true;
      hunkActive = true;
      hunkHasCounts = false;
      hunkHasChange = false;
      continue;
    }

    if (hunkActive && line.startsWith("diff --git ")) {
      if (!finishHunk()) {
        return false;
      }
      hunkActive = false;
      continue;
    }

    if (
      !hunkActive &&
      (line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("similarity index ") ||
        line.startsWith("rename from ") ||
        line.startsWith("rename to ") ||
        line.startsWith("*** "))
    ) {
      continue;
    }
    if (hunkActive && isApplyPatch && line.startsWith("*** ")) {
      continue;
    }
    if (line === "\\ No newline at end of file") {
      continue;
    }
    if (!hasHunk) {
      continue;
    }

    if (!hunkHasCounts && isApplyPatch) {
      if (line.startsWith("+") || line.startsWith("-")) {
        hunkHasChange = true;
        continue;
      }
      if (line.startsWith(" ")) {
        continue;
      }
      return false;
    }

    if (line.startsWith("+")) {
      newCount += 1;
      hunkHasChange = true;
    } else if (line.startsWith("-")) {
      oldCount += 1;
      hunkHasChange = true;
    } else if (line.startsWith(" ")) {
      oldCount += 1;
      newCount += 1;
    } else {
      return false;
    }
  }

  return hasHunk && finishHunk();
}

function hunkCount(value: string | undefined): number {
  if (!value) {
    return 1;
  }
  return Number.parseInt(value, 10);
}
