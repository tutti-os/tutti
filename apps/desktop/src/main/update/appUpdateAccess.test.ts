import assert from "node:assert/strict";
import test from "node:test";
import type { AppUpdateState } from "../../shared/contracts/ipc";
import { createAppUpdateAccess } from "./appUpdateAccess.ts";
import type { AppUpdateService } from "./appUpdateService";

function createAppUpdateState(): AppUpdateState {
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
    totalBytes: null
  };
}

function createAppUpdateServiceStub(): AppUpdateService {
  return {
    async checkForUpdates() {
      return createAppUpdateState();
    },
    async configure(input) {
      return { ...createAppUpdateState(), policy: input.policy };
    },
    dispose() {},
    async downloadUpdate() {
      return createAppUpdateState();
    },
    getState() {
      return createAppUpdateState();
    },
    async installUpdate() {},
    isQuitAndInstallPending() {
      return false;
    },
    onStateChanged() {
      return () => undefined;
    }
  };
}

test("app update access validates configure payloads before invoking the service", async () => {
  const access = createAppUpdateAccess(createAppUpdateServiceStub());

  const state = await access.configure({ channel: "stable", policy: "auto" });

  assert.equal(state.policy, "auto");
});

test("app update access rejects invalid configure payloads", async () => {
  const access = createAppUpdateAccess(createAppUpdateServiceStub());

  await assert.rejects(
    () => access.configure({ policy: "weekly" }),
    /update configure payload must include a valid policy/
  );
});

test("app update access rejects invalid update channels", async () => {
  const access = createAppUpdateAccess(createAppUpdateServiceStub());

  await assert.rejects(
    () => access.configure({ channel: "beta", policy: "auto" }),
    /update configure payload must include a valid channel/
  );
});
