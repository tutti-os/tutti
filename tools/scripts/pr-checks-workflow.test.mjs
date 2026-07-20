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
  for (const jobName of ["ts-lint", "ts-tests", "go-tests", "go-lint"]) {
    assert.doesNotMatch(
      stepScripts(workflow.jobs[jobName]),
      /run-repository-checks|test:tools|pnpm check:/u,
      jobName
    );
  }
});

function stepScripts(job) {
  return job.steps.map((step) => step.run ?? "").join("\n");
}
