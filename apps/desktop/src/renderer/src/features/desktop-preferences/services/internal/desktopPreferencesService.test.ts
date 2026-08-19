import assert from "node:assert/strict";
import test from "node:test";
import type {
  DesktopPreferencesStateResponse,
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopLocale } from "@shared/i18n";
import {
  defaultDesktopWorkbenchShortcuts,
  desktopFeatureFlagsEqual,
  type DesktopWorkspaceUiMode
} from "../../../../../../shared/preferences/index.ts";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import type { DesktopPreferencesClient } from "./adapters/desktopPreferencesClient.ts";
import { createDesktopPreferencesClient as createDesktopPreferencesFeatureClient } from "./adapters/desktopPreferencesClient.ts";
import {
  DesktopPreferencesService,
  type DesktopPreferencesServiceDependencies
} from "./desktopPreferencesService.ts";

type Preferences = DesktopPreferencesStateResponse["preferences"];
type PublishedPreferences = Omit<
  Preferences,
  "agentComposerDefaultsByAgentTarget"
>;
const standaloneAgentModeFlag = "workspace.standaloneAgentMode";

test("DesktopPreferencesService bootstraps persisted preferences before connecting the event stream", async () => {
  const appliedLocales: DesktopLocale[] = [];
  const appliedThemes: DesktopThemeState[] = [];
  const calls: string[] = [];
  const client = createDesktopPreferencesClient({
    connect: async () => {
      calls.push("connect");
    },
    getDesktopPreferences: async () => {
      calls.push("get");
      return {
        initialized: true,
        preferences: {
          agentCliUpdateCheckEnabled: true,
          agentComposerDefaultsByProvider: {},
          agentComposerDefaultsByAgentTarget: {},
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode: "coding",
          agentDockLayout: "unified",
          deletedAgentConversationRetentionDays: 30,
          appCatalogChannel: "production",
          browserUseConnectionMode: "isolated",
          defaultAgentProvider: "codex",
          featureFlags: {},
          workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
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
    }
  });
  const { service, cleanup } = await createServiceHarness({
    appliedLocales,
    appliedThemes,
    client
  });

  assert.deepEqual(calls, ["get", "connect"]);
  assert.equal(service.store.locale, "zh-CN");
  assert.deepEqual(service.store.theme, {
    appearance: "dark",
    source: "dark"
  });
  assert.deepEqual(appliedLocales, ["zh-CN"]);
  assert.deepEqual(appliedThemes, [{ appearance: "dark", source: "dark" }]);
  cleanup();
});

test("initial preference hydration exposes persisted feature flags before composition", async () => {
  let resolvePreferences: (
    value: DesktopPreferencesStateResponse
  ) => void = () => {};
  const preferencesResponse = new Promise<DesktopPreferencesStateResponse>(
    (resolve) => {
      resolvePreferences = resolve;
    }
  );
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: () => preferencesResponse
  });
  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: { appearance: "light", source: "system" },
    resolveTheme
  });
  let hydrationCompleted = false;
  const hydration = service.whenInitialPreferencesHydrated().then(() => {
    hydrationCompleted = true;
  });

  await Promise.resolve();
  assert.equal(hydrationCompleted, false);
  assert.deepEqual(service.store.featureFlags, {});

  resolvePreferences({
    initialized: true,
    preferences: createPreferences({
      featureFlags: { "test.persisted": true }
    })
  });
  await hydration;

  assert.equal(service.store.featureFlags["test.persisted"], true);
  service.dispose();
});

test("initial preference hydration failure releases startup with defaults", async () => {
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: async () => {
      throw new Error("preferences unavailable");
    }
  });
  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: { appearance: "light", source: "system" },
    resolveTheme
  });

  await service.whenInitialPreferencesHydrated();

  assert.deepEqual(service.store.featureFlags, {});
  service.dispose();
});

