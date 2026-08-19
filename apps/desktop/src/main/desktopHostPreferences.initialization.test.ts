import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PutDesktopPreferencesRequest } from "@tutti-os/client-tuttid-ts";
import { defaultDesktopWorkbenchShortcuts } from "../shared/preferences/index.ts";
import { createDesktopHostPreferencesState } from "./desktopHostPreferences.ts";
import type { DesktopLogger } from "./logging.ts";

const standaloneAgentModeFlag = "workspace.standaloneAgentMode";

test("desktop preferences keep the legacy OS fallback when the initial identity read fails", async () => {
  let putCalls = 0;
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "en",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        throw new Error("read unavailable");
      },
      async putDesktopPreferences() {
        putCalls++;
        throw new Error("putDesktopPreferences should not be called");
      }
    }
  });

  assert.equal(state.getFeatureFlags()[standaloneAgentModeFlag], undefined);
  assert.equal(putCalls, 0);
});

test("desktop preferences keep a fresh Agent default when initialization fails before commit", async () => {
  let getCalls = 0;
  let capturedRequest: PutDesktopPreferencesRequest | undefined;
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "en",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        getCalls++;
        return {
          initialized: false,
          preferences: createPreferences({
            [standaloneAgentModeFlag]: true
          })
        };
      },
      async putDesktopPreferences(request) {
        capturedRequest = request;
        throw new Error("write failed before commit");
      }
    }
  });

  assert.equal(capturedRequest?.writeMode, "initializeIfAbsent");
  assert.equal(state.getFeatureFlags()[standaloneAgentModeFlag], true);
  assert.equal(getCalls, 2);
});

test("desktop preferences reconcile a lost initialization response with the committed Agent preference", async () => {
  let getCalls = 0;
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "en",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        getCalls++;
        return getCalls === 1
          ? {
              initialized: false,
              preferences: createPreferences({
                [standaloneAgentModeFlag]: true
              })
            }
          : {
              initialized: true,
              preferences: createPreferences({
                [standaloneAgentModeFlag]: true
              })
            };
      },
      async putDesktopPreferences() {
        throw new Error("response lost after commit");
      }
    }
  });

  assert.equal(state.getFeatureFlags()[standaloneAgentModeFlag], true);
  assert.equal(getCalls, 2);
});

test("desktop preferences preserve a concurrent existing OS preference after an ambiguous initialization", async () => {
  let getCalls = 0;
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "en",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        getCalls++;
        return getCalls === 1
          ? {
              initialized: false,
              preferences: createPreferences({
                [standaloneAgentModeFlag]: true
              })
            }
          : {
              initialized: true,
              preferences: createPreferences({
                [standaloneAgentModeFlag]: false
              })
            };
      },
      async putDesktopPreferences() {
        throw new Error("initialization outcome unknown");
      }
    }
  });

  assert.equal(state.getFeatureFlags()[standaloneAgentModeFlag], false);
  assert.equal(getCalls, 2);
});

test("desktop preferences retry failed initialization once before mutation and only then write the installed-version marker", async () => {
  const migrationStateRootDir = await mkdtemp(
    join(tmpdir(), "tutti-preferences-initialization-")
  );
  const installedVersionStatePath = join(
    migrationStateRootDir,
    "migrations",
    "desktop-update-channel-installed-version-v1"
  );
  let getCalls = 0;
  let putCalls = 0;
  let releaseRecovery: (() => void) | undefined;
  const recoveryBarrier = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const state = await createDesktopHostPreferencesState({
    appVersion: "0.2.2-rc.1",
    fallbackLocale: "en",
    isPackaged: true,
    logger: createLogger(),
    migrationStateRootDir,
    tuttidClient: {
      async getDesktopPreferences() {
        getCalls++;
        return {
          initialized: false,
          preferences: createPreferences({
            [standaloneAgentModeFlag]: true
          })
        };
      },
      async putDesktopPreferences(request) {
        putCalls++;
        if (putCalls === 1) {
          throw new Error("write failed before commit");
        }
        await recoveryBarrier;
        return {
          initialized: true,
          preferences: request.preferences
        };
      }
    }
  });

  await assert.rejects(readFile(installedVersionStatePath, "utf8"));

  const first = state.ensureInitialized();
  const second = state.ensureInitialized();
  await Promise.resolve();
  releaseRecovery?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, secondResult);
  assert.equal(firstResult.initialized, true);
  assert.equal(
    firstResult.preferences.featureFlags[standaloneAgentModeFlag],
    true
  );
  assert.equal(getCalls, 3);
  assert.equal(putCalls, 2);
  assert.equal(await readFile(installedVersionStatePath, "utf8"), "0.2.2-rc.1");
});

test("desktop preferences recover an unknown startup identity before initializing the Agent default", async () => {
  let getCalls = 0;
  let putCalls = 0;
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "en",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        getCalls++;
        if (getCalls === 1) {
          throw new Error("startup read unavailable");
        }
        return {
          initialized: false,
          preferences: createPreferences({
            [standaloneAgentModeFlag]: true
          })
        };
      },
      async putDesktopPreferences(request) {
        putCalls++;
        return {
          initialized: true,
          preferences: request.preferences
        };
      }
    }
  });

  assert.equal(state.getFeatureFlags()[standaloneAgentModeFlag], undefined);

  const recovered = await state.ensureInitialized();

  assert.equal(recovered.initialized, true);
  assert.equal(state.getFeatureFlags()[standaloneAgentModeFlag], true);
  assert.equal(getCalls, 2);
  assert.equal(putCalls, 1);
});

function createPreferences(
  featureFlags: Record<string, boolean>
): PutDesktopPreferencesRequest["preferences"] {
  return {
    agentCliUpdateCheckEnabled: true,
    agentComposerDefaultsByProvider: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
    appCatalogChannel: "production",
    browserUseConnectionMode: "isolated",
    defaultAgentProvider: "tutti-agent",
    deletedAgentConversationRetentionDays: 30,
    dockIconStyle: "default",
    dockPlacement: "bottom",
    featureFlags,
    fileDefaultOpenersByExtension: {},
    locale: "en",
    minimizeAnimation: "genie",
    showAppDeveloperSources: false,
    sleepPreventionMode: "never",
    themeSource: "dark",
    updateChannel: "stable",
    updatePolicy: "prompt",
    workbenchShortcuts: defaultDesktopWorkbenchShortcuts
  };
}

function createLogger(): DesktopLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    async close() {}
  };
}
