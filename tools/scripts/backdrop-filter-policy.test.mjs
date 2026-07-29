import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeBackdropFilterArtifact,
  analyzeBackdropFilterArtifacts,
  analyzeBackdropFilterAuthoring,
  isBackdropFilterAuthoringPath
} from "./backdrop-filter-policy.mjs";

test("authoring policy rejects kebab-case prefixed declarations", () => {
  const source = [
    ".overlay {",
    "  backdrop-filter: blur(24px);",
    "  -webkit-backdrop-filter: blur(24px);",
    "}"
  ].join("\n");

  assert.deepEqual(analyzeBackdropFilterAuthoring({ path: "a.css", source }), [
    {
      column: 3,
      kind: "prefixed-authoring",
      line: 3,
      message: "remove -webkit-backdrop-filter; author backdrop-filter only",
      path: "a.css",
      token: "-webkit-backdrop-filter"
    }
  ]);
});

test("authoring policy rejects case-insensitive prefixed declarations", () => {
  const diagnostics = analyzeBackdropFilterAuthoring({
    path: "a.html",
    source: "<style>.overlay{-Webkit-Backdrop-Filter:blur(2px)}</style>"
  });

  assert.equal(diagnostics[0]?.kind, "prefixed-authoring");
  assert.equal(diagnostics[0]?.token, "-webkit-backdrop-filter");
});

test("authoring policy allows standard and unrelated webkit properties", () => {
  const source = [
    ".title { backdrop-filter: blur(1px); -webkit-app-region: drag; }",
    "const style = { WebkitBackdropFilter: 'none' };"
  ].join("\n");

  assert.deepEqual(
    analyzeBackdropFilterAuthoring({ path: "a.ts", source }),
    []
  );
});

test("authoring path scope covers production sources only", () => {
  assert.equal(
    isBackdropFilterAuthoringPath(
      "packages/workbench/launchpad/src/styles/workbench-launchpad.css"
    ),
    true
  );
  assert.equal(isBackdropFilterAuthoringPath("apps/desktop/index.html"), true);
  assert.equal(
    isBackdropFilterAuthoringPath("apps/desktop/src/example.test.ts"),
    false
  );
  assert.equal(
    isBackdropFilterAuthoringPath("packages/example/dist/styles.css"),
    false
  );
  assert.equal(
    isBackdropFilterAuthoringPath("tools/fixtures/negative.css"),
    false
  );
});

test("artifact policy accepts standard-only and correct generated ordering", () => {
  for (const css of [
    ".overlay{backdrop-filter:blur(2px)}",
    ".overlay{-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}"
  ]) {
    assert.deepEqual(
      analyzeBackdropFilterArtifact({ path: "asset.css", css }).diagnostics,
      []
    );
  }
});

test("artifact policy rejects prefix-only and reversed final ordering", () => {
  const prefixOnly = analyzeBackdropFilterArtifact({
    path: "prefix-only.css",
    css: ".overlay{-webkit-backdrop-filter:blur(2px)}"
  }).diagnostics;
  assert.equal(prefixOnly[0]?.kind, "prefix-only-artifact");
  assert.equal(prefixOnly[0]?.selector, ".overlay");

  const reversed = analyzeBackdropFilterArtifact({
    path: "reversed.css",
    css: ".overlay{backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}"
  }).diagnostics;
  assert.equal(reversed[0]?.kind, "artifact-declaration-order");

  const mixedCase = analyzeBackdropFilterArtifact({
    path: "mixed-case.css",
    css: ".overlay{-Webkit-Backdrop-Filter:blur(2px)}"
  }).diagnostics;
  assert.equal(mixedCase[0]?.kind, "prefix-only-artifact");
});

test("artifact policy handles nested at-rules, comments, and strings", () => {
  const css = [
    "@media (min-width: 1px) {",
    "  .overlay {",
    '    content: "{-webkit-backdrop-filter: none}";',
    "    /* -webkit-backdrop-filter: none; */",
    "    -webkit-backdrop-filter: blur(2px);",
    "    backdrop-filter: blur(2px);",
    "  }",
    "}"
  ].join("\n");

  assert.deepEqual(
    analyzeBackdropFilterArtifact({ path: "nested.css", css }).diagnostics,
    []
  );
});

test("artifact policy handles escaped quotes in generated selectors", () => {
  const css = [
    String.raw`.before\:content-\[\'\'\]::before{content:""}`,
    ".workspace-launchpad-overlay__dismiss{backdrop-filter:blur(24px)}"
  ].join("\n");

  assert.deepEqual(
    analyzeBackdropFilterArtifacts([{ path: "generated.css", css }]),
    []
  );
});

test("artifact locations stay correct after astral characters", () => {
  const diagnostics = analyzeBackdropFilterArtifact({
    path: "emoji.css",
    css: '.emoji::before{content:"🧪";-webkit-backdrop-filter:blur(2px)}'
  }).diagnostics;

  assert.equal(diagnostics[0]?.kind, "prefix-only-artifact");
  assert.equal(diagnostics[0]?.token, "-webkit-backdrop-filter");
});

test("launchpad contract requires a non-none standard declaration", () => {
  const valid = [
    {
      path: "valid.css",
      css: ".workspace-launchpad-overlay__dismiss{-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px)}"
    }
  ];
  assert.deepEqual(analyzeBackdropFilterArtifacts(valid), []);

  for (const css of [
    ".workspace-launchpad-overlay__dismiss{backdrop-filter:none}",
    ".other{backdrop-filter:blur(24px)}"
  ]) {
    const diagnostics = analyzeBackdropFilterArtifacts([
      { path: "invalid.css", css }
    ]);
    assert.equal(
      diagnostics.some(
        (diagnostic) => diagnostic.kind === "missing-launchpad-backdrop-filter"
      ),
      true
    );
  }
});
