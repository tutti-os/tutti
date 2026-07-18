import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyChangedFiles,
  formatClassificationSummary,
  formatGitHubOutput
} from "./change-classification.mjs";

const noChecks = {
  runGo: false,
  runPack: false,
  runTooling: false,
  runTs: false
};

test("documentation and styles do not select code validation", () => {
  assert.deepEqual(
    classifyChangedFiles(["README.md", "packages/ui/system/src/button.css"]),
    noChecks
  );
});

test("TypeScript paths select TypeScript and package validation", () => {
  assert.deepEqual(
    classifyChangedFiles(["packages/ui/system/src/button.tsx"]),
    {
      ...noChecks,
      runPack: true,
      runTs: true
    }
  );
  assert.deepEqual(
    classifyChangedFiles(["packages/configs/typescript/base.json"]),
    {
      ...noChecks,
      runPack: true,
      runTs: true
    }
  );
});

test("Go paths select Go and tooling validation", () => {
  assert.deepEqual(
    classifyChangedFiles(["packages\\agent\\host\\session.go"]),
    {
      ...noChecks,
      runGo: true,
      runTooling: true
    }
  );
});

test("nested package manifests select package validation", () => {
  assert.deepEqual(classifyChangedFiles(["packages/agent/gui/package.json"]), {
    ...noChecks,
    runPack: true
  });
});

test("validation tooling changes conservatively select every domain", () => {
  const allChecks = {
    runGo: true,
    runPack: true,
    runTooling: true,
    runTs: true
  };
  for (const path of [
    ".github/workflows/pr-checks.yml",
    "tools/scripts/change-classification.mjs",
    "services/tuttid/.golangci-lint-version"
  ]) {
    assert.deepEqual(classifyChangedFiles([path]), allChecks, path);
  }
});

test("GitHub output preserves workflow output names", () => {
  const classification = {
    runGo: true,
    runPack: false,
    runTooling: true,
    runTs: false
  };
  const output = [
    "run_go=true",
    "run_pack=false",
    "run_tooling=true",
    "run_ts=false"
  ].join("\n");

  assert.equal(formatGitHubOutput(classification), output);
  assert.equal(
    formatClassificationSummary(classification),
    `change classification: ${output.replaceAll("\n", " ")}`
  );
});
