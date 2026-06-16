import assert from "node:assert/strict";
import test from "node:test";
import type { AppUpdateState } from "./ipc.ts";
import { isSameAppUpdateState } from "./appUpdateState.ts";

test("isSameAppUpdateState compares all AppUpdateState fields", () => {
  const base = createState();
  assert.equal(isSameAppUpdateState(base, { ...base }), true);
  assert.equal(
    isSameAppUpdateState(base, createState({ downloadPercent: 42 })),
    false
  );
  assert.equal(
    isSameAppUpdateState(base, createState({ downloadedBytes: 1024 })),
    false
  );
  assert.equal(
    isSameAppUpdateState(base, createState({ status: "downloading" })),
    false
  );
});

function createState(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    channel: "stable",
    checkedAt: null,
    currentVersion: "1.0.0",
    downloadedBytes: null,
    downloadPercent: null,
    latestVersion: "1.1.0",
    message: null,
    policy: "prompt",
    releaseDate: null,
    releaseName: null,
    releaseNotesUrl: null,
    status: "available",
    totalBytes: null,
    ...overrides
  };
}
