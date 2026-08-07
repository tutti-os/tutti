import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublishArguments,
  createReleaseGitEnvironment,
  formatPackageGoModuleReleaseTag,
  isPublishedVersionListed,
  normalizePublishedPackageVersions,
  publishPackageWithRetry,
  resolveReleaseTagNames
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

test("publishPackageWithRetry retries a failed unpublished version", async () => {
  let attempts = 0;
  const waits = [];
  await publishPackageWithRetry({
    packageName: "@tutti-os/example",
    version: "0.0.1",
    publish() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("transparency log conflict");
      }
    },
    isPublished: () => false,
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
