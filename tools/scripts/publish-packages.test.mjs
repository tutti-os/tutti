import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublishedVersionViewArguments,
  createPublishArguments,
  createReleaseGitEnvironment,
  formatPackageGoModuleReleaseTag,
  isPublishedVersionListed,
  normalizePublishedPackageVersions,
  publishPackageGroup,
  publishPackageWithRetry,
  resolvePackagePublishConcurrency,
  resolveReleaseTagNames,
  runWithConcurrency
} from "./publish-packages.mjs";

test("createPublishArguments omits provenance by default", () => {
  assert.deepEqual(createPublishArguments({ withProvenance: false }), [
    "publish",
    "--access",
    "public",
    "--tag",
    "latest",
    "--no-git-checks"
  ]);
});

test("createPublishArguments enables provenance when requested", () => {
  assert.deepEqual(createPublishArguments({ withProvenance: true }), [
    "publish",
    "--access",
    "public",
    "--tag",
    "latest",
    "--no-git-checks",
    "--provenance"
  ]);
});

test("createPublishedVersionViewArguments queries only the exact immutable version", () => {
  assert.deepEqual(
    createPublishedVersionViewArguments("@tutti-os/example", "0.0.25"),
    ["view", "@tutti-os/example@0.0.25", "version", "--json"]
  );
});

test("createReleaseGitEnvironment disables husky hooks for CI release pushes", () => {
  assert.equal(createReleaseGitEnvironment().HUSKY, "0");
});

test("formatPackageGoModuleReleaseTag uses Go submodule tag shape", () => {
  assert.equal(
    formatPackageGoModuleReleaseTag("packages/workbench/service", "0.0.25"),
    "packages/workbench/service/v0.0.25"
  );
});

test("formatPackageGoModuleReleaseTag rejects non-package directories", () => {
  assert.throws(
    () => formatPackageGoModuleReleaseTag("services/tuttid", "0.0.25"),
    /must be under packages/
  );
});

test("resolveReleaseTagNames includes package Go module tags", async () => {
  const tagNames = await resolveReleaseTagNames("0.0.25");

  assert.equal(tagNames[0], "packages-v0.0.25");
  assert.equal(
    [
      "packages/agent/activity-replication/v0.0.25",
      "packages/agent/store-sqlite/canonical/v0.0.25",
      "packages/appcli/core/v0.0.25",
      "packages/device-link/v0.0.25",
      "packages/workbench/service/v0.0.25",
      "packages/workspace/files/v0.0.25",
      "packages/workspace/issues/v0.0.25"
    ].every((tagName) => tagNames.includes(tagName)),
    true
  );
});

test("normalizePublishedPackageVersions accepts npm string and array outputs", () => {
  assert.deepEqual(normalizePublishedPackageVersions("0.0.1"), ["0.0.1"]);
  assert.deepEqual(normalizePublishedPackageVersions(["0.0.1", "0.0.2"]), [
    "0.0.1",
    "0.0.2"
  ]);
});

test("isPublishedVersionListed detects already published versions", () => {
  assert.equal(isPublishedVersionListed(["0.0.1", "0.0.2"], "0.0.1"), true);
  assert.equal(isPublishedVersionListed(["0.0.1", "0.0.2"], "0.0.3"), false);
});

test("resolvePackagePublishConcurrency defaults to four bounded workers", () => {
  assert.equal(resolvePackagePublishConcurrency(undefined), 4);
  assert.equal(resolvePackagePublishConcurrency("1"), 1);
  assert.equal(resolvePackagePublishConcurrency("8"), 8);
  assert.throws(
    () => resolvePackagePublishConcurrency("0"),
    /integer from 1 to 8/
  );
  assert.throws(
    () => resolvePackagePublishConcurrency("9"),
    /integer from 1 to 8/
  );
  assert.throws(
    () => resolvePackagePublishConcurrency("4.5"),
    /integer from 1 to 8/
  );
});

test("publishPackageGroup bounds concurrent publishes and skips existing versions", async () => {
  const packages = ["a", "b", "c", "existing"].map((name) => ({
    name: `@tutti-os/${name}`
  }));
  const published = [];
  let activePublishes = 0;
  let maximumActivePublishes = 0;
  let releaseFirstWave;
  const firstWave = new Promise((resolve) => {
    releaseFirstWave = resolve;
  });

  await publishPackageGroup({
    concurrency: 2,
    isPublished: async (name) => name === "@tutti-os/existing",
    packages,
    publish: async (packageConfig) => {
      activePublishes += 1;
      maximumActivePublishes = Math.max(
        maximumActivePublishes,
        activePublishes
      );
      if (maximumActivePublishes === 2) {
        releaseFirstWave();
      }
      await firstWave;
      published.push(packageConfig.name);
      activePublishes -= 1;
    },
    releaseVersion: "0.0.1"
  });

  assert.equal(maximumActivePublishes, 2);
  assert.deepEqual(published.sort(), [
    "@tutti-os/a",
    "@tutti-os/b",
    "@tutti-os/c"
  ]);
});

test("runWithConcurrency stops admitting work after failure and drains in-flight tasks", async () => {
  const expected = new Error("publish failed");
  const started = [];
  let inFlightFinished = false;
  let markSecondStarted;
  let markFailureTriggered;
  const secondStarted = new Promise((resolve) => {
    markSecondStarted = resolve;
  });
  const failureTriggered = new Promise((resolve) => {
    markFailureTriggered = resolve;
  });

  await assert.rejects(
    runWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) {
        await secondStarted;
        markFailureTriggered();
        throw expected;
      }
      if (item === 1) {
        markSecondStarted();
        await failureTriggered;
        await new Promise((resolve) => setImmediate(resolve));
        inFlightFinished = true;
      }
    }),
    expected
  );

  assert.deepEqual(started, [0, 1]);
  assert.equal(inFlightFinished, true);
});

test("publishPackageWithRetry retries a failed unpublished version", async () => {
  let attempts = 0;
  const waits = [];
  await publishPackageWithRetry({
    packageName: "@tutti-os/example",
    version: "0.0.1",
    async publish() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transparency log conflict");
      }
    },
    isPublished: async () => false,
    wait: async (attempt) => waits.push(attempt)
  });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1]);
});

test("publishPackageWithRetry accepts a version visible after an error", async () => {
  let attempts = 0;
  await publishPackageWithRetry({
    packageName: "@tutti-os/example",
    version: "0.0.1",
    publish() {
      attempts += 1;
      throw new Error("registry response was lost");
    },
    isPublished: () => true,
    wait: async () => assert.fail("published version must not be retried")
  });
  assert.equal(attempts, 1);
});

test("publishPackageWithRetry preserves the final publish error", async () => {
  const expected = new Error("permanent publish failure");
  let attempts = 0;
  await assert.rejects(
    publishPackageWithRetry({
      packageName: "@tutti-os/example",
      version: "0.0.1",
      maxAttempts: 2,
      publish() {
        attempts += 1;
        throw expected;
      },
      isPublished: () => false,
      wait: async () => {}
    }),
    expected
  );
  assert.equal(attempts, 2);
});
