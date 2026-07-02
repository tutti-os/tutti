import assert from "node:assert/strict";
import test from "node:test";
import type {
  DesktopPreferencesStateResponse,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopThemeSource } from "../shared/theme";
import type { DesktopHostPreferencesState } from "./desktopHostPreferences";
import type { DesktopLogger } from "./logging";
import { connectDesktopHostPreferencesEventStream } from "./desktopHostPreferencesEventStream.ts";

test("desktop host preferences follows authoritative preference events", async () => {
  const eventStreamClient = createFakeEventStreamClient();
  const preferences = createHostPreferencesState();
  const appliedThemeSources: DesktopThemeSource[] = [];
  let backgroundSyncs = 0;

  const subscription = connectDesktopHostPreferencesEventStream({
    applyThemeSource(source) {
      appliedThemeSources.push(source);
    },
    eventStreamClient,
    logger: createLogger(),
    preferences,
    syncWindowBackgroundColors() {
      backgroundSyncs += 1;
    }
  });

  await Promise.resolve();
  assert.equal(eventStreamClient.connectCalls, 1);

  eventStreamClient.emitDesktopPreferencesUpdated({
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
      locale: "zh-CN",
      minimizeAnimation: "scale",
      sleepPreventionMode: "never",
      showAppDeveloperSources: false,
      themeSource: "dark",
      updateChannel: "stable",
      updatePolicy: "prompt"
    }
  });

  assert.equal(preferences.getLocale(), "zh-CN");
  assert.equal(preferences.getDefaultAgentProvider(), "codex");
  assert.deepEqual(
    preferences.getAgentGUIConversationRailCollapsedByProvider(),
    {}
  );
  assert.equal(preferences.getBrowserUseConnectionMode(), "isolated");
  assert.equal(preferences.getDockPlacement(), "bottom");
  assert.equal(preferences.getSleepPreventionMode(), "never");
  assert.equal(preferences.getThemeSource(), "dark");
  assert.deepEqual(appliedThemeSources, ["dark"]);
  assert.equal(backgroundSyncs, 1);

  eventStreamClient.emitDesktopPreferencesUpdated({
    initialized: true,
    preferences: {
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {
        codex: true
      },
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
      themeSource: "dark",
      updateChannel: "stable",
      updatePolicy: "prompt"
    }
  });

  assert.equal(preferences.getLocale(), "en");
  assert.deepEqual(
    preferences.getAgentGUIConversationRailCollapsedByProvider(),
    {
      codex: true
    }
  );
  assert.equal(preferences.getThemeSource(), "dark");
  assert.deepEqual(appliedThemeSources, ["dark"]);
  assert.equal(backgroundSyncs, 1);

  subscription.dispose();
  assert.equal(eventStreamClient.disposeCalls, 1);
});

