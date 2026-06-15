import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { DesktopApi } from "@preload/types";
import type { AppUpdateState } from "@shared/contracts/ipc";
import type { IAppUpdateService } from "./appUpdateService.interface.ts";
import { registerAppUpdateServices } from "./registerAppUpdateServices.ts";

test("registerAppUpdateServices hydrates update state immediately", async () => {
  let getStateCalls = 0;
  const diagnosticEvents: string[] = [];
  const registeredServices: IAppUpdateService[] = [];

  registerAppUpdateServices(
    {
      registerInstance(_key: unknown, service: unknown) {
        registeredServices.push(service as IAppUpdateService);
      }
    } as unknown as ServiceRegistry,
    createDesktopApi(
      {
        async getState() {
          getStateCalls += 1;
          return createState({
            currentVersion: "0.0.1-rc.16",
            latestVersion: "0.0.1-rc.17",
            status: "available"
          });
        }
      },
      diagnosticEvents
    )
  );

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(getStateCalls, 1);
  const registeredService = registeredServices.at(0) ?? null;
  assertRegisteredService(registeredService);
  assert.equal(
    registeredService.store.updateState?.currentVersion,
    "0.0.1-rc.16"
  );
  assert.equal(
    registeredService.store.updateState?.latestVersion,
    "0.0.1-rc.17"
  );
  assert.equal(registeredService.store.updateState?.status, "available");
  assert.deepEqual(diagnosticEvents, [
    "app_update.service_registered",
    "app_update.load_started",
    "app_update.subscription_started",
    "app_update.state_normalized",
    "app_update.state_applied",
    "app_update.load_succeeded"
  ]);
});

function assertRegisteredService(
  service: IAppUpdateService | null
): asserts service is IAppUpdateService {
  assert.ok(service);
}

function createDesktopApi(
  updateOverrides: Partial<DesktopApi["update"]>,
  diagnosticEvents: string[] = []
): DesktopApi {
  return {
    runtime: {
      async logRendererDiagnostic(input) {
        diagnosticEvents.push(input.event);
      }
    },
    update: {
      async checkForUpdates() {
        return createState({ status: "up_to_date" });
      },
      async configure() {
        return createState({ status: "idle" });
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
      ...updateOverrides
    }
  } as DesktopApi;
}

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
