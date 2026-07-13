import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const workspaceRoot = resolve(new URL("../..", import.meta.url).pathname);
const agentGuiRoot = resolve(workspaceRoot, "packages/agent/gui");
const desktopRendererRoot = resolve(
  workspaceRoot,
  "apps/desktop/src/renderer/src/features"
);

const allowedFiles = new Set([
  "packages/agent/gui/host/agentHostApi.ts",
  "packages/agent/gui/shared/roomShare.ts"
]);

const ignoredPathFragments = [
  "/app/preload/types/",
  "/dist/",
  "/host/",
  "/node_modules/",
  "/shared/contracts/dto/"
];

const ignoredFilenamePatterns = [
  /\.spec\.[cm]?[tj]sx?$/,
  /\.test\.[cm]?[tj]sx?$/,
  /vitest\./
];

const forbiddenPatterns = [
  {
    label: "workspaceAgents.*",
    pattern: /\bworkspaceAgents\s*(?:\?\.)?\s*\.\s*[A-Za-z_$][\w$]*/g
  },
  {
    label: "legacy compat host helper",
    pattern:
      /\b(?:listWorkspaceAgentsViaCompatHost|listWorkspaceAgentSessionMessagesViaCompatHost|retainAgentSessionEventsViaCompatHost|releaseAgentSessionEventsViaCompatHost|subscribeAgentSessionEventsViaCompatHost)\b/g
  },
  {
    label: "agentSessions legacy write API",
    pattern:
      /\bagentSessions\s*(?:\?\.)?\s*\.\s*(?:exec|cancel|submitInteractive|pinSession)\b/g
  },
  {
    label: "agentSessions.retainEventStream",
    pattern: /agentSessions\s*(?:\?\.)?\s*\.\s*retainEventStream\b/g
  },
  {
    label: "agentSessions.subscribeEvents",
    pattern: /agentSessions\s*(?:\?\.)?\s*\.\s*subscribeEvents\b/g
  },
  {
    label: "AgentHostWorkspaceAgent*",
    pattern: /\bAgentHostWorkspaceAgent[A-Za-z0-9_]*/g
  },
  {
    label: "legacy workspaceAgentActivityTypes aggregate",
    pattern: /\bworkspaceAgentActivityTypes\b/g
  },
  {
    label: "legacy WorkspaceAgentActivity session mirror",
    pattern: /\bWorkspaceAgentActivity(?:Session|Snapshot|Presence)\b/g
  },
  {
    label: "module-global AgentActivityRuntime resolver",
    pattern:
      /\b(?:getAgentActivityRuntime|getAgentActivityRuntimeByOrigin|getOptionalAgentActivityRuntime)\b/g
  },
  {
    allowedFiles: new Set([
      "apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityDiagnostics.ts"
    ]),
    label: "deprecated session lifecycle decision read",
    pattern:
      /\b[A-Za-z_$][\w$]*\s*(?:\?\.)?\s*\.\s*(?:currentPhase|effectiveStatus|lifecycleStatus|pendingInteractive|submitAvailability|turnLifecycle|turnPhase)\b/g
  },
  {
    label: "direct AgentSessionEngine entity storage access",
    pattern:
      /\b(?:sessionLifecycle\s*\.\s*(?:sessionsById|turnsById|interactionsById)|pendingIntents\s*\.\s*[A-Za-z_$][\w$]*By[A-Za-z_$][\w$]*|promptQueue\s*\.\s*recordsBySessionId)\b/g
  },
  {
    label: "legacy roomId",
    pattern: /\broomId\b/g,
    scope: "agent-gui-production"
  },
  {
    label: "legacy room-agent naming",
    pattern:
      /\b(?:roomAgents|roomAgent|RoomAgent|AgentHostRoomAgent[A-Za-z0-9_]*)\b/g,
    scope: "agent-gui-production"
  }
];

const violations = [];

for (const scanRoot of [agentGuiRoot, desktopRendererRoot]) {
  for (const filePath of walk(scanRoot)) {
    const relativePath = relative(workspaceRoot, filePath);
    if (!isScannedSourceFile(relativePath) || allowedFiles.has(relativePath)) {
      continue;
    }
    const source = readFileSync(filePath, "utf8");
    if (
      relativePath.startsWith("apps/desktop/src/renderer/src/features/") &&
      source.includes("getSessionEngine") &&
      source.includes("useSyncExternalStore")
    ) {
      const index = source.indexOf("useSyncExternalStore");
      violations.push({
        column: columnNumber(source, index),
        file: relativePath,
        label: "direct AgentSessionEngine useSyncExternalStore subscription",
        line: lineNumber(source, index)
      });
    }
    for (const rule of forbiddenPatterns) {
      if (!isRuleInScope(rule, relativePath)) {
        continue;
      }
      for (const match of source.matchAll(rule.pattern)) {
        violations.push({
          column: columnNumber(source, match.index ?? 0),
          file: relativePath,
          label: rule.label,
          line: lineNumber(source, match.index ?? 0)
        });
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    "Agent consumers must use AgentActivityRuntime and AgentSessionEngine selectors.\n"
  );
  process.stderr.write(
    "Move legacy AgentHostWorkspaceAgent access into host compatibility or projection boundary files.\n\n"
  );
  for (const violation of violations) {
    process.stderr.write(
      `- ${violation.file}:${violation.line}:${violation.column} uses ${violation.label}\n`
    );
  }
  process.exitCode = 1;
} else {
  console.log("Agent activity runtime boundary check passed");
}

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    const filePath = resolve(directory, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      yield* walk(filePath);
      continue;
    }
    yield filePath;
  }
}

function isScannedSourceFile(relativePath) {
  if (!/\.[cm]?[tj]sx?$/.test(relativePath)) {
    return false;
  }
  const normalized = `/${relativePath}`;
  if (ignoredPathFragments.some((fragment) => normalized.includes(fragment))) {
    return false;
  }
  return !ignoredFilenamePatterns.some((pattern) => pattern.test(relativePath));
}

function isRuleInScope(rule, relativePath) {
  if (rule.allowedFiles?.has(relativePath)) {
    return false;
  }
  if (rule.scope === "agent-gui-production") {
    return relativePath.startsWith("packages/agent/gui/agent-gui/");
  }
  return true;
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function columnNumber(source, index) {
  const previousNewline = source.lastIndexOf("\n", index - 1);
  return index - previousNewline;
}
