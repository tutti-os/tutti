import assert from "node:assert/strict";
import test from "node:test";
import type {
  DesktopPreferencesStateResponse,
  TuttidEventStreamClient,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import type { DesktopLocale } from "@shared/i18n";
import {
  defaultDesktopWorkbenchShortcuts,
  desktopFeatureFlagsEqual
} from "../../../../../../shared/preferences/index.ts";
import type { DesktopThemeSource, DesktopThemeState } from "@shared/theme";
import type { DesktopPreferencesClient } from "./adapters/desktopPreferencesClient.ts";
import { createDesktopPreferencesClient as createDesktopPreferencesFeatureClient } from "./adapters/desktopPreferencesClient.ts";
import { DesktopPreferencesService } from "./desktopPreferencesService.ts";

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
          agentComposerDefaultsByProvider: {},
          agentComposerDefaultsByAgentTarget: {},
          agentGuiConversationRailCollapsedByProvider: {},
          agentConversationDetailMode: "coding",
          agentDockLayout: "unified",
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

  const service = new DesktopPreferencesService({
    applyLocale(locale) {
      appliedLocales.push(locale);
    },
    applyTheme(theme) {
      appliedThemes.push(theme);
    },
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();

  assert.deepEqual(calls, ["get", "connect"]);
  assert.equal(service.store.locale, "zh-CN");
  assert.deepEqual(service.store.theme, {
    appearance: "dark",
    source: "dark"
  });
  assert.deepEqual(appliedLocales, ["zh-CN"]);
  assert.deepEqual(appliedThemes, [
    {
      appearance: "dark",
      source: "dark"
    }
  ]);

  service.dispose();
});

test("DesktopPreferencesService keeps in-memory defaults when preferences are not initialized", async () => {
  const updatedRequests: DesktopPreferencesStateResponse["preferences"][] = [];
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: async () => ({
      initialized: false,
      preferences: {
        agentComposerDefaultsByProvider: {},
        agentComposerDefaultsByAgentTarget: {},
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        agentDockLayout: "unified",
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
      }
    }),
    patchAgentComposerDefaultsForTarget: async () => {},
    updateDesktopPreferences: async (request) => {
      updatedRequests.push(request.preferences);
      return request.preferences;
    }
  });

  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "zh-CN",
    initialTheme: {
      appearance: "dark",
      source: "dark"
    },
    resolveTheme
  });

  await settle();

  assert.deepEqual(updatedRequests, []);
  assert.equal(service.store.locale, "zh-CN");
  assert.deepEqual(service.store.theme, {
    appearance: "dark",
    source: "dark"
  });

  service.dispose();
});

test("DesktopPreferencesService ignores persisted legacy provider defaults when publishing new writes", async () => {
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: async () => ({
      initialized: true,
      preferences: {
        agentComposerDefaultsByProvider: {
          codex: {
            model: "gpt-5"
          }
        },
        agentComposerDefaultsByAgentTarget: {},
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        agentDockLayout: "unified",
        appCatalogChannel: "production",
        browserUseConnectionMode: "isolated",
        defaultAgentProvider: "codex",
        dockIconStyle: "default",
        dockPlacement: "bottom",
        featureFlags: {},
        fileDefaultOpenersByExtension: { html: "defaultBrowser" },
        locale: "en",
        minimizeAnimation: "scale",
        sleepPreventionMode: "never",
        showAppDeveloperSources: false,
        themeSource: "system",
        updateChannel: "stable",
        updatePolicy: "prompt",
        workbenchShortcuts: defaultDesktopWorkbenchShortcuts
      }
    })
  });

  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();

  assert.deepEqual(service.store.agentComposerDefaultsByProvider, {});

  const savedLocalePromise = service.setLocale("zh-CN");
  assert.deepEqual(
    client.updatedRequests.at(-1)?.agentComposerDefaultsByProvider,
    {}
  );
  client.emitDesktopPreferencesUpdated(client.updatedRequests.at(-1)!);

  await savedLocalePromise;
  service.dispose();
});

