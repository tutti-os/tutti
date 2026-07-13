import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = resolve(scriptDirectory, "../..");
const workspaceRoot = process.env.TUTTI_WORKSPACE_ROOT ?? defaultWorkspaceRoot;
const ts = await loadTypeScriptModule();
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
const scannedFiles = [agentGuiRoot, desktopRendererRoot]
  .filter(existsSync)
  .flatMap((scanRoot) => [...walk(scanRoot)])
  .filter((filePath) => {
    const relativePath = relative(workspaceRoot, filePath);
    return isScannedSourceFile(relativePath) && !allowedFiles.has(relativePath);
  });
const program = ts.createProgram({
  rootNames: scannedFiles,
  options: {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest
  }
});
const typeChecker = program.getTypeChecker();

for (const filePath of scannedFiles) {
  const relativePath = relative(workspaceRoot, filePath);
  const source = readFileSync(filePath, "utf8");
  if (relativePath.startsWith("apps/desktop/src/renderer/src/features/")) {
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) {
      throw new Error(`Unable to parse ${relativePath}`);
    }
    for (const index of findDirectSessionEngineSubscriptions(
      sourceFile,
      typeChecker
    )) {
      violations.push({
        column: columnNumber(source, index),
        file: relativePath,
        label: "direct AgentSessionEngine useSyncExternalStore subscription",
        line: lineNumber(source, index)
      });
    }
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

function findDirectSessionEngineSubscriptions(sourceFile, typeChecker) {
  const positions = [];

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      isUseSyncExternalStoreCall(node.expression) &&
      node.arguments.some((argument) =>
        expressionDependsOnSessionEngine(
          argument,
          typeChecker,
          new Set(),
          new Set()
        )
      )
    ) {
      positions.push(node.expression.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return positions;
}

function isUseSyncExternalStoreCall(expression) {
  return (
    (ts.isIdentifier(expression) &&
      expression.text === "useSyncExternalStore") ||
    (ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "useSyncExternalStore")
  );
}

function expressionDependsOnSessionEngine(
  node,
  typeChecker,
  visitedNodes,
  visitedSymbols
) {
  if (visitedNodes.has(node)) {
    return false;
  }
  visitedNodes.add(node);

  if (ts.isCallExpression(node) && isGetSessionEngineCall(node.expression)) {
    return true;
  }

  if (ts.isIdentifier(node) && !isPropertyNameIdentifier(node)) {
    const symbol = typeChecker.getSymbolAtLocation(node);
    if (symbol && !visitedSymbols.has(symbol)) {
      visitedSymbols.add(symbol);
      for (const declaration of symbol.declarations ?? []) {
        const valueNode = declarationValueNode(declaration);
        if (
          valueNode &&
          expressionDependsOnSessionEngine(
            valueNode,
            typeChecker,
            visitedNodes,
            visitedSymbols
          )
        ) {
          return true;
        }
      }
    }
  }

  let dependsOnSessionEngine = false;
  ts.forEachChild(node, (child) => {
    if (
      !dependsOnSessionEngine &&
      expressionDependsOnSessionEngine(
        child,
        typeChecker,
        visitedNodes,
        visitedSymbols
      )
    ) {
      dependsOnSessionEngine = true;
    }
  });
  return dependsOnSessionEngine;
}

function isGetSessionEngineCall(expression) {
  return (
    (ts.isIdentifier(expression) && expression.text === "getSessionEngine") ||
    (ts.isPropertyAccessExpression(expression) &&
      expression.name.text === "getSessionEngine")
  );
}

function isPropertyNameIdentifier(node) {
  return (
    (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
    (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
    (ts.isMethodDeclaration(node.parent) && node.parent.name === node)
  );
}

function declarationValueNode(declaration) {
  if (
    ts.isVariableDeclaration(declaration) ||
    ts.isBindingElement(declaration) ||
    ts.isParameter(declaration) ||
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertyAssignment(declaration)
  ) {
    return declaration.initializer ?? null;
  }
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isGetAccessorDeclaration(declaration)
  ) {
    return declaration.body ?? null;
  }
  return null;
}

function lineNumber(source, index) {
  return source.slice(0, index).split("\n").length;
}

function columnNumber(source, index) {
  const previousNewline = source.lastIndexOf("\n", index - 1);
  return index - previousNewline;
}

async function loadTypeScriptModule() {
  const candidateRoots = [workspaceRoot, defaultWorkspaceRoot];
  const candidatePaths = candidateRoots.flatMap((root) => [
    join(root, "node_modules/typescript/lib/typescript.js"),
    join(root, "apps/desktop/node_modules/typescript/lib/typescript.js"),
    join(
      root,
      "packages/clients/tuttid-ts/node_modules/typescript/lib/typescript.js"
    )
  ]);

  for (const candidatePath of candidatePaths) {
    if (!existsSync(candidatePath)) {
      continue;
    }
    const module = await import(pathToFileURL(candidatePath).href);
    return module.default ?? module;
  }

  throw new Error(
    "Unable to locate a TypeScript runtime for check-agent-activity-runtime-boundaries.mjs"
  );
}