test("DesktopPreferencesService restores authoritative preferences before the first mutation", async () => {
  const calls: string[] = [];
  const updatedRequests: Preferences[] = [];
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: async () => ({
      initialized: false,
      preferences: createPreferences()
    }),
    updateDesktopPreferences: async (request) => {
      calls.push("update");
      updatedRequests.push(request.preferences);
      return request.preferences;
    }
  });
  const { service, cleanup } = await createServiceHarness({
    client,
    initialLocale: "zh-CN",
    initialTheme: { appearance: "dark", source: "dark" },
    initialWorkspaceUiMode: "agent",
    ensureInitialized: async (candidate) => {
      calls.push("ensure");
      assert.equal(candidate.featureFlags[standaloneAgentModeFlag], true);
      return {
        initialized: true,
        preferences: createPreferences({
          featureFlags: { [standaloneAgentModeFlag]: false },
          locale: "zh-CN"
        })
      };
    }
  });

  assert.equal(service.store.featureFlags[standaloneAgentModeFlag], true);
  assert.equal(service.store.locale, "zh-CN");
  assert.deepEqual(service.store.theme, {
    appearance: "dark",
    source: "dark"
  });
  await service.setLocale("en");
  assert.deepEqual(calls, ["ensure", "update"]);
  assert.equal(
    updatedRequests[0]?.featureFlags[standaloneAgentModeFlag],
    false
  );
  cleanup();
});

test("DesktopPreferencesService blocks mutation when initialization recovery fails", async () => {
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: async () => ({
      initialized: false,
      preferences: createPreferences()
    })
  });
  const { service, cleanup } = await createServiceHarness({
    client,
    initialWorkspaceUiMode: "agent",
    ensureInitialized: async () => {
      throw new Error("initialization unavailable");
    }
  });

  await assert.rejects(
    service.setLocale("zh-CN"),
    /initialization unavailable/
  );
  assert.equal(service.store.locale, "en");
  assert.equal(client.updatedRequests.length, 0);
  cleanup();
});

test("DesktopPreferencesService shares one recovery across full and dedicated mutations", async () => {
  const calls: string[] = [];
  const updatedRequests: Preferences[] = [];
  let ensureCalls = 0;
  let releaseRecovery: (() => void) | undefined;
  const recoveryBarrier = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: async () => ({
      initialized: false,
      preferences: createPreferences()
    }),
    patchAgentComposerDefaultsForTarget: async () => {
      calls.push("composer-patch");
    },
    updateDesktopPreferences: async (request) => {
      calls.push("full-update");
      updatedRequests.push(request.preferences);
      return request.preferences;
    }
  });
  const { service, cleanup } = await createServiceHarness({
    client,
    initialWorkspaceUiMode: "agent",
    ensureInitialized: async () => {
      ensureCalls++;
      calls.push("ensure");
      await recoveryBarrier;
      return {
        initialized: true,
        preferences: createPreferences({
          featureFlags: { [standaloneAgentModeFlag]: false }
        })
      };
    }
  });

  const localeMutation = service.setLocale("zh-CN");
  const composerMutation = service.rememberAgentComposerDefaultsForAgentTarget(
    "local:codex",
    { model: "gpt-5" }
  );
  await Promise.resolve();
  assert.equal(ensureCalls, 1);
  assert.deepEqual(calls, ["ensure"]);

  releaseRecovery?.();
  await Promise.all([localeMutation, composerMutation]);

  assert.equal(ensureCalls, 1);
  assert.deepEqual(calls.slice(1).sort(), ["composer-patch", "full-update"]);
  assert.equal(
    updatedRequests[0]?.featureFlags[standaloneAgentModeFlag],
    false
  );
  cleanup();
});

test("DesktopPreferencesService lets initialized OS preferences override an Agent bootstrap", async () => {
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: async () => ({
      initialized: true,
      preferences: createPreferences({
        featureFlags: { [standaloneAgentModeFlag]: false }
      })
    })
  });
  const { service, cleanup } = await createServiceHarness({
    client,
    initialWorkspaceUiMode: "agent"
  });

  assert.equal(service.store.featureFlags[standaloneAgentModeFlag], false);
  cleanup();
});

test("DesktopPreferencesService discards persisted legacy provider defaults from new writes", async () => {
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: async () => ({
      initialized: true,
      preferences: createPreferences({
        agentCliUpdateCheckEnabled: true,
        agentComposerDefaultsByProvider: { codex: { model: "gpt-5" } }
      })
    })
  });
  const { service, cleanup } = await createServiceHarness({ client });

  assert.deepEqual(service.store.agentComposerDefaultsByProvider, {});
  const savedLocale = service.setLocale("zh-CN");
  assert.deepEqual(client.updatedRequests, [
    createPublishedPreferences({
      agentCliUpdateCheckEnabled: true,
      agentComposerDefaultsByProvider: {},
      locale: "zh-CN"
    })
  ]);
  client.emitDesktopPreferencesUpdated(createPreferences({ locale: "zh-CN" }));
  await savedLocale;
  cleanup();
});

