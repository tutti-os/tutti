import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  aggregateMetrics,
  checkStagedFile,
  compareWithBaseline,
  countEffects,
  countLines,
  countMemoization,
  countModuleMutableGlobals,
  countProviderBranches,
  countStoreCreations,
  countSwallowedCatches,
  isScannedSourceFile,
  isTimerForbiddenFile,
  measureFileMetrics,
  parseStagedAddedLines
} from "./check-agent-gui-degradation.mjs";

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-agent-gui-degradation.mjs"
);

test("counts effects and memoization hooks", () => {
  const source = [
    "useEffect(() => {}, []);",
    "useLayoutEffect(() => {}, []);",
    "const value = useMemo(() => 1, []);",
    "const callback = useCallback(() => 2, []);",
    "export default memo(Component);"
  ].join("\n");
  assert.equal(countEffects(source), 2);
  assert.equal(countMemoization(source), 3);
});

test("counts provider behavior branches with the wide ruleset", () => {
  const source = [
    'if (provider === "codex") {}',
    'if (data.provider !== "claude-code") {}',
    "switch (provider) {",
    '  case "opencode":',
    '  case "cursor":',
    "    break;",
    "}",
    '// case "not-a-provider":',
    'if (kind === "codex") {}'
  ].join("\n");
  assert.equal(countProviderBranches(source), 4);
});

test("detects swallowed catch blocks including comment-only bodies", () => {
  const source = [
    "try { run(); } catch {}",
    "try { run(); } catch (error) {",
    "  // ignored on purpose",
    "}",
    "try { run(); } catch (error) {",
    "  report(error);",
    "}",
    "promise.catch((error) => report(error));"
  ].join("\n");
  assert.equal(countSwallowedCatches(source), 2);
});

test("ignores catch keyword inside strings", () => {
  const source = 'const label = "catch {} nothing";';
  assert.equal(countSwallowedCatches(source), 0);
});

test("counts store creations only in files importing valtio or zustand", () => {
  const valtioSource = [
    'import { proxy } from "valtio/vanilla";',
    "const state = proxy({ open: false });"
  ].join("\n");
  const zustandSource = [
    'import { create } from "zustand";',
    "const useStore = create<State>()(() => ({}));"
  ].join("\n");
  const plainSource = "const state = proxy({ open: false });";
  assert.equal(countStoreCreations(valtioSource), 1);
  assert.equal(countStoreCreations(zustandSource), 1);
  assert.equal(countStoreCreations(plainSource), 0);
});

test("counts module-level mutable globals at column zero only", () => {
  const source = [
    "let mutableSlot = null;",
    "export let sharedFlag = false;",
    "function scoped() {",
    "  let local = 1;",
    "  return local;",
    "}",
    "const stable = 2;"
  ].join("\n");
  assert.equal(countModuleMutableGlobals(source), 2);
});

test("counts trailing line without final newline", () => {
  assert.equal(countLines("a\nb\nc"), 3);
  assert.equal(countLines("a\nb\nc\n"), 3);
  assert.equal(countLines(""), 0);
});

test("skips test, generated, and dist files from scanning", () => {
  assert.equal(
    isScannedSourceFile("packages/agent/gui/agent-gui/Component.tsx"),
    true
  );
  assert.equal(
    isScannedSourceFile("packages/agent/gui/agent-gui/Component.spec.tsx"),
    false
  );
  assert.equal(
    isScannedSourceFile("packages/agent/gui/dist/Component.tsx"),
    false
  );
  assert.equal(isScannedSourceFile("packages/agent/gui/types.d.ts"), false);
  assert.equal(isScannedSourceFile("packages/agent/gui/README.md"), false);
});

test("marks engine, reducer, and selector paths as timer-forbidden", () => {
  assert.equal(
    isTimerForbiddenFile("packages/agent/activity-core/src/engine/loop.ts"),
    true
  );
  assert.equal(
    isTimerForbiddenFile("packages/agent/activity-core/src/queue.reducer.ts"),
    true
  );
  assert.equal(
    isTimerForbiddenFile("packages/agent/activity-core/src/selectors.ts"),
    true
  );
  assert.equal(
    isTimerForbiddenFile("packages/agent/gui/agent-gui/Component.tsx"),
    false
  );
});

test("routes provider branches of identity-exempt files to the identity bucket", () => {
  const source = 'const icon = provider === "codex" ? codexIcon : defaultIcon;';
  const exemptPath = "packages/agent/gui/agentGuiSessionProviderIconUrls.ts";
  const exempt = measureFileMetrics(exemptPath, source, [exemptPath]);
  assert.equal(exempt.providerBranches, 0);
  assert.equal(exempt.identityProviderBranches, 1);
  const regular = measureFileMetrics(exemptPath, source, []);
  assert.equal(regular.providerBranches, 1);
  assert.equal(regular.identityProviderBranches, 0);
});

