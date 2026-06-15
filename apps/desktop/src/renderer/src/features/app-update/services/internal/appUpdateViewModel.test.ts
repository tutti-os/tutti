import assert from "node:assert/strict";
import test from "node:test";
import type { AppUpdateState } from "@shared/contracts/ipc";
import { resolveAppUpdateViewState } from "./appUpdateViewModel.ts";

function createUpdateState(
  overrides: Partial<AppUpdateState> = {}
): AppUpdateState {
  return {
    channel: "stable",
    checkedAt: null,
    currentVersion: "1.0.0",
    downloadedBytes: null,
    downloadPercent: null,
    latestVersion: null,
    message: null,
    policy: "prompt",
    releaseDate: null,
    releaseName: null,
    releaseNotesUrl: null,
    status: "idle",
    totalBytes: null,
    ...overrides
  };
}

test("resolveAppUpdateViewState hides non-actionable statuses", () => {
  for (const status of [
    "disabled",
    "error",
    "idle",
    "unsupported",
    "up_to_date"
  ] as const) {
    const view = resolveAppUpdateViewState(createUpdateState({ status }));

    assert.equal(view.visible, false);
    assert.equal(view.action, null);
    assert.equal(view.titleKey, null);
  }
});

test("resolveAppUpdateViewState maps available updates to download action", () => {
  const view = resolveAppUpdateViewState(
    createUpdateState({
      latestVersion: "1.2.0",
      status: "available"
    })
  );

  assert.equal(view.visible, true);
  assert.equal(view.tone, "info");
  assert.equal(view.busy, false);
  assert.equal(view.icon, "spark");
  assert.equal(view.titleKey, "updates.availableTitle");
  assert.equal(view.titleParams, undefined);
  assert.equal(view.action, "download");
  assert.equal(view.actionKey, "updates.downloadAction");
});

test("resolveAppUpdateViewState normalizes downloading progress", () => {
  const view = resolveAppUpdateViewState(
    createUpdateState({
      downloadPercent: 144.6,
      latestVersion: "1.2.0",
      status: "downloading"
    })
  );

  assert.equal(view.visible, true);
  assert.equal(view.busy, true);
  assert.equal(view.icon, "loading");
  assert.equal(view.progressPercent, 100);
  assert.equal(view.titleKey, "updates.downloadingTitle");
  assert.deepEqual(view.titleParams, {
    percent: "100%"
  });
  assert.equal(view.action, null);
});

test("resolveAppUpdateViewState maps downloaded updates to install action", () => {
  const view = resolveAppUpdateViewState(
    createUpdateState({
      latestVersion: "1.2.0",
      status: "downloaded"
    })
  );

  assert.equal(view.visible, true);
  assert.equal(view.titleKey, "updates.downloadedTitle");
  assert.equal(view.titleParams, undefined);
  assert.equal(view.action, "install");
  assert.equal(view.actionKey, "updates.restartAction");
});

test("resolveAppUpdateViewState folds local action state into busy state", () => {
  const view = resolveAppUpdateViewState(
    createUpdateState({
      status: "available"
    }),
    true
  );

  assert.equal(view.visible, true);
  assert.equal(view.busy, true);
  assert.equal(view.icon, "loading");
});