test("DesktopPreferencesService publishes locale writes and converges on the authoritative event", async () => {
  const appliedLocales: DesktopLocale[] = [];
  const client = createDesktopPreferencesClient({});
  const { service, cleanup } = await createServiceHarness({
    appliedLocales,
    client
  });

  const savedLocale = service.setLocale("zh-CN");
  assert.deepEqual(client.updatedRequests, [
    {
      agentCliUpdateCheckEnabled: true,
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: "coding",
      agentDockLayout: "unified",
      deletedAgentConversationRetentionDays: 30,
      appCatalogChannel: "production",
      browserUseConnectionMode: "isolated",
      defaultAgentProvider: "codex",
      featureFlags: {},
      workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
      dockIconStyle: "default",
      dockPlacement: "bottom",
      fileDefaultOpenersByExtension: { html: "defaultBrowser" },
      locale: "zh-CN",
      minimizeAnimation: "scale",
      sleepPreventionMode: "never",
      showAppDeveloperSources: false,
      themeSource: "system",
      updateChannel: "stable",
      updatePolicy: "prompt"
    }
  ]);
  assert.equal(service.store.locale, "zh-CN");
  assert.deepEqual(appliedLocales, ["zh-CN"]);

  client.emitDesktopPreferencesUpdated({
    agentCliUpdateCheckEnabled: true,
    agentComposerDefaultsByProvider: {},
    agentComposerDefaultsByAgentTarget: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
    deletedAgentConversationRetentionDays: 30,
    appCatalogChannel: "production",
    browserUseConnectionMode: "isolated",
    defaultAgentProvider: "codex",
    featureFlags: {},
    workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
    dockIconStyle: "default",
    dockPlacement: "bottom",
    fileDefaultOpenersByExtension: { html: "defaultBrowser" },
    locale: "zh-CN",
    minimizeAnimation: "scale",
    sleepPreventionMode: "never",
    showAppDeveloperSources: false,
    themeSource: "system",
    updateChannel: "stable",
    updatePolicy: "prompt"
  });

  assert.equal(await savedLocale, "zh-CN");
  assert.equal(service.store.locale, "zh-CN");
  cleanup();
});

test("DesktopPreferencesService rolls back optimistic locale changes when publishing fails", async () => {
  const appliedLocales: DesktopLocale[] = [];
  const client = createDesktopPreferencesClient({
    updateDesktopPreferences: async () => {
      throw new Error("publish failed");
    }
  });
  const { service, cleanup } = await createServiceHarness({
    appliedLocales,
    client
  });

  await assert.rejects(() => service.setLocale("zh-CN"), /publish failed/);
  assert.equal(service.store.locale, "en");
  assert.deepEqual(appliedLocales, ["zh-CN", "en"]);
  cleanup();
});

test("DesktopPreferencesService publishes deleted conversation retention changes", async () => {
  const client = createDesktopPreferencesClient({});
  const { service, cleanup } = await createServiceHarness({ client });

  const saved = service.setDeletedAgentConversationRetentionDays(15);
  assert.equal(service.store.deletedAgentConversationRetentionDays, 15);
  assert.equal(
    client.updatedRequests[0]?.deletedAgentConversationRetentionDays,
    15
  );
  client.emitDesktopPreferencesUpdated(
    createPreferences({ deletedAgentConversationRetentionDays: 15 })
  );

  assert.equal(await saved, 15);
  assert.equal(
    service.store.changingDeletedAgentConversationRetentionDays,
    null
  );
  cleanup();
});

test("DesktopPreferencesService applies authoritative theme updates from the event stream", async () => {
  const appliedThemes: DesktopThemeState[] = [];
  const client = createDesktopPreferencesClient({});
  const { service, cleanup } = await createServiceHarness({
    appliedThemes,
    client
  });

  const savedTheme = service.setThemeSource("dark");
  assert.deepEqual(client.updatedRequests, [
    createPublishedPreferences({ themeSource: "dark" })
  ]);
  assert.deepEqual(service.store.theme, { appearance: "dark", source: "dark" });
  assert.deepEqual(appliedThemes, [{ appearance: "dark", source: "dark" }]);
  client.emitDesktopPreferencesUpdated(
    createPreferences({ themeSource: "dark" })
  );

  assert.deepEqual(await savedTheme, { appearance: "dark", source: "dark" });
  assert.deepEqual(service.store.theme, { appearance: "dark", source: "dark" });
  cleanup();
});

