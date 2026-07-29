import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = YAML.parse(
  readFileSync(join(workspaceRoot, ".github/workflows/pr-checks.yml"), "utf8")
);

test("PR checks route repository groups through shared scripts", () => {
  const changes = workflow.jobs.changes;
  const classificationStep = changes.steps.find(
    (step) => step.name === "Classify changed files"
  );
  const toolingScripts = stepScripts(workflow.jobs["tooling-consistency"]);

  assert.match(
    classificationStep.run,
    /tools\/scripts\/change-classification\.mjs/u
  );
  for (const group of ["contracts", "generated", "boundaries"]) {
    assert.match(toolingScripts, new RegExp(`--group ${group}`, "u"));
  }
});

test("language jobs do not own repository checks", () => {
  for (const jobName of [
    "ts-lint",
    "ts-test-shards",
    "ts-tests",
    "go-tests",
    "go-lint"
  ]) {
    assert.doesNotMatch(
      stepScripts(workflow.jobs[jobName]),
      /run-repository-checks|test:tools|pnpm check:/u,
      jobName
    );
  }
});

test("package pack CI receives the classified package subset", () => {
  const changes = workflow.jobs.changes;
  const packJob = workflow.jobs["npm-package-packs"];
  const packStep = packJob.steps.find(
    (step) => step.name === "Validate package tarballs"
  );

  assert.equal(
    changes.outputs.pack_packages,
    "${{ steps.changed-files.outputs.pack_packages }}"
  );
  assert.equal(
    packStep.env.PACK_PACKAGES,
    "${{ needs.changes.outputs.pack_packages }}"
  );
  assert.match(packStep.run, /--packages-json/u);
});

test("TypeScript Tests preserves its required context across package shards", () => {
  const changes = workflow.jobs.changes;
  const testJob = workflow.jobs["ts-tests"];
  const shardJob = workflow.jobs["ts-test-shards"];
  const testStep = shardJob.steps.find(
    (step) => step.name === "Run TypeScript tests"
  );
  const requireShardsStep = testJob.steps.find(
    (step) => step.name === "Require selected test shards"
  );

  assert.equal(testJob.name, "TypeScript Tests");
  assert.equal(testJob.if, "always()");
  assert.equal(
    changes.outputs.test_packages,
    "${{ steps.changed-files.outputs.test_packages }}"
  );
  assert.equal(
    changes.outputs.test_shards,
    "${{ steps.changed-files.outputs.test_shards }}"
  );
  assert.equal(
    shardJob.strategy.matrix.shard,
    "${{ fromJSON(needs.changes.outputs.test_shards) }}"
  );
  assert.equal(
    testStep.env.TEST_PACKAGES,
    "${{ needs.changes.outputs.test_packages }}"
  );
  assert.match(testStep.run, /--packages-json/u);
  assert.match(testStep.run, /--shard/u);
  assert.match(testStep.run, /--packages-json[^\n]*--shard/u);
  assert.equal(
    requireShardsStep.env.SHARDS_RESULT,
    "${{ needs.ts-test-shards.result }}"
  );
});

function stepScripts(job) {
  return job.steps.map((step) => step.run ?? "").join("\n");
}
