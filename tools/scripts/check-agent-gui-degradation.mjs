import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Degradation ratchet for the agent GUI refactor
// (docs/architecture/agent-gui-refactor-plan.md, sections 4.1 step 0 and 5.2).
//
// Modes:
// - default: measure metrics and compare against the committed baseline.
//   Any metric increase fails. Any decrease also fails until the baseline is
//   updated in the same change, so refactor wins stay locked.
// - --update-baseline: rewrite the baseline JSON from current measurements.
// - --staged: incremental checks on staged added lines only (pre-commit).
//
// The metric definitions in this script are the authoritative counting rules;
// numbers quoted in architecture documents are illustrative only.

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = join(scriptDirectory, "..", "..");

export const scanRootPrefixes = [
  "packages/agent/gui/",
  "packages/agent/activity-core/"
];

const goExemptionRootPrefix = "packages/agent/daemon/";

export const businessFileLineLimit = 800;

export const knownProviderIds = [
  "claude-code",
  "codex",
  "cursor",
  "hermes",
  "nexight",
  "openclaw",
  "opencode",
  "tutti-agent"
];

// Files allowed to call useSyncExternalStore directly. Once the engine binding
// (useEngineSelector) lands, it becomes the only entry here.
export const subscriptionBindingFilePatterns = [
  /packages\/agent\/(?:gui|activity-core)\/.*useEngineSelector\.tsx?$/
];

// Timer-free zones: engine, reducer, and selector code must express timing as
// state-machine transitions instead of setTimeout/setInterval.
export const timerForbiddenPathPatterns = [
  /packages\/agent\/activity-core\/src\/engine\//,
  /\.reducer\.tsx?$/,
  /(?:^|\/)selectors?\.tsx?$/
];

const ignoredPathFragments = [
  "/.turbo/",
  "/dist/",
  "/generated/",
  "/node_modules/",
  "/out/"
];

const ignoredFilenamePatterns = [
  /\.d\.ts$/,
  /\.spec\.[cm]?[tj]sx?$/,
  /\.test\.[cm]?[tj]sx?$/,
  /vitest\./
];

