import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createDesktopAppServices,
  type CreateDesktopAppServicesOptions
} from "./desktopAppServices.ts";
import type { DesktopDaemonRuntime } from "./desktopDaemonRuntime";
import type { DesktopHostServices } from "./desktopHostServices";
import type { DesktopLogger } from "./logging";
import type { AppUpdateService } from "./update/appUpdateService";
import { defaultDesktopWorkbenchShortcuts } from "../shared/preferences/index.ts";

function createLogger(events: string[]): DesktopLogger {
  return {
    debug() {},
    info() {},
    warn(message) {
      events.push(`warn:${message}`);
    },
    error(message) {
      events.push(`error:${message}`);
    },
    async close() {}
  };
}

function createOptions(events: string[]): CreateDesktopAppServicesOptions {
  return {
    fallbackLocale: "en",
    logger: createLogger(events),
    preloadPath: "/tmp/preload.mjs",
    rendererUrl: "http://127.0.0.1:5173"
  };
}

function createHostServices(): DesktopHostServices {
  return {
    fileDialogs: {
      async selectAppArchive() {
        throw new Error("not used");
      },
      async selectAppArchiveExportPath() {
        throw new Error("not used");
      },
      async selectAppIconImage() {
        throw new Error("not used");
      },
      async selectDirectory() {
        throw new Error("not used");
      },
      async selectUploadFiles() {
        throw new Error("not used");
      }
    },
    preferences: {
      getAgentComposerDefaultsByProvider() {
        return {};
      },
      getAgentGUIConversationRailCollapsedByProvider() {
        return {};
      },
      getAgentConversationDetailMode() {
        return "coding";
      },
      getAppCatalogChannel() {
        return "production";
      },
      getDefaultAgentProvider() {
        return "codex";
      },
      getFeatureFlags() {
        return {};
      },
      getBrowserUseConnectionMode() {
        return "isolated";
      },
      getDockIconStyle() {
        return "default";
      },
      getDockPlacement() {
        return "bottom";
      },
      getFileDefaultOpenersByExtension() {
        return { html: "defaultBrowser" };
      },
      getLocale() {
        return "en";
      },
      getMinimizeAnimation() {
        return "scale";
      },
      getSleepPreventionMode() {
        return "never";
      },
      getThemeSource() {
        return "system";
      },
      getUpdateChannel() {
        return "stable";
      },
      getUpdatePolicy() {
        return "prompt";
      },
      getWorkbenchShortcuts() {
        return defaultDesktopWorkbenchShortcuts;
      },
      getWorkbenchWindowSnapping() {
        return {
          enabled: false,
          shortcutPreset: "commandArrows"
        };
      },
      subscribe() {
        return () => undefined;
      },
      sync() {
        return undefined;
      }
    },
    workspaceLaunch: {
      async openStartupWindow() {},
      async replaceWorkspaceWindow() {},
      async showAgentWindow() {},
      async showWorkspace() {}
    }
  };
}

function createUpdateService(): AppUpdateService {
  return {
    async checkForUpdates() {
      throw new Error("not used");
    },
    async configure() {
      throw new Error("not used");
    },
    dispose() {},
    async downloadUpdate() {
      throw new Error("not used");
    },
    getState() {
      throw new Error("not used");
    },
    async installUpdate() {
      throw new Error("not used");
    },
    isQuitAndInstallPending() {
      return false;
    },
    onStateChanged() {
      return () => undefined;
    }
  };
}

test("createDesktopAppServices does not wait for the CLI shim before creating host services", async () => {
  const events: string[] = [];
  let finishCliShim: (() => void) | undefined;
  const daemonRuntime: DesktopDaemonRuntime = {
    daemonEndpoint: {
      accessToken: "token",
      boundAddr: null,
      listenerInfoPath: "/tmp/tuttid.listener.json",
      pidPath: "/tmp/tuttid.pid",
      requestedAddr: "127.0.0.1:0"
    },
    tuttid: {
      async getHealth() {
        throw new Error("not used");
      },
      async start() {
        events.push("tuttid:start");
      },
      async stop() {}
    },
    tuttidClient: {
      async createWorkspace() {
        throw new Error("not used");
      },
      async getStartupWorkspace() {
        throw new Error("not used");
      },
      async listWorkspaces() {
        throw new Error("not used");
      },
      async openWorkspace() {
        throw new Error("not used");
      }
    } as unknown as DesktopDaemonRuntime["tuttidClient"]
  };

  const services = await createDesktopAppServices(createOptions(events), {
    createDaemonRuntime() {
      events.push("daemon-runtime:create");
      return daemonRuntime;
    },
    async createHostServices() {
      events.push("host-services:create");
      return createHostServices();
    },
    createUpdateService() {
      events.push("update-service:create");
      return createUpdateService();
    },
    ensureCliShim() {
      events.push("cli-shim:ensure");
      return new Promise((resolve) => {
        finishCliShim = () =>
          resolve({
            installed: false,
            pathShimPath: "/tmp/bin/tutti",
            shimPath: "/tmp/tutti/bin/tutti"
          });
      });
    }
  });

  assert.deepEqual(events, [
    "daemon-runtime:create",
    "update-service:create",
    "tuttid:start",
    "cli-shim:ensure",
    "host-services:create"
  ]);
  assert.equal(services.tuttid, daemonRuntime.tuttid);
  assert.equal(services.tuttidClient, daemonRuntime.tuttidClient);
  assert.ok(finishCliShim);
  finishCliShim();
  await new Promise((resolve) => setImmediate(resolve));
});

test("createDesktopAppServices rejects when managed tuttid fails to start", async () => {
  const events: string[] = [];
  const startError = new Error("listener info timeout");
  const dir = await mkdtemp(join(tmpdir(), "tutti-desktop-services-"));
  const startupFailureQueuePath = join(dir, "startup-failures.jsonl");
  const daemonRuntime: DesktopDaemonRuntime = {
    daemonEndpoint: {
      accessToken: "token",
      boundAddr: null,
      listenerInfoPath: "/tmp/tuttid.listener.json",
      pidPath: "/tmp/tuttid.pid",
      requestedAddr: "127.0.0.1:0"
    },
    tuttid: {
      async getHealth() {
        throw new Error("not used");
      },
      async start() {
        events.push("tuttid:start");
        throw startError;
      },
      async stop() {}
    },
    tuttidClient: {} as DesktopDaemonRuntime["tuttidClient"]
  };

  await assert.rejects(
    createDesktopAppServices(
      {
        ...createOptions(events),
        startupFailureQueuePath
      },
      {
        createDaemonRuntime() {
          events.push("daemon-runtime:create");
          return daemonRuntime;
        },
        async createHostServices() {
          events.push("host-services:create");
          return createHostServices();
        },
        createUpdateService() {
          events.push("update-service:create");
          return createUpdateService();
        },
        ensureCliShim() {
          events.push("cli-shim:ensure");
          return {
            installed: false,
            pathShimPath: null,
            shimPath: "/tmp/tutti/bin/tutti"
          };
        }
      }
    ),
    startError
  );

  assert.deepEqual(events, [
    "daemon-runtime:create",
    "update-service:create",
    "tuttid:start",
    "error:failed to start managed tuttid"
  ]);
  const queued = await readFile(startupFailureQueuePath, "utf8");
  assert.match(queued, /"name":"daemon.startup_failed"/);
});