test("DesktopPreferencesService rolls back optimistic theme changes when publishing fails", async () => {
  const appliedThemes: DesktopThemeState[] = [];
  const client = createDesktopPreferencesClient({
    updateDesktopPreferences: async () => {
      throw new Error("publish failed");
    }
  });
  const { service, cleanup } = await createServiceHarness({
    appliedThemes,
    client
  });

  await assert.rejects(() => service.setThemeSource("dark"), /publish failed/);
  assert.deepEqual(service.store.theme, {
    appearance: "light",
    source: "system"
  });
  assert.deepEqual(appliedThemes, [
    { appearance: "dark", source: "dark" },
    { appearance: "light", source: "system" }
  ]);
  cleanup();
});

test("DesktopPreferencesService publishes scalar preference writes", async (t) => {
  const cases = [
    {
      name: "agent CLI update check",
      request: createPublishedPreferences({
        agentCliUpdateCheckEnabled: false
      }),
      event: createPreferences({ agentCliUpdateCheckEnabled: false }),
      publish: (service: DesktopPreferencesService) =>
        service.setAgentCliUpdateCheckEnabled(false),
      read: (service: DesktopPreferencesService) =>
        service.store.agentCliUpdateCheckEnabled,
      expected: false
    },
    {
      name: "sleep prevention mode",
      request: createPublishedPreferences({
        sleepPreventionMode: "whileAgentRunning"
      }),
      event: createPreferences({ sleepPreventionMode: "whileAgentRunning" }),
      publish: (service: DesktopPreferencesService) =>
        service.setSleepPreventionMode("whileAgentRunning"),
      read: (service: DesktopPreferencesService) =>
        service.store.sleepPreventionMode,
      expected: "whileAgentRunning"
    },
    {
      name: "update policy",
      request: createPublishedPreferences({ updatePolicy: "auto" }),
      event: createPreferences({ updatePolicy: "auto" }),
      publish: (service: DesktopPreferencesService) =>
        service.setUpdatePolicy("auto"),
      read: (service: DesktopPreferencesService) => service.store.updatePolicy,
      expected: "auto"
    },
    {
      name: "update channel",
      request: createPublishedPreferences({ updateChannel: "rc" }),
      event: createPreferences({ updateChannel: "rc" }),
      publish: (service: DesktopPreferencesService) =>
        service.setUpdateChannel("rc"),
      read: (service: DesktopPreferencesService) => service.store.updateChannel,
      expected: "rc"
    },
    {
      name: "app catalog channel",
      request: createPublishedPreferences({ appCatalogChannel: "staging" }),
      event: createPreferences({ appCatalogChannel: "staging" }),
      publish: (service: DesktopPreferencesService) =>
        service.setAppCatalogChannel("staging"),
      read: (service: DesktopPreferencesService) =>
        service.store.appCatalogChannel,
      expected: "staging"
    },
    {
      name: "developer source display",
      request: createPublishedPreferences({ showAppDeveloperSources: true }),
      event: createPreferences({ showAppDeveloperSources: true }),
      publish: (service: DesktopPreferencesService) =>
        service.setShowAppDeveloperSources(true),
      read: (service: DesktopPreferencesService) =>
        service.store.showAppDeveloperSources,
      expected: true
    },
    {
      name: "dock placement",
      request: createPublishedPreferences({ dockPlacement: "left" }),
      event: createPreferences({ dockPlacement: "left" }),
      publish: (service: DesktopPreferencesService) =>
        service.setDockPlacement("left"),
      read: (service: DesktopPreferencesService) => service.store.dockPlacement,
      expected: "left"
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const client = createDesktopPreferencesClient({});
      const { service, cleanup } = await createServiceHarness({ client });
      const savedPreference = scenario.publish(service);

      assert.deepEqual(client.updatedRequests, [scenario.request]);
      assert.equal(scenario.read(service), scenario.expected);
      client.emitDesktopPreferencesUpdated(scenario.event);
      assert.equal(await savedPreference, scenario.expected);
      assert.equal(scenario.read(service), scenario.expected);
      cleanup();
    });
  }
});

