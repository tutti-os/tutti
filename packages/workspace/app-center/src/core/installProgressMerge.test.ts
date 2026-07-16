import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePendingInstallProgress } from "./installProgressMerge.ts";

test("reconcilePendingInstallProgress advances stale downloading progress during starting", () => {
  const progress = reconcilePendingInstallProgress({
    incoming: null,
    previous: {
      downloadedBytes: 1024,
      indeterminate: false,
      overallPercent: 72,
      totalBytes: 2048,
      userPhase: "downloading"
    },
    runtimeStatus: "starting"
  });

  assert.equal(progress?.userPhase, "starting");
  assert.equal(progress?.overallPercent, 96);
  assert.equal(progress?.downloadedBytes, null);
  assert.equal(progress?.totalBytes, null);
});

test("reconcilePendingInstallProgress keeps fresher server progress", () => {
  const progress = reconcilePendingInstallProgress({
    incoming: {
      downloadedBytes: null,
      indeterminate: false,
      overallPercent: 98,
      totalBytes: null,
      userPhase: "starting"
    },
    previous: {
      downloadedBytes: 1024,
      indeterminate: false,
      overallPercent: 72,
      totalBytes: 2048,
      userPhase: "downloading"
    },
    runtimeStatus: "starting"
  });

  assert.equal(progress?.userPhase, "starting");
  assert.equal(progress?.overallPercent, 98);
});

test("reconcilePendingInstallProgress creates progress from runtime phase when none was reported", () => {
  const progress = reconcilePendingInstallProgress({
    incoming: null,
    previous: null,
    runtimeStatus: "starting"
  });

  assert.equal(progress?.userPhase, "starting");
  assert.equal(progress?.overallPercent, 0);
  assert.equal(progress?.indeterminate, true);
  assert.equal(progress?.downloadedBytes, null);
  assert.equal(progress?.totalBytes, null);
});

test("reconcilePendingInstallProgress never invents a percentage for indeterminate progress", () => {
  const progress = reconcilePendingInstallProgress({
    incoming: null,
    previous: {
      downloadedBytes: 1024,
      indeterminate: true,
      overallPercent: 40,
      totalBytes: 2048,
      userPhase: "downloading"
    },
    runtimeStatus: "starting"
  });

  assert.equal(progress?.userPhase, "starting");
  assert.equal(progress?.overallPercent, 40);
  assert.equal(progress?.indeterminate, true);
  assert.equal(progress?.downloadedBytes, null);
  assert.equal(progress?.totalBytes, null);
});
