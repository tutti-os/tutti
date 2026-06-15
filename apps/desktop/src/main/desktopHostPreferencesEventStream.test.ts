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
      defaultAgentProvider: "codex",

      dockIconStyle: "default",
      dockPlacement: "bottom",
      locale: "zh-CN",
      sleepPreventionMode: "never",
      themeSource: "dark",
      updateChannel: "stable",
      updatePolicy: "prompt"
    }
  });

  assert.equal(preferences.getLocale(), "zh-CN");
  assert.equal(preferences.getDefaultAgentProvider(), "codex");
  assert.equal(preferences.getDockPlacement(), "bottom");
  assert.equal(preferences.getSleepPreventionMode(), "never");
  assert.equal(preferences.getThemeSource(), "dark");
  assert.deepEqual(appliedThemeSources, ["dark"]);
  assert.equal(backgroundSyncs, 1);

  eventStreamClient.emitDesktopPreferencesUpdated({
    initialized: true,
    preferences: {
      agentComposerDefaultsByProvider: {},
      defaultAgentProvider: "codex",

      dockIconStyle: "default",
      dockPlacement: "bottom",
      locale: "en",
      sleepPreventionMode: "never",
      themeSource: "dark",
      updateChannel: "stable",
      updatePolicy: "prompt"
    }
  });

  assert.equal(preferences.getLocale(), "en");
  assert.equal(preferences.getThemeSource(), "dark");
  assert.deepEqual(appliedThemeSources, ["dark"]);
  assert.equal(backgroundSyncs, 1);

  subscription.dispose();
  assert.equal(eventStreamClient.disposeCalls, 1);
});

function createHostPreferencesState(): DesktopHostPreferencesState {
  let defaultAgentProvider: DesktopPreferencesStateResponse["preferences"]["defaultAgentProvider"] =
    "codex";
  let dockPlacement: DesktopPreferencesStateResponse["preferences"]["dockPlacement"] =
    "bottom";
  let locale: DesktopPreferencesStateResponse["preferences"]["locale"] = "en";
  let sleepPreventionMode: DesktopPreferencesStateResponse["preferences"]["sleepPreventionMode"] =
    "never";
  let themeSource: DesktopThemeSource = "system";
  let updateChannel: DesktopPreferencesStateResponse["preferences"]["updateChannel"] =
    "stable";
  let updatePolicy: DesktopPreferencesStateResponse["preferences"]["updatePolicy"] =
    "prompt";

  return {
    getAgentComposerDefaultsByProvider() {
      return {};
    },
    getLocale() {
      return locale;
    },
    getDefaultAgentProvider() {
      return defaultAgentProvider;
    },
    getDockIconStyle() {
      return "default";
    },
    getDockPlacement() {
      return dockPlacement;
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
    subscribe() {
      return () => undefined;
    },
    sync(input) {
      if (input.locale) {
        locale = input.locale;
      }
      if (input.defaultAgentProvider) {
        defaultAgentProvider = input.defaultAgentProvider;
      }
      if (input.dockPlacement) {
        dockPlacement = input.dockPlacement;
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