test("DesktopPreferencesService tracks agent conversation detail mode while publishing", async () => {
  const client = createDesktopPreferencesClient({});
  const { service, cleanup } = await createServiceHarness({ client });
  const savedMode = service.setAgentConversationDetailMode("general");

  assert.deepEqual(client.updatedRequests, [
    createPublishedPreferences({ agentConversationDetailMode: "general" })
  ]);
  assert.equal(service.store.agentConversationDetailMode, "general");
  assert.equal(service.store.changingAgentConversationDetailMode, "general");
  client.emitDesktopPreferencesUpdated(
    createPreferences({ agentConversationDetailMode: "general" })
  );

  assert.equal(await savedMode, "general");
  assert.equal(service.store.changingAgentConversationDetailMode, null);
  cleanup();
});

test("DesktopPreferencesService publishes non-default and explicit default window snapping", async (t) => {
  for (const snapping of [
    { enabled: true, shortcutPreset: "commandShiftArrows" as const },
    { enabled: false, shortcutPreset: "commandArrows" as const }
  ]) {
    await t.test(
      `${snapping.enabled ? "non-default" : "explicit default"} value`,
      async () => {
        const client = createDesktopPreferencesClient({});
        const { service, cleanup } = await createServiceHarness({ client });
        const savedPreference = service.setWorkbenchWindowSnapping(snapping);

        assert.deepEqual(client.updatedRequests, [
          createPublishedPreferences({ workbenchWindowSnapping: snapping })
        ]);
        assert.deepEqual(service.store.workbenchWindowSnapping, snapping);
        client.emitDesktopPreferencesUpdated(
          createPreferences({ workbenchWindowSnapping: snapping })
        );
        assert.deepEqual(await savedPreference, snapping);
        assert.deepEqual(service.store.workbenchWindowSnapping, snapping);
        cleanup();
      }
    );
  }
});

test("DesktopPreferencesService refreshes from GET after the authoritative event timeout", async () => {
  const tuttidClient = createSequentialTuttidClient([
    { initialized: true, preferences: createPreferences() },
    { initialized: true, preferences: createPreferences({ locale: "zh-CN" }) }
  ]);
  const client = createDesktopPreferencesFeatureClient(
    tuttidClient,
    createFallbackConfirmingEventStreamClient(),
    { authoritativeEventTimeoutMs: 0 }
  );
  const appliedLocales: DesktopLocale[] = [];
  const appliedThemes: DesktopThemeState[] = [];
  const { service, cleanup } = await createServiceHarness({
    appliedLocales,
    appliedThemes,
    client
  });

  assert.equal(await service.setLocale("zh-CN"), "zh-CN");
  assert.equal(service.store.locale, "zh-CN");
  assert.deepEqual(service.store.theme, {
    appearance: "light",
    source: "system"
  });
  assert.deepEqual(appliedLocales, ["zh-CN"]);
  assert.deepEqual(appliedThemes, []);
  assert.equal(tuttidClient.getDesktopPreferencesCalls, 2);
  cleanup();
});

test("DesktopPreferencesService keeps featureFlags identity when authoritative flags are unchanged", async () => {
  const initialFeatureFlags = { "lab.enabled": true };
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: async () => ({
      initialized: true,
      preferences: createPreferences({
        agentDockLayout: "legacySplit",
        deletedAgentConversationRetentionDays: 30,
        featureFlags: initialFeatureFlags
      })
    })
  });
  const { service, cleanup } = await createServiceHarness({ client });
  const featureFlagsBeforeUpdate = service.store.featureFlags;

  client.emitDesktopPreferencesUpdated(
    createPreferences({
      agentDockLayout: "legacySplit",
      deletedAgentConversationRetentionDays: 30,
      featureFlags: { "lab.enabled": true },
      locale: "zh-CN"
    })
  );

  assert.equal(service.store.locale, "zh-CN");
  assert.ok(
    desktopFeatureFlagsEqual(service.store.featureFlags, initialFeatureFlags)
  );
  assert.equal(service.store.featureFlags, featureFlagsBeforeUpdate);
  cleanup();
});

