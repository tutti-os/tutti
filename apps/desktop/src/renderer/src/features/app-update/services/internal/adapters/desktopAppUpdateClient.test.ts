import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopUpdateApi } from "@preload/types";
import type { AppUpdateState } from "@shared/contracts/ipc";
import { createDesktopAppUpdateClient } from "./desktopAppUpdateClient.ts";

test("desktop app update client unwraps IPC success envelopes defensively", async () => {
  const state = createState({
    currentVersion: "0.0.1-rc.16",
    latestVersion: "0.0.1-rc.17",
    status: "available"
  });
  const client = createDesktopAppUpdateClient({
    async getState() {
      return {
        data: state,
        ok: true
      } as unknown as AppUpdateState;
    }
  } as DesktopUpdateApi);

  assert.deepEqual(await client.getState(), state);
});

test("desktop app update client unwraps nested data envelopes", async () => {
  const state = createState({
    currentVersion: "0.0.1-rc.16",
    latestVersion: "0.0.1-rc.17",
    status: "available"
  });
  const client = createDesktopAppUpdateClient({
    async getState() {
      return {
        data: {
          data: state,
          ok: true
        }
      } as unknown as AppUpdateState;
    }
  } as DesktopUpdateApi);

  assert.deepEqual(await client.getState(), state);
});

test("desktop app update client reports normalized state diagnostics", async () => {
  const diagnosticDetails: Record<string, unknown>[] = [];
  const state = createState({
    currentVersion: "0.0.1-rc.16",
    latestVersion: "0.0.1-rc.17",
    status: "available"
  });
  const client = createDesktopAppUpdateClient(
    {
      async getState() {
        return {
          data: state
        } as unknown as AppUpdateState;
      }
    } as DesktopUpdateApi,
    {
      logStateNormalized(details) {
        diagnosticDetails.push(details);
      }
    }
  );

  assert.deepEqual(await client.getState(), state);
  assert.deepEqual(diagnosticDetails, [
    {
      normalizedCurrentVersion: "0.0.1-rc.16",
      normalizedLatestVersion: "0.0.1-rc.17",
      normalizedStatus: "available",
      operation: "getState",
      rawHasData: true,
      rawKeys: ["data"],
      rawOk: null
    }
  ]);
});

function createState(overrides: Partial<AppUpdateState>): AppUpdateState {
  return {
    channel: "stable",
    checkedAt: null,
    currentVersion: "0.0.0",
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