test("aggregates hook totals and applies the per-file 800-line threshold", () => {
  const longFile = measureFileMetrics(
    "packages/agent/gui/long.ts",
    `${"line\n".repeat(801)}`,
    []
  );
  const shortFile = measureFileMetrics(
    "packages/agent/gui/short.ts",
    "useEffect(() => {}, []);\n",
    []
  );
  const metrics = aggregateMetrics({
    "packages/agent/gui/long.ts": longFile,
    "packages/agent/gui/short.ts": shortFile
  });
  assert.deepEqual(metrics.fileLines, { "packages/agent/gui/long.ts": 801 });
  assert.equal(metrics.effectCount, 1);
  assert.equal(metrics.memoCount, 0);
});

test("flags increases as regressions and decreases as unlocked improvements", () => {
  const { improvements, regressions } = compareWithBaseline(
    {
      fileLines: { "a.ts": 900, "c.ts": 850 },
      providerBranches: 10,
      setTimeoutCount: 2
    },
    {
      fileLines: { "a.ts": 850, "b.ts": 900 },
      providerBranches: 12,
      setTimeoutCount: 2
    }
  );
  assert.equal(regressions.length, 2);
  assert.ok(regressions.some((entry) => /a\.ts 850 -> 900/.test(entry)));
  assert.ok(
    regressions.some((entry) => /c\.ts.*not in the baseline/.test(entry))
  );
  assert.equal(improvements.length, 2);
  assert.ok(
    improvements.some((entry) => /providerBranches: 12 -> 10/.test(entry))
  );
  assert.ok(improvements.some((entry) => /b\.ts 900 -> gone/.test(entry)));
});

test("treats new over-limit files as regressions even without baseline entry", () => {
  const { regressions } = compareWithBaseline(
    { fileLines: { "new.ts": 900 } },
    { fileLines: {} }
  );
  assert.equal(regressions.length, 1);
  assert.match(regressions[0], /not in the baseline/);
});

test("parses added lines from a unified zero-context diff", () => {
  const diff = [
    "diff --git a/packages/agent/gui/x.ts b/packages/agent/gui/x.ts",
    "--- a/packages/agent/gui/x.ts",
    "+++ b/packages/agent/gui/x.ts",
    "@@ -10,0 +11,2 @@ context",
    "+const added = 1;",
    "+const alsoAdded = 2;",
    "@@ -20 +23 @@ context",
    "-const removed = 3;",
    "+const replaced = 4;"
  ].join("\n");
  const addedLinesByFile = parseStagedAddedLines(diff);
  assert.deepEqual(addedLinesByFile.get("packages/agent/gui/x.ts"), [
    { content: "const added = 1;", line: 11 },
    { content: "const alsoAdded = 2;", line: 12 },
    { content: "const replaced = 4;", line: 23 }
  ]);
});

test("staged check flags uncommented timers and accepts timing-comment timers", () => {
  const stagedContent = [
    "// timing: batch daemon events into one frame",
    "setTimeout(flush, 33);",
    "setTimeout(retry, 100);"
  ].join("\n");
  const violations = checkStagedFile({
    addedLines: [
      { content: "setTimeout(flush, 33);", line: 2 },
      { content: "setTimeout(retry, 100);", line: 3 }
    ],
    identityExemptFiles: [],
    relativePath: "packages/agent/gui/agent-gui/helper.ts",
    stagedContent
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "no-sync-timer");
  assert.equal(violations[0].line, 3);
});

test("staged check rejects timers in timer-forbidden paths despite comments", () => {
  const stagedContent = [
    "// timing: not acceptable here",
    "setTimeout(step, 5);"
  ].join("\n");
  const violations = checkStagedFile({
    addedLines: [{ content: "setTimeout(step, 5);", line: 2 }],
    identityExemptFiles: [],
    relativePath: "packages/agent/activity-core/src/engine/loop.ts",
    stagedContent
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "no-sync-timer");
});

test("staged check flags new provider branches outside identity-exempt files", () => {
  const line = 'if (provider === "codex") { enablePlanMode(); }';
  const flagged = checkStagedFile({
    addedLines: [{ content: line, line: 1 }],
    identityExemptFiles: [],
    relativePath: "packages/agent/gui/agent-gui/behavior.ts",
    stagedContent: line
  });
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].rule, "provider-branch-freeze");

  const exempt = checkStagedFile({
    addedLines: [{ content: line, line: 1 }],
    identityExemptFiles: [
      "packages/agent/gui/agentGuiSessionProviderIconUrls.ts"
    ],
    relativePath: "packages/agent/gui/agentGuiSessionProviderIconUrls.ts",
    stagedContent: line
  });
  assert.equal(exempt.length, 0);
});

