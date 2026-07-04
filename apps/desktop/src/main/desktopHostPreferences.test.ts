import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PutDesktopPreferencesRequest } from "@tutti-os/client-tuttid-ts";
import { createDesktopHostPreferencesState } from "./desktopHostPreferences.ts";
import type { DesktopLogger } from "./logging.ts";

test("createDesktopHostPreferencesState initializes missing preferences with dark theme and default icons", async () => {
  const putRequests: PutDesktopPreferencesRequest[] = [];
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: false,
          preferences: {
            agentComposerDefaultsByProvider: {},
            agentGuiConversationRailCollapsedByProvider: {},
            agentConversationDetailMode: "coding",
            agentDockLayout: "legacySplit",
            appCatalogChannel: "production",
            browserUseConnectionMode: "isolated",
            defaultAgentProvider: "codex",

            dockIconStyle: "flat",
            dockPlacement: "bottom",
            fileDefaultOpenersByExtension: { html: "defaultBrowser" },
            locale: "en",
            minimizeAnimation: "scale",
            sleepPreventionMode: "never",
            showAppDeveloperSources: false,
            themeSource: "system",
            updateChannel: "stable",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences(request) {
        putRequests.push(request);
        return {
          initialized: true,
          preferences: request.preferences
        };
      }
    }
  });

  assert.deepEqual(putRequests, [
    {
      preferences: {
        agentComposerDefaultsByProvider: {},
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        agentDockLayout: "legacySplit",
        appCatalogChannel: "production",
        browserUseConnectionMode: "isolated",
        defaultAgentProvider: "codex",

        dockIconStyle: "default",
        dockPlacement: "bottom",
        fileDefaultOpenersByExtension: {
          htm: "appBrowser",
          html: "appBrowser",
          shtml: "appBrowser",
          xhtml: "appBrowser"
        },
        locale: "zh-CN",
        minimizeAnimation: "genie",
        sleepPreventionMode: "never",
        showAppDeveloperSources: false,
        themeSource: "dark",
        updateChannel: "stable",
        updatePolicy: "prompt"
      }
    }
  ]);
  assert.equal(state.getDockPlacement(), "bottom");
  assert.equal(state.getLocale(), "zh-CN");
  assert.equal(state.getDefaultAgentProvider(), "codex");
  assert.deepEqual(state.getAgentGUIConversationRailCollapsedByProvider(), {});
  assert.equal(state.getBrowserUseConnectionMode(), "isolated");
  assert.equal(state.getSleepPreventionMode(), "never");
  assert.equal(state.getDockIconStyle(), "default");
  assert.equal(state.getThemeSource(), "dark");
  assert.equal(state.getUpdateChannel(), "stable");
});

test("createDesktopHostPreferencesState defaults missing rc package preferences to rc updates", async () => {
  const putRequests: PutDesktopPreferencesRequest[] = [];
  const state = await createDesktopHostPreferencesState({
    appVersion: "0.1.6-rc.2",
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: false,
          preferences: {
            agentComposerDefaultsByProvider: {},
            agentGuiConversationRailCollapsedByProvider: {},
            agentConversationDetailMode: "coding",
            agentDockLayout: "legacySplit",
            appCatalogChannel: "production",
            browserUseConnectionMode: "isolated",
            defaultAgentProvider: "codex",

            dockIconStyle: "flat",
            dockPlacement: "bottom",
            fileDefaultOpenersByExtension: { html: "defaultBrowser" },
            locale: "en",
            minimizeAnimation: "scale",
            sleepPreventionMode: "never",
            showAppDeveloperSources: false,
            themeSource: "system",
            updateChannel: "stable",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences(request) {
        putRequests.push(request);
        return {
          initialized: true,
          preferences: request.preferences
        };
      }
    }
  });

  assert.equal(state.getUpdateChannel(), "rc");
  assert.equal(putRequests[0]?.preferences.updateChannel, "rc");
});

test("createDesktopHostPreferencesState keeps missing beta package preferences on stable updates", async () => {
  const putRequests: PutDesktopPreferencesRequest[] = [];
  const state = await createDesktopHostPreferencesState({
    appVersion: "0.1.7-beta.1",
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: false,
          preferences: {
            agentComposerDefaultsByProvider: {},
            agentGuiConversationRailCollapsedByProvider: {},
            agentConversationDetailMode: "coding",
            agentDockLayout: "legacySplit",
            appCatalogChannel: "production",
            browserUseConnectionMode: "isolated",
            defaultAgentProvider: "codex",

            dockIconStyle: "flat",
            dockPlacement: "bottom",
            fileDefaultOpenersByExtension: { html: "defaultBrowser" },
            locale: "en",
            minimizeAnimation: "scale",
            sleepPreventionMode: "never",
            showAppDeveloperSources: false,
            themeSource: "system",
            updateChannel: "rc",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences(request) {
        putRequests.push(request);
        return {
          initialized: true,
          preferences: request.preferences
        };
      }
    }
  });

  assert.equal(state.getUpdateChannel(), "stable");
  assert.equal(putRequests[0]?.preferences.updateChannel, "stable");
});

