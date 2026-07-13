import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Fix-scope soft gate
// (docs/architecture/agent-gui-refactor-plan.md, section 5.2 item 4).
//
// Large bug-fix pull requests are a known degradation signal: the fix that
// should be one line at the source becomes a defensive layer somewhere above
// it. This gate does not block big fixes outright; it requires the PR
// description to explicitly answer two questions once the diff exceeds the
// threshold: what is the root cause, and why can it not be fixed at a lower
// layer.

export const fixScopeChangedLineThreshold = 300;

const fixTitlePattern = /^(?:fix|hotfix|bugfix)(?:\([^)]*\))?!?:/i;

const rootCauseMarkerPattern = /root\s*cause|根因/i;
const lowerLayerMarkerPattern = /lower\s*layer|更底层|更下层/i;

export function isFixTitle(title) {
  return fixTitlePattern.test((title ?? "").trim());
}

export function sumNumstatChangedLines(numstatOutput) {
  let total = 0;
  for (const line of numstatOutput.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match) {
      continue;
    }
    if (match[1] !== "-") {
      total += Number(match[1]);
    }
    if (match[2] !== "-") {
      total += Number(match[2]);
    }
  }
  return total;
}

export function hasFixScopeJustification(body) {
  const text = body ?? "";
  return (
    rootCauseMarkerPattern.test(text) && lowerLayerMarkerPattern.test(text)
  );
}

export function evaluateFixScope({ title, body, changedLines }) {
  if (!isFixTitle(title)) {
    return { ok: true, reason: "not-a-fix" };
  }
  if (changedLines <= fixScopeChangedLineThreshold) {
    return { ok: true, reason: "within-threshold" };
  }
  if (hasFixScopeJustification(body)) {
    return { ok: true, reason: "justified" };
  }
  return { ok: false, reason: "missing-justification" };
}

function main() {
  const title = process.env.PR_TITLE ?? "";
  const body = process.env.PR_BODY ?? "";
  const baseSha = process.env.BASE_SHA ?? "";

  if (!isFixTitle(title)) {
    console.log("fix-scope gate: not a fix PR, skipping");
    return 0;
  }

  if (baseSha.length === 0) {
    console.error("fix-scope gate: BASE_SHA is required for fix PRs");
    return 1;
  }

  const numstatOutput = execFileSync(
    "git",
    ["diff", "--numstat", `${baseSha}...HEAD`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const changedLines = sumNumstatChangedLines(numstatOutput);
  const verdict = evaluateFixScope({ body, changedLines, title });

  if (verdict.ok) {
    console.log(
      `fix-scope gate passed (${changedLines} changed lines, ${verdict.reason})`
    );
    return 0;
  }

  console.error(
    `fix-scope gate failed: this fix changes ${changedLines} lines ` +
      `(threshold ${fixScopeChangedLineThreshold}).\n\n` +
      "Large fixes must justify their scope in the PR description by answering:\n" +
      "- Root cause: which event or state is the actual source of the bug?\n" +
      "- Why can this not be fixed at a lower layer?\n\n" +
      "Fill in the 'Fix Scope Justification' section of the PR template " +
      "(keep the words 'root cause' and 'lower layer' in your answers), " +
      "or shrink the fix to its source.\n" +
      "See docs/architecture/agent-gui-refactor-plan.md section 5.2."
  );
  return 1;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  process.exitCode = main();
}
