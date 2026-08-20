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

const windowsWorkflows = [
  {
    expectedPaths: ["apps/desktop/**", "services/tuttid/builtin-apps/**"],
    path: ".github/workflows/windows-desktop-alpha.yml"
  },
  {
    expectedPaths: ["packages/agent/daemon/**"],
    expectedSetupSteps: ["Setup Go", "Setup Node"],
    path: ".github/workflows/windows-agent-adapters.yml"
  },
  {
    expectedPaths: ["packages/agent/daemon/**", "services/tuttid/**"],
    expectedSetupSteps: ["Setup pnpm", "Setup Node.js", "Setup Go"],
    path: ".github/workflows/windows-daemon-adapters.yml"
  }
].map((config) => ({
  ...config,
  workflow: YAML.parse(readFileSync(join(workspaceRoot, config.path), "utf8"))
}));

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
  assert.match(classificationStep.run, /--base/u);
  assert.match(classificationStep.run, /--head/u);
  for (const group of ["contracts", "generated", "boundaries"]) {
    assert.match(toolingScripts, new RegExp(`--group ${group}`, "u"));
  }
  assert.match(toolingScripts, /--head/u);
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

test("Windows workflows route source changes without self-triggering", () => {
  for (const { expectedPaths, path, workflow } of windowsWorkflows) {
    const paths = workflow.on?.pull_request?.paths ?? [];
    assert.ok(paths.length > 0, path);
    assert.ok(!paths.includes(path), `${path} must not trigger itself`);
    for (const expectedPath of expectedPaths) {
      assert.ok(paths.includes(expectedPath), `${path}: ${expectedPath}`);
    }
  }
});

test("Windows Desktop Alpha packages only packaging-relevant changes", () => {
  const { workflow } = windowsWorkflows[0];
  const [job] = Object.values(workflow.jobs);
  const classification = job.steps.find(
    (step) => step.name === "Classify changed files"
  );
  const bundleBuild = job.steps.find(
    (step) => step.name === "Build Windows Desktop bundles"
  );
  const installerBuild = job.steps.find(
    (step) => step.name === "Build unsigned Windows NSIS package"
  );
  const packagedSmoke = job.steps.find(
    (step) =>
      step.name === "Smoke test packaged Workspace App shell and Onboarding"
  );
  const installerUpload = job.steps.find(
    (step) => step.name === "Upload Windows installer"
  );
  const packageCondition =
    "github.event_name == 'workflow_dispatch' || steps.changed-files.outputs.build_windows_installer == 'true'";

  assert.match(
    classification.run,
    /tools\/scripts\/change-classification\.mjs/u
  );
  assert.equal(
    bundleBuild.if,
    "github.event_name == 'pull_request' && steps.changed-files.outputs.build_windows_installer != 'true'"
  );
  assert.match(bundleBuild.run, /@tutti-os\/desktop build$/u);
  assert.equal(installerBuild.if, packageCondition);
  assert.match(installerBuild.run, /@tutti-os\/desktop build:win:prepared/u);
  assert.equal(packagedSmoke.if, packageCondition);
  assert.equal(installerUpload.if, packageCondition);
});

test("Windows adapter workflows warm default-branch caches", () => {
  for (const { expectedPaths, path, workflow } of windowsWorkflows.filter(
    ({ expectedSetupSteps }) => expectedSetupSteps
  )) {
    assert.deepEqual(workflow.on?.push?.branches, ["main"], path);
    assert.deepEqual(workflow.on?.push?.paths, expectedPaths, path);
  }
});

test("Windows adapter workflows keep setup and tests scoped", () => {
  for (const { expectedSetupSteps, path, workflow } of windowsWorkflows.filter(
    ({ expectedSetupSteps }) => expectedSetupSteps
  )) {
    const [job] = Object.values(workflow.jobs);
    const checkout = job.steps.find((step) => step.name === "Checkout");
    const setupSteps = job.steps
      .filter((step) => step.name?.startsWith("Setup "))
      .map((step) => step.name);
    const goTestCommands = stepScripts(job)
      .split("\n")
      .filter((line) => line.trimStart().startsWith("go test "));

    assert.deepEqual(setupSteps, expectedSetupSteps, path);
    assert.equal(checkout.with?.["fetch-depth"], undefined, path);
    assert.equal(goTestCommands.length, 1, path);
  }
});

function stepScripts(job) {
  return job.steps.map((step) => step.run ?? "").join("\n");
}