test("DesktopPreferencesService rejects mismatched App Center source confirmations and rolls back", async () => {
  const tuttidClient = createSequentialTuttidClient([
    { initialized: true, preferences: createPreferences() },
    { initialized: true, preferences: createPreferences() }
  ]);
  const client = createDesktopPreferencesFeatureClient(
    tuttidClient,
    createFallbackConfirmingEventStreamClient(),
    { authoritativeEventTimeoutMs: 0 }
  );
  const { service, cleanup } = await createServiceHarness({ client });

  await assert.rejects(
    () => service.setAppCatalogChannel("staging"),
    /authoritative update did not arrive/u
  );
  assert.equal(service.store.appCatalogChannel, "production");
  assert.equal(tuttidClient.getDesktopPreferencesCalls, 2);
  cleanup();
});

test("DesktopPreferencesService remembers trimmed and nullable composer defaults per agent target", async () => {
  const patches: Array<{ agentTargetId: string; patch: unknown }> = [];
  const deferredPublishes: Array<() => void> = [];
  let deferPublishes = false;
  const client = createDesktopPreferencesClient({
    patchAgentComposerDefaultsForTarget: async (input) => {
      patches.push({ agentTargetId: input.agentTargetId, patch: input.patch });
      if (deferPublishes) {
        await new Promise<void>((resolve) => deferredPublishes.push(resolve));
      }
    }
  });
  const { service, cleanup } = await createServiceHarness({ client });

  const firstResult = await service.rememberAgentComposerDefaultsForAgentTarget(
    " local:codex ",
    {
      model: " gpt-5 ",
      permissionModeId: " full-access ",
      reasoningEffort: " high ",
      speed: " fast "
    }
  );
  assert.deepEqual(firstResult, {
    acknowledgedFields: [
      "model",
      "permissionModeId",
      "reasoningEffort",
      "speed"
    ],
    supersededFields: []
  });
  assert.deepEqual(patches, [
    {
      agentTargetId: "local:codex",
      patch: {
        model: "gpt-5",
        permissionModeId: "full-access",
        reasoningEffort: "high",
        speed: "fast"
      }
    }
  ]);
  assert.equal(client.updatedRequests.length, 0);

  const secondResult =
    await service.rememberAgentComposerDefaultsForAgentTarget("local:codex", {
      model: "gpt-5-codex",
      speed: null
    });
  assert.deepEqual(secondResult, {
    acknowledgedFields: ["model", "speed"],
    supersededFields: []
  });
  assert.deepEqual(patches.at(-1), {
    agentTargetId: "local:codex",
    patch: { model: "gpt-5-codex", speed: null }
  });
  assert.equal(client.updatedRequests.length, 0);

  deferPublishes = true;
  const superseded = service.rememberAgentComposerDefaultsForAgentTarget(
    "local:codex",
    { permissionModeId: "ask" }
  );
  const latest = service.rememberAgentComposerDefaultsForAgentTarget(
    "local:codex",
    { permissionModeId: "full-access" }
  );
  assert.deepEqual(await superseded, {
    acknowledgedFields: [],
    supersededFields: ["permissionModeId"]
  });
  deferredPublishes[0]!();
  await settle();
  deferredPublishes[1]!();
  assert.deepEqual(await latest, {
    acknowledgedFields: ["permissionModeId"],
    supersededFields: []
  });
  assert.equal(client.updatedRequests.length, 0);
  cleanup();
});

test("DesktopPreferencesService merges conversation rail collapsed state per provider", async () => {
  const requests: Preferences[] = [];
  const client = createDesktopPreferencesClient({
    updateDesktopPreferences: async (request) => {
      requests.push(request.preferences);
      return request.preferences;
    }
  });
  const { service, cleanup } = await createServiceHarness({ client });
  await service.rememberAgentGuiConversationRailCollapsed("codex", true);
  await service.rememberAgentGuiConversationRailCollapsed("claude-code", true);

  assert.deepEqual(requests.at(-1), {
    agentCliUpdateCheckEnabled: true,
    agentComposerDefaultsByProvider: {},
    agentGuiConversationRailCollapsedByProvider: {
      codex: true,
      "claude-code": true
    },
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
    deletedAgentConversationRetentionDays: 30,
    appCatalogChannel: "production",
    browserUseConnectionMode: "isolated",
    defaultAgentProvider: "codex",
    featureFlags: {},
    workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
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
  });
  assert.deepEqual(service.store.agentGuiConversationRailCollapsedByProvider, {
    codex: true,
    "claude-code": true
  });
  cleanup();
});

