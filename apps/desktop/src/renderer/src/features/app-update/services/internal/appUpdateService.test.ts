import assert from "node:assert/strict";
import test from "node:test";
import type { AppUpdateState } from "@shared/contracts/ipc";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import type { DesktopAppUpdateClient } from "./adapters/desktopAppUpdateClient.ts";
import {
  AppUpdateService,
  resolveOfficialChangelogUrl
} from "./appUpdateService.ts";

test("AppUpdateService maps each desktop language to the official changelog", () => {
  assert.equal(
    resolveOfficialChangelogUrl("zh-CN"),
    "https://tutti.sh/zh/changelog"
  );
  assert.equal(
    resolveOfficialChangelogUrl("en"),
    "https://tutti.sh/en/changelog"
  );
});

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

test("AppUpdateService opens the official changelog for an available update", async () => {
  const opened: string[] = [];
  const releaseNotesUrl =
    "https://github.com/tutti-os/tutti/releases/tag/v1.3.0";
  const service = new AppUpdateService(
    createClient({
      getState: async () =>
        createState({ releaseNotesUrl, status: "available" })
    }),
    null,
    undefined,
    undefined,
    {
      hostFilesApi: {
        async openExternal(url) {
          opened.push(url);
        }
      }
    }
  );
  await service.load();

  await service.openReleaseNotes();

  assert.deepEqual(opened, ["https://tutti.sh/en/changelog"]);
});

test("AppUpdateService opens the official changelog without an IPC release-notes pointer", async () => {
  const opened: string[] = [];
  const service = new AppUpdateService(
    createClient({
      getState: async () =>
        createState({ releaseNotesUrl: null, status: "available" })
    }),
    null,
    undefined,
    undefined,
    {
      hostFilesApi: {
        async openExternal(url) {
          opened.push(url);
        }
      }
    }
  );
  await service.load();

  await service.openReleaseNotes();

  assert.deepEqual(opened, ["https://tutti.sh/en/changelog"]);
});

test("AppUpdateService reports an up-to-date manual check", async () => {
  const notifications: Array<{
    description?: string;
    title: string;
    type: string;
  }> = [];
  const service = new AppUpdateService(
    createClient({
      checkForUpdates: async () =>
        createState({ currentVersion: "1.2.3", status: "up_to_date" })
    }),
    null,
    undefined,
    undefined,
    {
      notifications: {
        error(input) {
          notifications.push({ ...input, type: "error" });
        },
        info(input) {
          notifications.push({ ...input, type: "info" });
        },
        success(input) {
          notifications.push({ ...input, type: "success" });
        }
      }
    }
  );

  await service.checkForUpdates();

  assert.deepEqual(notifications, [
    {
      description: "Tutti 1.2.3 is currently the latest version.",
      title: "You're up to date!",
      type: "info"
    }
  ]);
});

test("AppUpdateService reports an available manual update", async () => {
  const successes: Array<{ description?: string; title: string }> = [];
  const service = new AppUpdateService(
    createClient({
      checkForUpdates: async () => createState({ status: "available" })
    }),
    null,
    undefined,
    undefined,
    {
      notifications: {
        error() {},
        info() {},
        success(input) {
          successes.push(input);
        }
      }
    }
  );

  await service.checkForUpdates();

  assert.deepEqual(successes, [{ title: "Update to New Version" }]);
});

test("AppUpdateService reports a failed manual check", async () => {
  const errors: Array<{ description?: string; title: string }> = [];
  const service = new AppUpdateService(
    createClient({
      checkForUpdates: async () => {
        throw new Error("network unavailable");
      }
    }),
    null,
    undefined,
    undefined,
    {
      notifications: {
        error(input) {
          errors.push(input);
        },
        info() {},
        success() {}
      }
    }
  );

  await service.checkForUpdates();

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.title, "Unable to check for updates");
  assert.equal(
    errors[0]?.description,
    "An unexpected service error occurred. Please try again."
  );
});

test("AppUpdateService reports an unsupported manual check", async () => {
  const errors: Array<{ description?: string; title: string }> = [];
  const service = new AppUpdateService(
    createClient({
      checkForUpdates: async () =>
        createState({
          message: "Updates are unavailable in development.",
          status: "unsupported"
        })
    }),
    null,
    undefined,
    undefined,
    {
      notifications: {
        error(input) {
          errors.push(input);
        },
        info() {},
        success() {}
      }
    }
  );

  await service.checkForUpdates();

  assert.deepEqual(errors, [
    {
      description: "Updates are unavailable in development.",
      title: "Unable to check for updates"
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

test("AppUpdateService skips redundant subscription states", async () => {
  const diagnosticEvents: string[] = [];
  let emitState: ((state: AppUpdateState) => void) | null = null;
  const service = new AppUpdateService(
    createClient({
      getState: async () =>
        createState({
          downloadPercent: 5,
          downloadedBytes: 50,
          status: "downloading"
        }),
      onState(listener) {
        emitState = listener;
        return () => {};
      }
    }),
    null,
    undefined,
    {
      async logRendererDiagnostic(input) {
        diagnosticEvents.push(input.event);
      }
    }
  );

  await service.load();
  diagnosticEvents.length = 0;

  const nextState = createState({
    downloadPercent: 10,
    downloadedBytes: 100,
    status: "downloading"
  });
  const emit = emitState as ((state: AppUpdateState) => void) | null;
  assert.ok(emit);
  emit(nextState);
  emit(nextState);

  assert.deepEqual(
    diagnosticEvents.filter((event) => event === "app_update.state_applied"),
    ["app_update.state_applied"]
  );
  assert.ok(
    !diagnosticEvents.includes("app_update.subscription_state_received")
  );
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
