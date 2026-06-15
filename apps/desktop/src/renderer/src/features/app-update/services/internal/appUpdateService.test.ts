import assert from "node:assert/strict";
import test from "node:test";
import type { AppUpdateState } from "@shared/contracts/ipc";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import type { DesktopAppUpdateClient } from "./adapters/desktopAppUpdateClient.ts";
import { AppUpdateService } from "./appUpdateService.ts";

test("AppUpdateService does not report status changes from initial state hydration", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new AppUpdateService(
    createClient({
      getState: async () =>
        createState({
          latestVersion: "1.3.0",
          status: "available"
        })
    }),
    createReporterService(reporterCalls),
    () => 1749124800000
  );

  await service.load();

  assert.deepEqual(reporterCalls, []);
  assert.equal(service.store.updateState?.currentVersion, "1.0.0");
  assert.equal(service.store.updateState?.latestVersion, "1.3.0");
  assert.equal(service.store.updateState?.status, "available");
});

test("AppUpdateService tracks primary update actions", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new AppUpdateService(
    createClient({
      downloadUpdate: async () =>
        createState({
          latestVersion: "1.3.0",
          status: "downloading"
        }),
      getState: async () =>
        createState({
          latestVersion: "1.3.0",
          status: "available"
        })
    }),
    createReporterService(reporterCalls),
    () => 1749124800000
  );
  await service.load();

  await service.runPrimaryAction();

  assert.deepEqual(reporterCalls[0], [
    {
      clientTS: 1749124800000,
      name: "app_update.action_clicked",
      params: {
        action: "download",
        update_status: "available"
      }
    }
  ]);
});

test("AppUpdateService keeps install action pending after IPC succeeds", async () => {
  let installCalls = 0;
  const service = new AppUpdateService(
    createClient({
      getState: async () =>
        createState({
          latestVersion: "1.3.0",
          status: "downloaded"
        }),
      async installUpdate() {
        installCalls += 1;
      }
    })
  );
  await service.load();

  await service.runPrimaryAction();

  assert.equal(installCalls, 1);
  assert.equal(service.store.isActing, true);
  assert.equal(service.store.view.busy, true);
});

test("AppUpdateService reports when load state is skipped after disposal", async () => {
  const diagnosticEvents: string[] = [];
  let resolveGetState: ((state: AppUpdateState) => void) | null = null;
  const service = new AppUpdateService(
    createClient({
      getState: () =>
        new Promise<AppUpdateState>((resolve) => {
          resolveGetState = resolve;
        })
    }),
    null,
    undefined,
    {
      async logRendererDiagnostic(input) {
        diagnosticEvents.push(input.event);
      }
    }
  );

  const loadPromise = service.load();
  service.dispose();
  const resolveState = resolveGetState as
    | ((state: AppUpdateState) => void)
    | null;
  assert.ok(resolveState);
  resolveState(createState({ status: "available" }));
  await loadPromise;

  assert.equal(service.store.updateState, null);
  assert.ok(diagnosticEvents.includes("app_update.service_disposed"));
  assert.ok(diagnosticEvents.includes("app_update.state_apply_skipped"));
  assert.ok(!diagnosticEvents.includes("app_update.load_succeeded"));
});

function createClient(
  overrides: Partial<DesktopAppUpdateClient>
): DesktopAppUpdateClient {
  return {
    async checkForUpdates() {
      return createState({ status: "up_to_date" });
    },
    async downloadUpdate() {
      return createState({ status: "downloading" });
    },
    async getState() {
      return createState({ status: "idle" });
    },
    async installUpdate() {},
    onState() {
      return () => {};
    },
    ...overrides
  };
}

function createState(overrides: Partial<AppUpdateState>): AppUpdateState {
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

function createReporterService(calls: ReporterEventInput[][] = []) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      calls.push(events);
    }
  };
}