test("createDesktopHostPreferencesState keeps initialized theme preferences", async () => {
  let putCalls = 0;
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            agentGuiConversationRailCollapsedByProvider: {},
            agentConversationDetailMode: "coding",
            agentDockLayout: "legacySplit",
            appCatalogChannel: "production",
            browserUseConnectionMode: "isolated",
            defaultAgentProvider: "codex",

            dockIconStyle: "default",
            dockPlacement: "bottom",
            fileDefaultOpenersByExtension: { html: "defaultBrowser" },
            locale: "en",
            minimizeAnimation: "scale",
            sleepPreventionMode: "never",
            showAppDeveloperSources: false,
            themeSource: "system",
            updateChannel: "stable",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences() {
        putCalls += 1;
        throw new Error("putDesktopPreferences should not be called");
      }
    }
  });

  assert.equal(putCalls, 0);
  assert.equal(state.getDockPlacement(), "bottom");
  assert.equal(state.getLocale(), "en");
  assert.equal(state.getDefaultAgentProvider(), "codex");
  assert.deepEqual(state.getAgentGUIConversationRailCollapsedByProvider(), {});
  assert.equal(state.getBrowserUseConnectionMode(), "isolated");
  assert.equal(state.getSleepPreventionMode(), "never");
  assert.equal(state.getThemeSource(), "system");
});

test("createDesktopHostPreferencesState keeps initialized stable update channel", async () => {
  const migrationStateRootDir = await mkdtemp(
    join(tmpdir(), "tutti-update-channel-migration-")
  );
  const putRequests: PutDesktopPreferencesRequest[] = [];
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    migrationStateRootDir,
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            agentGuiConversationRailCollapsedByProvider: {},
            agentConversationDetailMode: "coding",
            agentDockLayout: "legacySplit",
            appCatalogChannel: "production",
            defaultAgentProvider: "codex",

            dockIconStyle: "default",
            dockPlacement: "bottom",
            fileDefaultOpenersByExtension: { html: "defaultBrowser" },
            locale: "zh-CN",
            minimizeAnimation: "scale",
            sleepPreventionMode: "never",
            showAppDeveloperSources: false,
            themeSource: "dark",
            updateChannel: "stable",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences(request) {
        putRequests.push(request);
        return {
          initialized: true,
          preferences: request.preferences
        };
      }
    }
  });

  assert.equal(state.getUpdateChannel(), "stable");
  assert.deepEqual(putRequests, []);
});

test("createDesktopHostPreferencesState migrates the old rc default update channel once", async () => {
  const migrationStateRootDir = await mkdtemp(
    join(tmpdir(), "tutti-update-channel-migration-")
  );
  const putRequests: PutDesktopPreferencesRequest[] = [];
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    migrationStateRootDir,
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            agentGuiConversationRailCollapsedByProvider: {},
            agentConversationDetailMode: "coding",
            agentDockLayout: "legacySplit",
            appCatalogChannel: "production",
            defaultAgentProvider: "codex",

            dockIconStyle: "default",
            dockPlacement: "bottom",
            fileDefaultOpenersByExtension: { html: "defaultBrowser" },
            locale: "zh-CN",
            minimizeAnimation: "scale",
            sleepPreventionMode: "never",
            showAppDeveloperSources: false,
            themeSource: "dark",
            updateChannel: "rc",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences(request) {
        putRequests.push(request);
        return {
          initialized: true,
          preferences: request.preferences
        };
      }
    }
  });

  assert.equal(state.getUpdateChannel(), "stable");
  assert.equal(putRequests.length, 1);
  assert.equal(putRequests[0]?.preferences.updateChannel, "stable");
  assert.match(
    await readFile(
      join(
        migrationStateRootDir,
        "migrations",
        "desktop-update-channel-default-stable-v1"
      ),
      "utf8"
    ),
    /^\d{4}-\d{2}-\d{2}T/
  );
});