test("DesktopPreferencesService publishes locale writes and converges on the authoritative event", async () => {
  const appliedLocales: DesktopLocale[] = [];
  const client = createDesktopPreferencesClient({});

  const service = new DesktopPreferencesService({
    applyLocale(locale) {
      appliedLocales.push(locale);
    },
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  const savedLocalePromise = service.setLocale("zh-CN");

  assert.deepEqual(client.updatedRequests, [
    {
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: "coding",
      agentDockLayout: "unified",
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
    agentComposerDefaultsByProvider: {},
    agentComposerDefaultsByAgentTarget: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
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

  assert.equal(await savedLocalePromise, "zh-CN");
  assert.equal(service.store.locale, "zh-CN");

  service.dispose();
});

test("DesktopPreferencesService rolls back optimistic locale changes when publishing fails", async () => {
  const appliedLocales: DesktopLocale[] = [];
  const client = createDesktopPreferencesClient({
    updateDesktopPreferences: async () => {
      throw new Error("publish failed");
    }
  });

  const service = new DesktopPreferencesService({
    applyLocale(locale) {
      appliedLocales.push(locale);
    },
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  await assert.rejects(() => service.setLocale("zh-CN"), /publish failed/);
  assert.equal(service.store.locale, "en");
  assert.deepEqual(appliedLocales, ["zh-CN", "en"]);

  service.dispose();
});

test("DesktopPreferencesService applies authoritative theme updates from the event stream", async () => {
  const appliedThemes: DesktopThemeState[] = [];
  const client = createDesktopPreferencesClient({});

  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme(theme) {
      appliedThemes.push(theme);
    },
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  const savedThemePromise = service.setThemeSource("dark");

  assert.deepEqual(client.updatedRequests, [
    {
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: "coding",
      agentDockLayout: "unified",
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
      themeSource: "dark",
      updateChannel: "stable",
      updatePolicy: "prompt"
    }
  ]);
  assert.deepEqual(service.store.theme, {
    appearance: "dark",
    source: "dark"
  });
  assert.deepEqual(appliedThemes, [
    {
      appearance: "dark",
      source: "dark"
    }
  ]);

  client.emitDesktopPreferencesUpdated({
    agentComposerDefaultsByProvider: {},
    agentComposerDefaultsByAgentTarget: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
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
    themeSource: "dark",
    updateChannel: "stable",
    updatePolicy: "prompt"
  });

  assert.deepEqual(await savedThemePromise, {
    appearance: "dark",
    source: "dark"
  });
  assert.deepEqual(service.store.theme, {
    appearance: "dark",
    source: "dark"
  });

  service.dispose();
});

test("DesktopPreferencesService rolls back optimistic theme changes when publishing fails", async () => {
  const appliedThemes: DesktopThemeState[] = [];
  const client = createDesktopPreferencesClient({
    updateDesktopPreferences: async () => {
      throw new Error("publish failed");
    }
  });

  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme(theme) {
      appliedThemes.push(theme);
    },
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  await assert.rejects(() => service.setThemeSource("dark"), /publish failed/);

  assert.deepEqual(service.store.theme, {
    appearance: "light",
    source: "system"
  });
  assert.deepEqual(appliedThemes, [
    {
      appearance: "dark",
      source: "dark"
    },
    {
      appearance: "light",
      source: "system"
    }
  ]);

  service.dispose();
});

test("DesktopPreferencesService publishes prevent sleep preference writes", async () => {
  const client = createDesktopPreferencesClient({});

  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  const savedPreferencePromise =
    service.setSleepPreventionMode("whileAgentRunning");

  assert.deepEqual(client.updatedRequests, [
    {
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: "coding",
      agentDockLayout: "unified",
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
      sleepPreventionMode: "whileAgentRunning",
      showAppDeveloperSources: false,
      themeSource: "system",
      updateChannel: "stable",
      updatePolicy: "prompt"
    }
  ]);
  assert.equal(service.store.sleepPreventionMode, "whileAgentRunning");

  client.emitDesktopPreferencesUpdated({
    agentComposerDefaultsByProvider: {},
    agentComposerDefaultsByAgentTarget: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
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
    sleepPreventionMode: "whileAgentRunning",
    showAppDeveloperSources: false,
    themeSource: "system",
    updateChannel: "stable",
    updatePolicy: "prompt"
  });

  assert.equal(await savedPreferencePromise, "whileAgentRunning");
  assert.equal(service.store.sleepPreventionMode, "whileAgentRunning");

  service.dispose();
});

test("DesktopPreferencesService publishes update preference writes", async () => {
  const client = createDesktopPreferencesClient({});

  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  const savedPreferencePromise = service.setUpdatePolicy("auto");

  assert.deepEqual(client.updatedRequests, [
    {
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: "coding",
      agentDockLayout: "unified",
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
      updatePolicy: "auto"
    }
  ]);
  assert.equal(service.store.updatePolicy, "auto");

  client.emitDesktopPreferencesUpdated({
    agentComposerDefaultsByProvider: {},
    agentComposerDefaultsByAgentTarget: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
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
    updatePolicy: "auto"
  });

  assert.equal(await savedPreferencePromise, "auto");
  assert.equal(service.store.updatePolicy, "auto");

  const savedChannelPromise = service.setUpdateChannel("rc");
  assert.equal(client.updatedRequests.at(-1)?.updateChannel, "rc");
  client.emitDesktopPreferencesUpdated(client.updatedRequests.at(-1)!);

  assert.equal(await savedChannelPromise, "rc");
  assert.equal(service.store.updateChannel, "rc");

  service.dispose();
});

test("DesktopPreferencesService publishes app catalog channel writes", async () => {
  const client = createDesktopPreferencesClient({});
  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });
  await settle();

  const savedChannelPromise = service.setAppCatalogChannel("staging");

  assert.equal(client.updatedRequests.at(-1)?.appCatalogChannel, "staging");
  assert.equal(service.store.appCatalogChannel, "staging");
  client.emitDesktopPreferencesUpdated(client.updatedRequests.at(-1)!);

  assert.equal(await savedChannelPromise, "staging");
  assert.equal(service.store.appCatalogChannel, "staging");

  service.dispose();
});

test("DesktopPreferencesService publishes app developer source display writes", async () => {
  const client = createDesktopPreferencesClient({});
  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });
  await settle();

  const savedShowPromise = service.setShowAppDeveloperSources(true);

  assert.equal(client.updatedRequests.at(-1)?.showAppDeveloperSources, true);
  assert.equal(service.store.showAppDeveloperSources, true);
  client.emitDesktopPreferencesUpdated(client.updatedRequests.at(-1)!);

  assert.equal(await savedShowPromise, true);
  assert.equal(service.store.showAppDeveloperSources, true);

  service.dispose();
});

test("DesktopPreferencesService publishes agent conversation detail mode writes", async () => {
  const client = createDesktopPreferencesClient({});
  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });
  await settle();

  const savedModePromise = service.setAgentConversationDetailMode("general");

  assert.equal(
    client.updatedRequests.at(-1)?.agentConversationDetailMode,
    "general"
  );
  assert.equal(service.store.agentConversationDetailMode, "general");
  assert.equal(service.store.changingAgentConversationDetailMode, "general");
  client.emitDesktopPreferencesUpdated(client.updatedRequests.at(-1)!);

  assert.equal(await savedModePromise, "general");
  assert.equal(service.store.agentConversationDetailMode, "general");
  assert.equal(service.store.changingAgentConversationDetailMode, null);

  service.dispose();
});

test("DesktopPreferencesService publishes dock placement preference writes", async () => {
  const client = createDesktopPreferencesClient({});

  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  const savedPreferencePromise = service.setDockPlacement("left");

  assert.deepEqual(client.updatedRequests, [
    {
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: "coding",
      agentDockLayout: "unified",
      appCatalogChannel: "production",
      browserUseConnectionMode: "isolated",
      defaultAgentProvider: "codex",
      featureFlags: {},
      workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
      dockIconStyle: "default",
      dockPlacement: "left",
      fileDefaultOpenersByExtension: { html: "defaultBrowser" },
      locale: "en",
      minimizeAnimation: "scale",
      sleepPreventionMode: "never",
      showAppDeveloperSources: false,
      themeSource: "system",
      updateChannel: "stable",
      updatePolicy: "prompt"
    }
  ]);
  assert.equal(service.store.dockPlacement, "left");

  client.emitDesktopPreferencesUpdated({
    agentComposerDefaultsByProvider: {},
    agentComposerDefaultsByAgentTarget: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
    appCatalogChannel: "production",
    browserUseConnectionMode: "isolated",
    defaultAgentProvider: "codex",
    featureFlags: {},
    workbenchShortcuts: defaultDesktopWorkbenchShortcuts,
    dockIconStyle: "default",
    dockPlacement: "left",
    fileDefaultOpenersByExtension: { html: "defaultBrowser" },
    locale: "en",
    minimizeAnimation: "scale",
    sleepPreventionMode: "never",
    showAppDeveloperSources: false,
    themeSource: "system",
    updateChannel: "stable",
    updatePolicy: "prompt"
  });

  assert.equal(await savedPreferencePromise, "left");
  assert.equal(service.store.dockPlacement, "left");

  service.dispose();
});

test("DesktopPreferencesService publishes workbench window snapping preference writes", async () => {
  const client = createDesktopPreferencesClient({});

  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  const savedPreferencePromise = service.setWorkbenchWindowSnapping({
    enabled: true,
    shortcutPreset: "commandShiftArrows"
  });

  assert.deepEqual(client.updatedRequests, [
    {
      agentComposerDefaultsByProvider: {},
      agentGuiConversationRailCollapsedByProvider: {},
      agentConversationDetailMode: "coding",
      agentDockLayout: "unified",
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
      workbenchWindowSnapping: {
        enabled: true,
        shortcutPreset: "commandShiftArrows"
      }
    }
  ]);
  assert.deepEqual(service.store.workbenchWindowSnapping, {
    enabled: true,
    shortcutPreset: "commandShiftArrows"
  });

  client.emitDesktopPreferencesUpdated(client.updatedRequests.at(-1)!);

  assert.deepEqual(await savedPreferencePromise, {
    enabled: true,
    shortcutPreset: "commandShiftArrows"
  });
  assert.deepEqual(service.store.workbenchWindowSnapping, {
    enabled: true,
    shortcutPreset: "commandShiftArrows"
  });

  service.dispose();
});

test("DesktopPreferencesService includes default workbench window snapping when explicitly changed", async () => {
  const client = createDesktopPreferencesClient({});

  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  const savedPreferencePromise = service.setWorkbenchWindowSnapping({
    enabled: false,
    shortcutPreset: "commandArrows"
  });

  assert.deepEqual(client.updatedRequests.at(-1)?.workbenchWindowSnapping, {
    enabled: false,
    shortcutPreset: "commandArrows"
  });

  client.emitDesktopPreferencesUpdated(client.updatedRequests.at(-1)!);

  assert.deepEqual(await savedPreferencePromise, {
    enabled: false,
    shortcutPreset: "commandArrows"
  });
  assert.deepEqual(service.store.workbenchWindowSnapping, {
    enabled: false,
    shortcutPreset: "commandArrows"
  });

  service.dispose();
});

test("DesktopPreferencesService applies HTTP-confirmed authoritative preferences to store", async () => {
  const tuttidClient = createSequentialTuttidClient([
    {
      initialized: true,
      preferences: {
        agentComposerDefaultsByProvider: {},
        agentComposerDefaultsByAgentTarget: {},
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        agentDockLayout: "unified",
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
      }
    },
    {
      initialized: true,
      preferences: {
        agentComposerDefaultsByProvider: {},
        agentComposerDefaultsByAgentTarget: {},
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        agentDockLayout: "unified",
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
    }
  ]);
  const client = createDesktopPreferencesFeatureClient(
    tuttidClient,
    createFallbackConfirmingEventStreamClient(),
    {
      authoritativeEventTimeoutMs: 0
    }
  );
  const appliedLocales: DesktopLocale[] = [];
  const appliedThemes: DesktopThemeState[] = [];

  const service = new DesktopPreferencesService({
    applyLocale(locale) {
      appliedLocales.push(locale);
    },
    applyTheme(theme) {
      appliedThemes.push(theme);
    },
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  const savedLocale = await service.setLocale("zh-CN");

  assert.equal(savedLocale, "zh-CN");
  assert.equal(service.store.locale, "zh-CN");
  assert.deepEqual(service.store.theme, {
    appearance: "light",
    source: "system"
  });
  assert.deepEqual(appliedLocales, ["zh-CN"]);
  assert.deepEqual(appliedThemes, []);
  assert.equal(tuttidClient.getDesktopPreferencesCalls, 2);

  service.dispose();
});

test("DesktopPreferencesService keeps featureFlags store identity when an authoritative snapshot leaves flags unchanged", async () => {
  const initialFeatureFlags = { "lab.enabled": true };
  const client = createDesktopPreferencesClient({
    getDesktopPreferences: async () => ({
      initialized: true,
      preferences: {
        agentComposerDefaultsByProvider: {},
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        agentDockLayout: "legacySplit",
        appCatalogChannel: "production",
        browserUseConnectionMode: "isolated",
        defaultAgentProvider: "codex",
        featureFlags: initialFeatureFlags,
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
      }
    })
  });

  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();
  const featureFlagsBeforeUpdate = service.store.featureFlags;
  assert.deepEqual(featureFlagsBeforeUpdate, { "lab.enabled": true });

  client.emitDesktopPreferencesUpdated({
    agentComposerDefaultsByProvider: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    agentDockLayout: "legacySplit",
    appCatalogChannel: "production",
    browserUseConnectionMode: "isolated",
    defaultAgentProvider: "codex",
    featureFlags: { "lab.enabled": true },
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

  assert.equal(service.store.locale, "zh-CN");
  assert.ok(
    desktopFeatureFlagsEqual(service.store.featureFlags, {
      "lab.enabled": true
    })
  );
  assert.equal(
    service.store.featureFlags,
    featureFlagsBeforeUpdate,
    "featureFlags reference should stay identical when the authoritative snapshot leaves the flags unchanged"
  );

  service.dispose();
});

test("DesktopPreferencesService rejects mismatched App Center source confirmations", async () => {
  const tuttidClient = createSequentialTuttidClient([
    {
      initialized: true,
      preferences: {
        agentComposerDefaultsByProvider: {},
        agentComposerDefaultsByAgentTarget: {},
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        agentDockLayout: "unified",
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
      }
    },
    {
      initialized: true,
      preferences: {
        agentComposerDefaultsByProvider: {},
        agentComposerDefaultsByAgentTarget: {},
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        agentDockLayout: "unified",
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
      }
    }
  ]);
  const client = createDesktopPreferencesFeatureClient(
    tuttidClient,
    createFallbackConfirmingEventStreamClient(),
    {
      authoritativeEventTimeoutMs: 0
    }
  );
  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });

  await settle();

  await assert.rejects(
    () => service.setAppCatalogChannel("staging"),
    /authoritative update did not arrive/u
  );
  assert.equal(service.store.appCatalogChannel, "production");
  assert.equal(tuttidClient.getDesktopPreferencesCalls, 2);

  service.dispose();
});

test("DesktopPreferencesService remembers agent composer defaults per agent target", async () => {
  const patches: Array<{ agentTargetId: string; patch: unknown }> = [];
  const client = createDesktopPreferencesClient({
    patchAgentComposerDefaultsForTarget: async (input) => {
      patches.push({ agentTargetId: input.agentTargetId, patch: input.patch });
    }
  });
  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });
  await settle();

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
    patch: {
      model: "gpt-5-codex",
      speed: null
    }
  });

  service.dispose();
});