const providerLiteralComparisonPattern = () =>
  /\bprovider\s*(?:===|!==)\s*["'`]/g;

const providerCaseClausePattern = () =>
  new RegExp(`\\bcase\\s+["'\`](?:${knownProviderIds.join("|")})["'\`]`, "g");

const timerCallPattern = () => /\bset(?:Timeout|Interval)\s*\(/g;

const timerReasonCommentPattern = /(?:\/\/|\/\*|\*)\s*timing:/;

const useSyncExternalStorePattern = () => /\buseSyncExternalStore\b/g;

const moduleMutableGlobalPattern = () => /^(?:export\s+)?(?:let|var)\s/gm;

export function isScannedSourceFile(relativePath) {
  if (!/\.[cm]?[tj]sx?$/.test(relativePath)) {
    return false;
  }
  const normalized = `/${relativePath}`;
  if (ignoredPathFragments.some((fragment) => normalized.includes(fragment))) {
    return false;
  }
  return !ignoredFilenamePatterns.some((pattern) => pattern.test(relativePath));
}

export function isInScanRoots(relativePath) {
  return scanRootPrefixes.some((prefix) => relativePath.startsWith(prefix));
}

export function isSubscriptionBindingFile(relativePath) {
  return subscriptionBindingFilePatterns.some((pattern) =>
    pattern.test(relativePath)
  );
}

export function isTimerForbiddenFile(relativePath) {
  return timerForbiddenPathPatterns.some((pattern) =>
    pattern.test(relativePath)
  );
}

export function countMatches(source, pattern) {
  let count = 0;
  for (const _match of source.matchAll(pattern)) {
    count += 1;
  }
  return count;
}

export function countLines(source) {
  if (source.length === 0) {
    return 0;
  }
  const newlineCount = countMatches(source, /\n/g);
  return source.endsWith("\n") ? newlineCount : newlineCount + 1;
}

export function countEffects(source) {
  return countMatches(source, /\buse(?:Layout)?Effect\s*\(/g);
}

export function countMemoization(source) {
  return countMatches(source, /\buse(?:Memo|Callback)\s*\(|\bmemo\s*\(/g);
}

export function countProviderBranches(source) {
  return (
    countMatches(source, providerLiteralComparisonPattern()) +
    countMatches(source, providerCaseClausePattern())
  );
}

export function countTimerCalls(source) {
  return countMatches(source, timerCallPattern());
}

export function importsValtio(source) {
  return /from\s+["']valtio(?:\/|["'])/.test(source);
}

export function importsZustand(source) {
  return /from\s+["']zustand(?:\/|["'])/.test(source);
}

export function countStoreCreations(source) {
  let count = 0;
  if (importsValtio(source)) {
    count += countMatches(source, /\bproxy(?:Map|Set)?\s*[<(]/g);
  }
  if (importsZustand(source)) {
    count += countMatches(source, /\bcreate(?:Store)?\s*[<(]/g);
  }
  return count;
}

export function countModuleMutableGlobals(source) {
  return countMatches(source, moduleMutableGlobalPattern());
}

export function findSwallowedCatchRanges(source) {
  const ranges = [];
  for (const catchIndex of findCatchKeywordIndexes(source)) {
    const range = readCatchBlockRange(source, catchIndex);
    if (!range) {
      continue;
    }
    const body = source.slice(range.bodyStart + 1, range.bodyEnd);
    if (stripCommentsAndWhitespace(body).length === 0) {
      ranges.push({
        endLine: lineNumberAt(source, range.bodyEnd),
        startLine: lineNumberAt(source, catchIndex)
      });
    }
  }
  return ranges;
}

function findCatchKeywordIndexes(source) {
  const indexes = [];
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"' || character === "'" || character === "`") {
      cursor = skipStringLiteral(source, cursor);
      continue;
    }
    if (character === "/" && source[cursor + 1] === "/") {
      const lineEnd = source.indexOf("\n", cursor);
      cursor = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (character === "/" && source[cursor + 1] === "*") {
      const commentEnd = source.indexOf("*/", cursor + 2);
      cursor = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    if (
      character === "c" &&
      source.startsWith("catch", cursor) &&
      !/[\w$]/.test(source[cursor - 1] ?? "") &&
      !/[\w$]/.test(source[cursor + 5] ?? "")
    ) {
      indexes.push(cursor);
      cursor += 5;
      continue;
    }
    cursor += 1;
  }
  return indexes;
}

export function countSwallowedCatches(source) {
  return findSwallowedCatchRanges(source).length;
}

function readCatchBlockRange(source, catchIndex) {
  let cursor = catchIndex + "catch".length;
  cursor = skipWhitespaceAndComments(source, cursor);
  if (source[cursor] === "(") {
    const closeParen = findMatchingDelimiter(source, cursor, "(", ")");
    if (closeParen === -1) {
      return null;
    }
    cursor = skipWhitespaceAndComments(source, closeParen + 1);
  }
  if (source[cursor] !== "{") {
    return null;
  }
  const bodyEnd = findMatchingDelimiter(source, cursor, "{", "}");
  if (bodyEnd === -1) {
    return null;
  }
  return { bodyEnd, bodyStart: cursor };
}

function skipWhitespaceAndComments(source, startIndex) {
  let cursor = startIndex;
  while (cursor < source.length) {
    const character = source[cursor];
    if (/\s/.test(character)) {
      cursor += 1;
      continue;
    }
    if (character === "/" && source[cursor + 1] === "/") {
      const lineEnd = source.indexOf("\n", cursor);
      cursor = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (character === "/" && source[cursor + 1] === "*") {
      const commentEnd = source.indexOf("*/", cursor + 2);
      cursor = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function findMatchingDelimiter(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let cursor = openIndex;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '"' || character === "'" || character === "`") {
      cursor = skipStringLiteral(source, cursor);
      continue;
    }
    if (character === "/" && source[cursor + 1] === "/") {
      const lineEnd = source.indexOf("\n", cursor);
      cursor = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (character === "/" && source[cursor + 1] === "*") {
      const commentEnd = source.indexOf("*/", cursor + 2);
      cursor = commentEnd === -1 ? source.length : commentEnd + 2;
      continue;
    }
    if (character === openChar) {
      depth += 1;
    } else if (character === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
    cursor += 1;
  }
  return -1;
}

function skipStringLiteral(source, quoteIndex) {
  const quote = source[quoteIndex];
  let cursor = quoteIndex + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === quote) {
      return cursor + 1;
    }
    if (quote !== "`" && character === "\n") {
      return cursor + 1;
    }
    cursor += 1;
  }
  return cursor;
}

function stripCommentsAndWhitespace(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

export function measureFileMetrics(relativePath, source, identityExemptFiles) {
  const providerBranches = countProviderBranches(source);
  const isIdentityExempt = identityExemptFiles.includes(relativePath);
  return {
    effectCount: countEffects(source),
    identityProviderBranches: isIdentityExempt ? providerBranches : 0,
    lineCount: countLines(source),
    memoCount: countMemoization(source),
    moduleMutableGlobals: countModuleMutableGlobals(source),
    providerBranches: isIdentityExempt ? 0 : providerBranches,
    setTimeoutCount: countTimerCalls(source),
    storeCreations: countStoreCreations(source),
    swallowedCatches: countSwallowedCatches(source),
    useSyncExternalStoreCount: isSubscriptionBindingFile(relativePath)
      ? 0
      : countMatches(source, useSyncExternalStorePattern())
  };
}

export function aggregateMetrics(fileMetricsByPath) {
  const metrics = {
    effectCount: 0,
    fileLines: {},
    goFileLengthExemptions: 0,
    identityProviderBranches: 0,
    memoCount: 0,
    moduleMutableGlobals: 0,
    overlayStores: 0,
    providerBranches: 0,
    setTimeoutCount: 0,
    swallowedCatch: 0,
    useSyncExternalStoreCount: 0
  };
  const sortedPaths = Array.from(Object.keys(fileMetricsByPath)).sort();
  for (const path of sortedPaths) {
    const file = fileMetricsByPath[path];
    if (file.lineCount > businessFileLineLimit) {
      metrics.fileLines[path] = file.lineCount;
    }
    // Effects and memoization move with a vertical module when a monolith is
    // decomposed. Track their package-wide totals so moving an existing hook
    // into a focused file is neutral while adding more orchestration still
    // fails the ratchet. File length remains a per-file map below.
    metrics.effectCount += file.effectCount;
    metrics.memoCount += file.memoCount;
    metrics.identityProviderBranches += file.identityProviderBranches;
    metrics.moduleMutableGlobals += file.moduleMutableGlobals;
    metrics.overlayStores += file.storeCreations;
    metrics.providerBranches += file.providerBranches;
    metrics.setTimeoutCount += file.setTimeoutCount;
    metrics.swallowedCatch += file.swallowedCatches;
    metrics.useSyncExternalStoreCount += file.useSyncExternalStoreCount;
  }
  return metrics;
}

export function compareWithBaseline(currentMetrics, baselineMetrics) {
  const regressions = [];
  const improvements = [];

  for (const key of Object.keys(currentMetrics)) {
    const current = currentMetrics[key];
    const baseline = baselineMetrics[key];
    if (typeof current === "number") {
      const baselineValue = typeof baseline === "number" ? baseline : 0;
      if (current > baselineValue) {
        regressions.push(
          `${key}: ${baselineValue} -> ${current} (must not increase)`
        );
      } else if (current < baselineValue) {
        improvements.push(`${key}: ${baselineValue} -> ${current}`);
      }
      continue;
    }

    const baselineMap =
      baseline && typeof baseline === "object" ? baseline : {};
    for (const [path, value] of Object.entries(current)) {
      const baselineValue = baselineMap[path];
      if (typeof baselineValue !== "number") {
        if (key === "fileLines") {
          regressions.push(
            `${key}: ${path} has ${value} lines and is not in the baseline (limit ${businessFileLineLimit})`
          );
        } else {
          regressions.push(`${key}: ${path} 0 -> ${value} (must not increase)`);
        }
        continue;
      }
      if (value > baselineValue) {
        regressions.push(
          `${key}: ${path} ${baselineValue} -> ${value} (must not increase)`
        );
      } else if (value < baselineValue) {
        improvements.push(`${key}: ${path} ${baselineValue} -> ${value}`);
      }
    }
    for (const [path, baselineValue] of Object.entries(baselineMap)) {
      if (!(path in current)) {
        improvements.push(`${key}: ${path} ${baselineValue} -> gone`);
      }
    }
  }

  return { improvements, regressions };
}

export function parseStagedAddedLines(diffOutput) {
  const addedLinesByFile = new Map();
  let currentFile = null;
  let nextAddedLine = null;
  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      currentFile = path.startsWith("b/") ? path.slice(2) : path;
      if (currentFile === "/dev/null") {
        currentFile = null;
      }
      continue;
    }
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      nextAddedLine = Number(hunkMatch[1]);
      continue;
    }
    if (currentFile === null || nextAddedLine === null) {
      continue;
    }
    if (line.startsWith("+")) {
      if (!addedLinesByFile.has(currentFile)) {
        addedLinesByFile.set(currentFile, []);
      }
      addedLinesByFile.get(currentFile).push({
        content: line.slice(1),
        line: nextAddedLine
      });
      nextAddedLine += 1;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      nextAddedLine += 1;
    }
  }
  return addedLinesByFile;
}

export function checkStagedFile({
  relativePath,
  stagedContent,
  addedLines,
  identityExemptFiles
}) {
  const violations = [];
  const contentLines = stagedContent.split("\n");
  const swallowedRanges = findSwallowedCatchRanges(stagedContent);
  const timerForbidden = isTimerForbiddenFile(relativePath);
  const isComponentFile = relativePath.endsWith(".tsx");
  const identityExempt = identityExemptFiles.includes(relativePath);
  const bindingFile = isSubscriptionBindingFile(relativePath);
  const usesValtio = importsValtio(stagedContent);
  const usesZustand = importsZustand(stagedContent);

  for (const added of addedLines) {
    const { content, line } = added;

    if (timerCallPattern().test(content)) {
      if (timerForbidden) {
        violations.push({
          line,
          message:
            "timers are forbidden in engine/reducer/selector code; model timing as an expiry intent instead",
          rule: "no-sync-timer"
        });
      } else if (!hasTimerReasonComment(contentLines, line)) {
        violations.push({
          line,
          message:
            "new timers must carry a `// timing: <reason>` comment on the same or previous line",
          rule: "no-sync-timer"
        });
      }
    }

    if (
      !identityExempt &&
      (providerLiteralComparisonPattern().test(content) ||
        providerCaseClausePattern().test(content))
    ) {
      violations.push({
        line,
        message:
          "new provider behavior branches are frozen; consume daemon capability/catalog contracts instead (identity-display files are exempt via the baseline list)",
        rule: "provider-branch-freeze"
      });
    }

    if (
      isComponentFile &&
      ((usesValtio && /\bproxy(?:Map|Set)?\s*[<(]/.test(content)) ||
        (usesZustand && /\bcreate(?:Store)?\s*[<(]/.test(content)))
    ) {
      violations.push({
        line,
        message:
          "component files must not create valtio/zustand stores; shared state belongs to the workspace engine",
        rule: "no-store-in-view"
      });
    }

    if (!bindingFile && useSyncExternalStorePattern().test(content)) {
      violations.push({
        line,
        message:
          "components must not call useSyncExternalStore directly; subscribe through the single engine binding (useEngineSelector)",
        rule: "single-subscription-binding"
      });
    }

    // Column-0 anchoring keeps function-local declarations out of scope.
    if (/^(?:export\s+)?(?:let|var)\s/.test(content)) {
      violations.push({
        line,
        message:
          "new module-level mutable globals are forbidden in published agent packages; inject instances explicitly",
        rule: "no-module-mutable-global"
      });
    }
  }

  const addedLineNumbers = new Set(addedLines.map((added) => added.line));
  for (const range of swallowedRanges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      if (addedLineNumbers.has(line)) {
        violations.push({
          line: range.startLine,
          message:
            "catch blocks must report diagnostics or rethrow; silently swallowed errors are forbidden",
          rule: "no-swallowed-catch"
        });
        break;
      }
    }
  }

  return violations;
}

function hasTimerReasonComment(contentLines, lineNumber) {
  const line = contentLines[lineNumber - 1] ?? "";
  const previousLine = contentLines[lineNumber - 2] ?? "";
  return (
    timerReasonCommentPattern.test(line) ||
    timerReasonCommentPattern.test(previousLine)
  );
}

export function collectMetrics({ workspaceRoot, identityExemptFiles }) {
  const fileMetricsByPath = {};
  for (const rootPrefix of scanRootPrefixes) {
    const absoluteRoot = join(workspaceRoot, rootPrefix);
    if (!existsSync(absoluteRoot)) {
      continue;
    }
    for (const filePath of walk(absoluteRoot)) {
      const relativePath = toPosixPath(relative(workspaceRoot, filePath));
      if (!isScannedSourceFile(relativePath)) {
        continue;
      }
      const source = readFileSync(filePath, "utf8");
      fileMetricsByPath[relativePath] = measureFileMetrics(
        relativePath,
        source,
        identityExemptFiles
      );
    }
  }
  const metrics = aggregateMetrics(fileMetricsByPath);
  metrics.goFileLengthExemptions = countGoFileLengthExemptions(workspaceRoot);
  return metrics;
}

function countGoFileLengthExemptions(workspaceRoot) {
  const absoluteRoot = join(workspaceRoot, goExemptionRootPrefix);
  if (!existsSync(absoluteRoot)) {
    return 0;
  }
  let count = 0;
  for (const filePath of walk(absoluteRoot)) {
    if (!filePath.endsWith(".go")) {
      continue;
    }
    const source = readFileSync(filePath, "utf8");
    count += countMatches(source, /revive:disable:file-length-limit/g);
  }
  return count;
}

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".turbo") {
      continue;
    }
    const filePath = join(directory, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      yield* walk(filePath);
      continue;
    }
    yield filePath;
  }
}

function toPosixPath(path) {
  return path.split(sep).join("/");
}

export function readBaseline(baselinePath) {
  if (!existsSync(baselinePath)) {
    return null;
  }
  return JSON.parse(readFileSync(baselinePath, "utf8"));
}

function writeBaseline(baselinePath, baseline) {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
}

function runFullMode({ workspaceRoot, baselinePath, updateBaseline }) {
  const existingBaseline = readBaseline(baselinePath);
  const identityExemptFiles = existingBaseline?.identityExemptFiles ?? [];
  const metrics = collectMetrics({ identityExemptFiles, workspaceRoot });

  if (updateBaseline) {
    writeBaseline(baselinePath, {
      identityExemptFiles,
      metrics
    });
    console.log(
      `agent-gui degradation baseline written to ${toPosixPath(
        relative(workspaceRoot, baselinePath)
      )}`
    );
    return 0;
  }

  if (!existingBaseline) {
    console.error(
      "agent-gui degradation baseline is missing. Generate it with:\n" +
        "  node tools/scripts/check-agent-gui-degradation.mjs --update-baseline"
    );
    return 1;
  }

  const { improvements, regressions } = compareWithBaseline(
    metrics,
    existingBaseline.metrics ?? {}
  );

  if (regressions.length > 0) {
    console.error("agent-gui degradation check failed (metrics increased):");
    for (const regression of regressions) {
      console.error(`- ${regression}`);
    }
    console.error(
      "\nFix the regression at its source instead of raising the baseline." +
        "\nSee docs/architecture/agent-gui-refactor-plan.md section 5.2."
    );
    return 1;
  }

  if (improvements.length > 0) {
    console.error(
      "agent-gui degradation metrics improved; lock the win by updating the baseline in this change:"
    );
    for (const improvement of improvements) {
      console.error(`- ${improvement}`);
    }
    console.error(
      "\nRun: node tools/scripts/check-agent-gui-degradation.mjs --update-baseline"
    );
    return 1;
  }

  console.log("agent-gui degradation check passed");
  return 0;
}

function runStagedMode({ workspaceRoot, baselinePath }) {
  const existingBaseline = readBaseline(baselinePath);
  const identityExemptFiles = existingBaseline?.identityExemptFiles ?? [];

  const diffOutput = execFileSync(
    "git",
    [
      "diff",
      "--cached",
      "-U0",
      "--no-color",
      "--diff-filter=ACMR",
      "--",
      ...scanRootPrefixes
    ],
    { cwd: workspaceRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );

  const addedLinesByFile = parseStagedAddedLines(diffOutput);
  const violations = [];

  for (const [relativePath, addedLines] of addedLinesByFile) {
    if (!isScannedSourceFile(relativePath) || !isInScanRoots(relativePath)) {
      continue;
    }
    let stagedContent;
    try {
      stagedContent = execFileSync("git", ["show", `:${relativePath}`], {
        cwd: workspaceRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
      });
    } catch {
      continue;
    }
    for (const violation of checkStagedFile({
      addedLines,
      identityExemptFiles,
      relativePath,
      stagedContent
    })) {
      violations.push({ file: relativePath, ...violation });
    }
  }

  if (violations.length > 0) {
    console.error("agent-gui degradation staged check failed:");
    for (const violation of violations) {
      console.error(
        `- [${violation.rule}] ${violation.file}:${violation.line} ${violation.message}`
      );
    }
    console.error(
      "\nSee docs/architecture/agent-gui-refactor-plan.md sections 5.2 and 5.3."
    );
    return 1;
  }

  console.log("agent-gui degradation staged check passed");
  return 0;
}

function main() {
  const workspaceRoot =
    process.env.TUTTI_WORKSPACE_ROOT ?? defaultWorkspaceRoot;
  const baselinePath =
    process.env.TUTTI_AGENT_GUI_DEGRADATION_BASELINE ??
    join(workspaceRoot, "tools/degradation-baseline/agent-gui.json");
  const staged = process.argv.includes("--staged");
  const updateBaseline = process.argv.includes("--update-baseline");

  if (staged) {
    process.exitCode = runStagedMode({ baselinePath, workspaceRoot });
    return;
  }
  process.exitCode = runFullMode({
    baselinePath,
    updateBaseline,
    workspaceRoot
  });
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main();
}