test("createDesktopHostPreferencesState preserves initialized rc channel on rc packages", async () => {
  const migrationStateRootDir = await mkdtemp(
    join(tmpdir(), "tutti-update-channel-migration-")
  );
  let putCalls = 0;
  const state = await createDesktopHostPreferencesState({
    appVersion: "v0.1.6-rc.2",
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    migrationStateRootDir,
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            agentGuiConversationRailCollapsedByProvider: {},
            agentConversationDetailMode: "coding",
            agentDockLayout: "legacySplit",
            appCatalogChannel: "production",
            defaultAgentProvider: "codex",

            dockIconStyle: "default",
            dockPlacement: "bottom",
            fileDefaultOpenersByExtension: { html: "defaultBrowser" },
            locale: "zh-CN",
            minimizeAnimation: "scale",
            sleepPreventionMode: "never",
            showAppDeveloperSources: false,
            themeSource: "dark",
            updateChannel: "rc",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences() {
        putCalls += 1;
        throw new Error("putDesktopPreferences should not be called");
      }
    }
  });

  assert.equal(putCalls, 0);
  assert.equal(state.getUpdateChannel(), "rc");
});

test("createDesktopHostPreferencesState preserves rc after the stable default migration ran", async () => {
  const migrationStateRootDir = await mkdtemp(
    join(tmpdir(), "tutti-update-channel-migration-")
  );
  await mkdir(join(migrationStateRootDir, "migrations"), { recursive: true });
  await writeFile(
    join(
      migrationStateRootDir,
      "migrations",
      "desktop-update-channel-default-stable-v1"
    ),
    "applied",
    "utf8"
  );
  let putCalls = 0;
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "zh-CN",
    logger: createLogger(),
    migrationStateRootDir,
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            agentGuiConversationRailCollapsedByProvider: {},
            agentConversationDetailMode: "coding",
            agentDockLayout: "legacySplit",
            appCatalogChannel: "production",
            defaultAgentProvider: "codex",

            dockIconStyle: "default",
            dockPlacement: "bottom",
            fileDefaultOpenersByExtension: { html: "defaultBrowser" },
            locale: "zh-CN",
            minimizeAnimation: "scale",
            sleepPreventionMode: "never",
            showAppDeveloperSources: false,
            themeSource: "dark",
            updateChannel: "rc",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences() {
        putCalls += 1;
        throw new Error("putDesktopPreferences should not be called");
      }
    }
  });

  assert.equal(putCalls, 0);
  assert.equal(state.getUpdateChannel(), "rc");
});

test("createDesktopHostPreferencesState notifies subscribers after sync changes", async () => {
  const state = await createDesktopHostPreferencesState({
    fallbackLocale: "en",
    logger: createLogger(),
    tuttidClient: {
      async getDesktopPreferences() {
        return {
          initialized: true,
          preferences: {
            agentComposerDefaultsByProvider: {},
            agentGuiConversationRailCollapsedByProvider: {},
            agentConversationDetailMode: "coding",
            agentDockLayout: "legacySplit",
            appCatalogChannel: "production",
            browserUseConnectionMode: "isolated",
            defaultAgentProvider: "codex",

            dockIconStyle: "default",
            dockPlacement: "bottom",
            fileDefaultOpenersByExtension: { html: "defaultBrowser" },
            locale: "en",
            minimizeAnimation: "scale",
            sleepPreventionMode: "never",
            showAppDeveloperSources: false,
            themeSource: "system",
            updateChannel: "stable",
            updatePolicy: "prompt"
          }
        };
      },
      async putDesktopPreferences() {
        throw new Error("putDesktopPreferences should not be called");
      }
    }
  });
  let notifications = 0;
  const unsubscribe = state.subscribe(() => {
    notifications += 1;
  });

  state.sync({ locale: "zh-CN" });
  state.sync({ locale: "zh-CN" });
  state.sync({ defaultAgentProvider: "claude-code" });
  state.sync({ defaultAgentProvider: "claude-code" });
  state.sync({ browserUseConnectionMode: "autoConnect" });
  state.sync({ browserUseConnectionMode: "autoConnect" });
  state.sync({ agentGuiConversationRailCollapsedByProvider: { codex: true } });
  state.sync({ agentGuiConversationRailCollapsedByProvider: { codex: true } });
  state.sync({ dockPlacement: "left" });
  state.sync({ dockPlacement: "left" });
  state.sync({ sleepPreventionMode: "whileAgentRunning" });
  state.sync({ sleepPreventionMode: "whileAgentRunning" });
  unsubscribe();
  state.sync({ locale: "en" });

  assert.equal(notifications, 6);
});

function createLogger(): DesktopLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    async close() {}
  };
}