function createHostPreferencesState(): DesktopHostPreferencesState {
  let agentGUIConversationRailCollapsedByProvider: DesktopPreferencesStateResponse["preferences"]["agentGuiConversationRailCollapsedByProvider"] =
    {};
  let agentConversationDetailMode: DesktopPreferencesStateResponse["preferences"]["agentConversationDetailMode"] =
    "coding";
  let agentDockLayout: DesktopPreferencesStateResponse["preferences"]["agentDockLayout"] =
    "legacySplit";
  let appCatalogChannel: DesktopPreferencesStateResponse["preferences"]["appCatalogChannel"] =
    "production";
  let defaultAgentProvider: DesktopPreferencesStateResponse["preferences"]["defaultAgentProvider"] =
    "codex";
  let browserUseConnectionMode: NonNullable<
    DesktopPreferencesStateResponse["preferences"]["browserUseConnectionMode"]
  > = "isolated";
  let dockPlacement: DesktopPreferencesStateResponse["preferences"]["dockPlacement"] =
    "bottom";
  let fileDefaultOpenersByExtension: DesktopPreferencesStateResponse["preferences"]["fileDefaultOpenersByExtension"] =
    { html: "defaultBrowser" };
  let locale: DesktopPreferencesStateResponse["preferences"]["locale"] = "en";
  let minimizeAnimation: DesktopPreferencesStateResponse["preferences"]["minimizeAnimation"] =
    "scale";
  let sleepPreventionMode: DesktopPreferencesStateResponse["preferences"]["sleepPreventionMode"] =
    "never";
  let themeSource: DesktopThemeSource = "system";
  let updateChannel: DesktopPreferencesStateResponse["preferences"]["updateChannel"] =
    "stable";
  let updatePolicy: DesktopPreferencesStateResponse["preferences"]["updatePolicy"] =
    "prompt";
  let workbenchWindowSnapping: NonNullable<
    DesktopPreferencesStateResponse["preferences"]["workbenchWindowSnapping"]
  > = {
    enabled: false,
    shortcutPreset: "commandArrows"
  };

  return {
    getAgentComposerDefaultsByProvider() {
      return {};
    },
    getAgentGUIConversationRailCollapsedByProvider() {
      return agentGUIConversationRailCollapsedByProvider;
    },
    getAgentConversationDetailMode() {
      return agentConversationDetailMode;
    },
    getAgentDockLayout() {
      return agentDockLayout;
    },
    getAppCatalogChannel() {
      return appCatalogChannel;
    },
    getLocale() {
      return locale;
    },
    getMinimizeAnimation() {
      return minimizeAnimation;
    },
    getDefaultAgentProvider() {
      return defaultAgentProvider;
    },
    getBrowserUseConnectionMode() {
      return browserUseConnectionMode;
    },
    getDockIconStyle() {
      return "default";
    },
    getDockPlacement() {
      return dockPlacement;
    },
    getFileDefaultOpenersByExtension() {
      return fileDefaultOpenersByExtension;
    },
    getSleepPreventionMode() {
      return sleepPreventionMode;
    },
    getThemeSource() {
      return themeSource;
    },
    getUpdateChannel() {
      return updateChannel;
    },
    getUpdatePolicy() {
      return updatePolicy;
    },
    getWorkbenchWindowSnapping() {
      return workbenchWindowSnapping;
    },
    subscribe() {
      return () => undefined;
    },
    sync(input) {
      if (input.agentGuiConversationRailCollapsedByProvider) {
        agentGUIConversationRailCollapsedByProvider =
          input.agentGuiConversationRailCollapsedByProvider;
      }
      if (input.agentConversationDetailMode) {
        agentConversationDetailMode = input.agentConversationDetailMode;
      }
      if (input.agentDockLayout) {
        agentDockLayout = input.agentDockLayout;
      }
      if (input.appCatalogChannel) {
        appCatalogChannel = input.appCatalogChannel;
      }
      if (input.locale) {
        locale = input.locale;
      }
      if (input.minimizeAnimation) {
        minimizeAnimation = input.minimizeAnimation;
      }
      if (input.defaultAgentProvider) {
        defaultAgentProvider = input.defaultAgentProvider;
      }
      if (input.browserUseConnectionMode) {
        browserUseConnectionMode = input.browserUseConnectionMode;
      }
      if (input.dockPlacement) {
        dockPlacement = input.dockPlacement;
      }
      if (input.fileDefaultOpenersByExtension) {
        fileDefaultOpenersByExtension = input.fileDefaultOpenersByExtension;
      }
      if (input.sleepPreventionMode !== undefined) {
        sleepPreventionMode = input.sleepPreventionMode;
      }
      if (input.themeSource) {
        themeSource = input.themeSource;
      }
      if (input.updateChannel) {
        updateChannel = input.updateChannel;
      }
      if (input.updatePolicy) {
        updatePolicy = input.updatePolicy;
      }
      if (input.workbenchWindowSnapping) {
        workbenchWindowSnapping = input.workbenchWindowSnapping;
      }
    }
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

function createFakeEventStreamClient(): TuttidEventStreamClient & {
  connectCalls: number;
  disposeCalls: number;
  emitDesktopPreferencesUpdated(payload: DesktopPreferencesStateResponse): void;
} {
  const listeners = new Set<
    (event: {
      emittedAt: string;
      id: string;
      payload: DesktopPreferencesStateResponse;
      topic: "preferences.desktop.updated";
      version: 1;
    }) => void
  >();
  let connectCalls = 0;
  let disposeCalls = 0;

  return {
    async connect() {
      connectCalls += 1;
    },
    get connectCalls() {
      return connectCalls;
    },
    dispose() {
      disposeCalls += 1;
      listeners.clear();
    },
    get disposeCalls() {
      return disposeCalls;
    },
    emitDesktopPreferencesUpdated(payload) {
      for (const listener of listeners) {
        listener({
          emittedAt: "2026-05-30T08:00:00Z",
          id: "evt-1",
          payload,
          topic: "preferences.desktop.updated",
          version: 1
        });
      }
    },
    async publishIntent() {
      throw new Error("not used");
    },
    subscribe(topic, listener) {
      assert.equal(topic, "preferences.desktop.updated");
      listeners.add(listener as Parameters<typeof listeners.add>[0]);
      return () => {
        listeners.delete(listener as Parameters<typeof listeners.add>[0]);
      };
    },
    subscribeConnectionState() {
      return () => {};
    }
  };
}
