import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFixScope,
  fixScopeChangedLineThreshold,
  hasFixScopeJustification,
  isImplementationNumstatPath,
  isFixTitle,
  sumNumstatChangedLines
} from "./check-fix-scope.mjs";

test("recognizes conventional fix titles", () => {
  assert.equal(isFixTitle("fix: queue drain race"), true);
  assert.equal(isFixTitle("fix(agent-gui): stale busy state"), true);
  assert.equal(isFixTitle("Fix(agent-gui)!: breaking correction"), true);
  assert.equal(isFixTitle("hotfix: broken release"), true);
  assert.equal(isFixTitle("feat: add composer setting"), false);
  assert.equal(isFixTitle("refactor: fix-ups after review"), false);
  assert.equal(isFixTitle("prefix: not a fix"), false);
});

test("classifies implementation paths for fix-scope line counts", () => {
  assert.equal(
    isImplementationNumstatPath("services/tuttid/service/a.go"),
    true
  );
  assert.equal(isImplementationNumstatPath("apps/desktop/src/a.tsx"), true);
  assert.equal(isImplementationNumstatPath("docs/architecture/a.md"), false);
  assert.equal(isImplementationNumstatPath("README.md"), false);
  assert.equal(
    isImplementationNumstatPath("services/tuttid/service/a_test.go"),
    false
  );
  assert.equal(
    isImplementationNumstatPath("packages/agent/gui/a.spec.tsx"),
    false
  );
  assert.equal(
    isImplementationNumstatPath("packages/agent/gui/__snapshots__/a.snap"),
    false
  );
  assert.equal(
    isImplementationNumstatPath("services/tuttid/api/generated/types.gen.go"),
    false
  );
});

test("sums implementation additions and deletions and skips binary/support entries", () => {
  const numstat = [
    "10\t2\tpackages/agent/gui/a.ts",
    "0\t5\tpackages/agent/gui/b.ts",
    "100\t20\tdocs/architecture/agent-extensions.md",
    "30\t10\tpackages/agent/gui/a.spec.tsx",
    "40\t8\tservices/tuttid/service/a_test.go",
    "50\t4\tservices/tuttid/api/generated/types.gen.go",
    "-\t-\tassets/icon.png",
    "not a numstat line"
  ].join("\n");
  assert.equal(sumNumstatChangedLines(numstat), 17);
});

test("detects fix-scope justification markers in English and Chinese", () => {
  assert.equal(
    hasFixScopeJustification(
      "Root cause: stale turn id. Why not at a lower layer: daemon owns it."
    ),
    true
  );
  assert.equal(
    hasFixScopeJustification(
      "根因:队列竞态;为什么不能在更底层修:协议缺 turn 实体"
    ),
    true
  );
  assert.equal(hasFixScopeJustification("Root cause only"), false);
  assert.equal(hasFixScopeJustification(""), false);
});

test("passes non-fix PRs and small fixes without justification", () => {
  assert.deepEqual(
    evaluateFixScope({ body: "", changedLines: 5000, title: "feat: big" }),
    { ok: true, reason: "not-a-fix" }
  );
  assert.deepEqual(
    evaluateFixScope({
      body: "",
      changedLines: fixScopeChangedLineThreshold,
      title: "fix: small"
    }),
    { ok: true, reason: "within-threshold" }
  );
});

test("requires justification for large fixes", () => {
  const large = fixScopeChangedLineThreshold + 1;
  assert.deepEqual(
    evaluateFixScope({ body: "", changedLines: large, title: "fix: big" }),
    { ok: false, reason: "missing-justification" }
  );
  assert.deepEqual(
    evaluateFixScope({
      body: "Root cause: X. Cannot fix at a lower layer because Y.",
      changedLines: large,
      title: "fix: big"
    }),
    { ok: true, reason: "justified" }
  );
});