test("DesktopPreferencesService remembers agent GUI conversation rail collapsed state per provider", async () => {
  const client = createDesktopPreferencesClient({});
  const service = new DesktopPreferencesService({
    applyLocale() {},
    applyTheme() {},
    client,
    initialLocale: "en",
    initialTheme: {
      appearance: "light",
      source: "system"
    },
    resolveTheme
  });
  await settle();

  const rememberPromise = service.rememberAgentGuiConversationRailCollapsed(
    "codex",
    true
  );

  assert.deepEqual(client.updatedRequests.at(-1), {
    agentComposerDefaultsByProvider: {},
    agentGuiConversationRailCollapsedByProvider: {
      codex: true
    },
    agentConversationDetailMode: "coding",
    agentDockLayout: "unified",
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
  client.emitDesktopPreferencesUpdated(client.updatedRequests.at(-1)!);

  await rememberPromise;
  assert.deepEqual(service.store.agentGuiConversationRailCollapsedByProvider, {
    codex: true
  });

  service.dispose();
});

interface FakeDesktopPreferencesClient extends DesktopPreferencesClient {
  emitDesktopPreferencesUpdated(
    preferences: DesktopPreferencesStateResponse["preferences"]
  ): void;
  updatedRequests: DesktopPreferencesStateResponse["preferences"][];
}

function createDesktopPreferencesClient(
  overrides: Partial<DesktopPreferencesClient>
): FakeDesktopPreferencesClient {
  const listeners = new Set<
    (preferences: DesktopPreferencesStateResponse["preferences"]) => void
  >();
  const updatedRequests: DesktopPreferencesStateResponse["preferences"][] = [];
  const pendingUpdates = new Set<{
    reject: (error: Error) => void;
    request: DesktopPreferencesStateResponse["preferences"];
    resolve: (
      preferences: DesktopPreferencesStateResponse["preferences"]
    ) => void;
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
      for (const listener of listeners) {
        listener(preferences);
      }

      for (const pendingUpdate of [...pendingUpdates]) {
        if (
          JSON.stringify(
            pendingUpdate.request.agentComposerDefaultsByProvider
          ) !== JSON.stringify(preferences.agentComposerDefaultsByProvider) ||
          JSON.stringify(
            pendingUpdate.request.agentGuiConversationRailCollapsedByProvider
          ) !==
            JSON.stringify(
              preferences.agentGuiConversationRailCollapsedByProvider
            ) ||
          pendingUpdate.request.agentConversationDetailMode !==
            preferences.agentConversationDetailMode ||
          pendingUpdate.request.agentDockLayout !==
            preferences.agentDockLayout ||
          pendingUpdate.request.browserUseConnectionMode !==
            preferences.browserUseConnectionMode ||
          pendingUpdate.request.appCatalogChannel !==
            preferences.appCatalogChannel ||
          pendingUpdate.request.locale !== preferences.locale ||
          pendingUpdate.request.defaultAgentProvider !==
            preferences.defaultAgentProvider ||
          pendingUpdate.request.dockIconStyle !== preferences.dockIconStyle ||
          pendingUpdate.request.dockPlacement !== preferences.dockPlacement ||
          pendingUpdate.request.sleepPreventionMode !==
            preferences.sleepPreventionMode ||
          pendingUpdate.request.showAppDeveloperSources !==
            preferences.showAppDeveloperSources ||
          pendingUpdate.request.themeSource !== preferences.themeSource ||
          pendingUpdate.request.updateChannel !== preferences.updateChannel ||
          pendingUpdate.request.updatePolicy !== preferences.updatePolicy ||
          JSON.stringify(pendingUpdate.request.workbenchWindowSnapping) !==
            JSON.stringify(preferences.workbenchWindowSnapping)
        ) {
          continue;
        }

        pendingUpdates.delete(pendingUpdate);
        pendingUpdate.resolve(preferences);
      }
    },
    getDesktopPreferences: async () => ({
      initialized: true,
      preferences: {
        agentComposerDefaultsByProvider: {},
        agentComposerDefaultsByAgentTarget: {},
        agentGuiConversationRailCollapsedByProvider: {},
        agentConversationDetailMode: "coding",
        agentDockLayout: "unified",
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
      }
    }),
    updateDesktopPreferences: async (request) => {
      updatedRequests.push(request.preferences);
      return await new Promise<DesktopPreferencesStateResponse["preferences"]>(
        (resolve, reject) => {
          pendingUpdates.add({
            reject,
            request: request.preferences,
            resolve
          });
        }
      );
    },
    updatedRequests,
    subscribeToDesktopPreferencesUpdated(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ...overrides,
    patchAgentComposerDefaultsForTarget:
      overrides.patchAgentComposerDefaultsForTarget ?? (async () => {})
  };
}

function resolveTheme(source: DesktopThemeSource): DesktopThemeState {
  return {
    appearance: source === "dark" ? "dark" : "light",
    source
  };
}

function createSequentialTuttidClient(
  responses: DesktopPreferencesStateResponse[]
): Pick<TuttidClient, "getDesktopPreferences"> & {
  getDesktopPreferencesCalls: number;
} {
  assert.ok(
    responses.length > 0,
    "createSequentialTuttidClient requires at least one response."
  );
  let getDesktopPreferencesCalls = 0;
  const fallbackResponse = responses[responses.length - 1]!;

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
    dispose: () => {
      listeners.clear();
    },
    async publishIntent(_topic, _payload) {},
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

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