test("DesktopPreferencesService remembers launch mode by workspace and project section", async () => {
  const patches: Array<{
    workspaceId: string;
    projectSectionKey: string;
    mode: "local" | "worktree";
  }> = [];
  const client = createDesktopPreferencesClient({
    patchAgentSessionLaunchMode: async (input) => {
      patches.push(input);
    }
  });
  const { service, cleanup } = await createServiceHarness({ client });

  await service.rememberAgentSessionLaunchMode(
    "workspace-a",
    "project:/alpha",
    "worktree"
  );
  await service.rememberAgentSessionLaunchMode(
    "workspace-a",
    "project:/beta",
    "local"
  );

  assert.deepEqual(patches, [
    {
      workspaceId: "workspace-a",
      projectSectionKey: "project:/alpha",
      mode: "worktree"
    },
    {
      workspaceId: "workspace-a",
      projectSectionKey: "project:/beta",
      mode: "local"
    }
  ]);
  assert.deepEqual(service.store.agentSessionLaunchModesByWorkspace, {
    "workspace-a": {
      "project:/alpha": "worktree",
      "project:/beta": "local"
    }
  });
  cleanup();
});

interface FakeDesktopPreferencesClient extends DesktopPreferencesClient {
  emitDesktopPreferencesUpdated(preferences: Preferences): void;
  updatedRequests: Preferences[];
}

function createPreferences(overrides: Partial<Preferences> = {}): Preferences {
  return {
    agentCliUpdateCheckEnabled: true,
    agentComposerDefaultsByProvider: {},
    agentComposerDefaultsByAgentTarget: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
    deletedAgentConversationRetentionDays: 30,
    appCatalogChannel: "production",
    browserUseConnectionMode: "isolated",
    defaultAgentProvider: "codex",
    featureFlags: {},
    workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
    dockIconStyle: "default",
    dockPlacement: "bottom",
    fileDefaultOpenersByExtension: { html: "defaultBrowser" },
    locale: "en",
    minimizeAnimation: "scale",
    sleepPreventionMode: "never",
    showAppDeveloperSources: false,
    themeSource: "system",
    updateChannel: "stable",
    updatePolicy: "prompt",
    ...overrides
  };
}

function createPublishedPreferences(
  overrides: Partial<PublishedPreferences> = {}
): PublishedPreferences {
  return {
    agentCliUpdateCheckEnabled: true,
    agentComposerDefaultsByProvider: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
    deletedAgentConversationRetentionDays: 30,
    appCatalogChannel: "production",
    browserUseConnectionMode: "isolated",
    defaultAgentProvider: "codex",
    featureFlags: {},
    workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
    dockIconStyle: "default",
    dockPlacement: "bottom",
    fileDefaultOpenersByExtension: { html: "defaultBrowser" },
    locale: "en",
    minimizeAnimation: "scale",
    sleepPreventionMode: "never",
    showAppDeveloperSources: false,
    themeSource: "system",
    updateChannel: "stable",
    updatePolicy: "prompt",
    ...overrides
  };
}

async function createServiceHarness(
  options: {
    appliedLocales?: DesktopLocale[];
    appliedThemes?: DesktopThemeState[];
    client?: DesktopPreferencesClient;
    ensureInitialized?: DesktopPreferencesServiceDependencies["ensureInitialized"];
    initialLocale?: DesktopLocale;
    initialTheme?: DesktopThemeState;
    initialWorkspaceUiMode?: DesktopWorkspaceUiMode;
  } = {}
) {
  const client = options.client ?? createDesktopPreferencesClient({});
  const service = new DesktopPreferencesService({
    applyLocale(locale) {
      options.appliedLocales?.push(locale);
    },
    applyTheme(theme) {
      options.appliedThemes?.push(theme);
    },
    client,
    ensureInitialized:
      options.ensureInitialized ??
      (async (candidate) => ({
        initialized: true,
        preferences: candidate
      })),
    initialLocale: options.initialLocale ?? "en",
    initialTheme: options.initialTheme ?? {
      appearance: "light",
      source: "system"
    },
    ...(options.initialWorkspaceUiMode
      ? { initialWorkspaceUiMode: options.initialWorkspaceUiMode }
      : {}),
    resolveTheme
  });
  await settle();
  return {
    client,
    service,
    cleanup() {
      service.dispose();
    }
  };
}

