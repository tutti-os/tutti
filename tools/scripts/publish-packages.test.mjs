import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublishArguments,
  createReleaseGitEnvironment,
  formatPackageGoModuleReleaseTag,
  isPublishedVersionListed,
  normalizePublishedPackageVersions,
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