test("staged check flags store creation in component files", () => {
  const stagedContent = [
    'import { proxy } from "valtio/vanilla";',
    "const railState = proxy({ hovered: null });"
  ].join("\n");
  const violations = checkStagedFile({
    addedLines: [
      { content: "const railState = proxy({ hovered: null });", line: 2 }
    ],
    identityExemptFiles: [],
    relativePath: "packages/agent/gui/agent-gui/View.tsx",
    stagedContent
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "no-store-in-view");
});

test("staged check flags direct useSyncExternalStore outside the binding file", () => {
  const line = "const value = useSyncExternalStore(subscribe, getSnapshot);";
  const flagged = checkStagedFile({
    addedLines: [{ content: line, line: 1 }],
    identityExemptFiles: [],
    relativePath: "packages/agent/gui/agent-gui/Component.tsx",
    stagedContent: line
  });
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].rule, "single-subscription-binding");

  const binding = checkStagedFile({
    addedLines: [{ content: line, line: 1 }],
    identityExemptFiles: [],
    relativePath: "packages/agent/gui/shared/engine/useEngineSelector.ts",
    stagedContent: line
  });
  assert.equal(binding.length, 0);
});

test("staged check flags swallowed catches intersecting added lines", () => {
  const stagedContent = ["try {", "  run();", "} catch {", "}"].join("\n");
  const violations = checkStagedFile({
    addedLines: [{ content: "} catch {", line: 3 }],
    identityExemptFiles: [],
    relativePath: "packages/agent/gui/agent-gui/helper.ts",
    stagedContent
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "no-swallowed-catch");
});

test("staged check flags new module-level mutable globals", () => {
  const line = "let activeRuntimeSlot = null;";
  const violations = checkStagedFile({
    addedLines: [{ content: line, line: 1 }],
    identityExemptFiles: [],
    relativePath: "packages/agent/gui/runtimeRegistry.ts",
    stagedContent: line
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "no-module-mutable-global");
});

test("full mode generates a baseline and then detects regressions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-gui-degradation-"));
  const sourcePath = join(
    workspaceRoot,
    "packages/agent/gui/agent-gui/sample.ts"
  );
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, 'if (provider === "codex") {}\n');
  const baselinePath = join(workspaceRoot, "baseline/agent-gui.json");

  const update = runScript(workspaceRoot, baselinePath, ["--update-baseline"]);
  assert.equal(update.status, 0, update.stderr || update.stdout);

  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  assert.equal(baseline.metrics.providerBranches, 1);

  const pass = runScript(workspaceRoot, baselinePath, []);
  assert.equal(pass.status, 0, pass.stderr || pass.stdout);
  assert.match(pass.stdout, /degradation check passed/);

  await writeFile(
    sourcePath,
    'if (provider === "codex") {}\nif (provider === "cursor") {}\n'
  );
  const regression = runScript(workspaceRoot, baselinePath, []);
  assert.notEqual(regression.status, 0);
  assert.match(regression.stderr, /providerBranches: 1 -> 2/);

  await writeFile(sourcePath, "const clean = 1;\n");
  const improvement = runScript(workspaceRoot, baselinePath, []);
  assert.notEqual(improvement.status, 0);
  assert.match(improvement.stderr, /--update-baseline/);
});

test("staged mode flags violations on staged added lines end to end", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-gui-degradation-"));
  const run = (command, args) =>
    spawnSync(command, args, { cwd: workspaceRoot, encoding: "utf8" });
  run("git", ["init", "--quiet"]);
  run("git", ["config", "user.email", "test@example.com"]);
  run("git", ["config", "user.name", "Test"]);

  const sourcePath = join(
    workspaceRoot,
    "packages/agent/gui/agent-gui/helper.ts"
  );
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "export const before = 1;\n");
  run("git", ["add", "."]);
  run("git", ["commit", "--quiet", "-m", "init"]);

  await writeFile(
    sourcePath,
    "export const before = 1;\nsetTimeout(retry, 100);\n"
  );
  run("git", ["add", "."]);

  const baselinePath = join(workspaceRoot, "baseline/agent-gui.json");
  const result = runScript(workspaceRoot, baselinePath, ["--staged"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no-sync-timer/);

  await writeFile(
    sourcePath,
    "export const before = 1;\n// timing: retry with visible reason\nsetTimeout(retry, 100);\n"
  );
  run("git", ["add", "."]);
  const pass = runScript(workspaceRoot, baselinePath, ["--staged"]);
  assert.equal(pass.status, 0, pass.stderr || pass.stdout);
});

test("full mode fails with instructions when the baseline is missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "agent-gui-degradation-"));
  await mkdir(join(workspaceRoot, "packages/agent/gui"), { recursive: true });
  const baselinePath = join(workspaceRoot, "baseline/agent-gui.json");
  const result = runScript(workspaceRoot, baselinePath, []);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /baseline is missing/);
});

function runScript(workspaceRoot, baselinePath, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      TUTTI_AGENT_GUI_DEGRADATION_BASELINE: baselinePath,
      TUTTI_WORKSPACE_ROOT: workspaceRoot
    }
  });
}