function createDesktopPreferencesClient(
  overrides: Partial<DesktopPreferencesClient>
): FakeDesktopPreferencesClient {
  const listeners = new Set<(preferences: Preferences) => void>();
  const updatedRequests: Preferences[] = [];
  const pendingUpdates = new Set<{
    reject: (error: Error) => void;
    request: Preferences;
    resolve: (preferences: Preferences) => void;
  }>();

  return {
    connect: async () => {},
    dispose: () => {
      const disposeError = new Error(
        "Desktop preferences client was disposed."
      );
      for (const pendingUpdate of pendingUpdates) {
        pendingUpdate.reject(disposeError);
      }
      pendingUpdates.clear();
    },
    emitDesktopPreferencesUpdated(preferences) {
      for (const listener of listeners) listener(preferences);
      for (const pendingUpdate of [...pendingUpdates]) {
        if (!preferencesConfirmRequest(pendingUpdate.request, preferences))
          continue;
        pendingUpdates.delete(pendingUpdate);
        pendingUpdate.resolve(preferences);
      }
    },
    getDesktopPreferences: async () => ({
      initialized: true,
      preferences: createPreferences()
    }),
    updateDesktopPreferences: async (request) => {
      updatedRequests.push(request.preferences);
      return await new Promise<Preferences>((resolve, reject) => {
        pendingUpdates.add({ reject, request: request.preferences, resolve });
      });
    },
    updatedRequests,
    subscribeToDesktopPreferencesUpdated(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...overrides,
    patchAgentComposerDefaultsForTarget:
      overrides.patchAgentComposerDefaultsForTarget ?? (async () => {}),
    patchAgentSessionLaunchMode:
      overrides.patchAgentSessionLaunchMode ?? (async () => {})
  };
}

function preferencesConfirmRequest(
  request: Preferences,
  preferences: Preferences
): boolean {
  const fields = [
    "agentComposerDefaultsByProvider",
    "agentGuiConversationRailCollapsedByProvider",
    "agentConversationDetailMode",
    "agentDockLayout",
    "appCatalogChannel",
    "browserUseConnectionMode",
    "defaultAgentProvider",
    "dockIconStyle",
    "dockPlacement",
    "locale",
    "sleepPreventionMode",
    "showAppDeveloperSources",
    "themeSource",
    "updateChannel",
    "updatePolicy",
    "workbenchWindowSnapping"
  ] as const;
  return fields.every(
    (field) =>
      JSON.stringify(request[field]) === JSON.stringify(preferences[field])
  );
}

function resolveTheme(source: DesktopThemeSource): DesktopThemeState {
  return { appearance: source === "dark" ? "dark" : "light", source };
}

function createSequentialTuttidClient(
  responses: DesktopPreferencesStateResponse[]
): Pick<TuttidClient, "getDesktopPreferences"> & {
  getDesktopPreferencesCalls: number;
} {
  assert.ok(responses.length > 0);
  let getDesktopPreferencesCalls = 0;
  const fallbackResponse = responses.at(-1)!;
  return {
    get getDesktopPreferencesCalls() {
      return getDesktopPreferencesCalls;
    },
    getDesktopPreferences: async () => {
      getDesktopPreferencesCalls += 1;
      return responses[getDesktopPreferencesCalls - 1] ?? fallbackResponse;
    }
  };
}

function createFallbackConfirmingEventStreamClient(): TuttidEventStreamClient {
  const listeners = new Set<
    (event: {
      emittedAt: string;
      id: string;
      payload: DesktopPreferencesStateResponse;
      topic: "preferences.desktop.updated";
      version: 1;
    }) => void
  >();
  return {
    connect: async () => {},
    dispose: () => listeners.clear(),
    async publishIntent(_topic, _payload) {},
    subscribe(topic, listener) {
      assert.equal(topic, "preferences.desktop.updated");
      listeners.add(listener as Parameters<typeof listeners.add>[0]);
      return () =>
        listeners.delete(listener as Parameters<typeof listeners.delete>[0]);
    },
    subscribeConnectionState() {
      return () => {};
    }
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
