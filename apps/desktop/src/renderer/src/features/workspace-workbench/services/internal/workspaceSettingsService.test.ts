import assert from "node:assert/strict";
import test from "node:test";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { DesktopThemeState } from "@shared/theme";
import type { IDesktopPreferencesService } from "../../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import type { DesktopPreferencesReadableStoreState } from "../../../desktop-preferences/services/desktopPreferencesTypes.ts";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import type { DesktopWorkspaceSettingsClient } from "./adapters/desktopWorkspaceSettingsClient.ts";
import { WorkspaceSettingsService } from "./workspaceSettingsService.ts";

test("WorkspaceSettingsService keeps the selected section while the same workspace stays active", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.openPanel({ id: "workspace-1" });
  service.selectSection("appearance");
  service.syncWorkspace({ id: "workspace-1" });

  assert.equal(service.store.activeSection, "appearance");
  assert.equal(service.store.workspaceID, "workspace-1");
});

test("WorkspaceSettingsService resets panel-local state when switching workspaces", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.openPanel({ id: "workspace-1" });
  service.selectSection("developer");

  service.syncWorkspace({ id: "workspace-2" });

  assert.equal(service.store.activeSection, "general");
  assert.equal(service.store.workspaceID, "workspace-2");
});

test("WorkspaceSettingsService hides the developer panel by default", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  assert.equal(service.store.developerPanelVisible, false);
});

test("WorkspaceSettingsService reveals the developer panel", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.setDeveloperPanelVisible(true);

  assert.equal(service.store.developerPanelVisible, true);
});

test("WorkspaceSettingsService leaves the developer panel when it is hidden", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.setDeveloperPanelVisible(true);
  service.openPanel({ id: "workspace-1" });
  service.selectSection("developer");

  service.setDeveloperPanelVisible(false);

  assert.equal(service.store.developerPanelVisible, false);
  assert.equal(service.store.activeSection, "general");
});

test("WorkspaceSettingsService keeps the active section when hiding from elsewhere", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.setDeveloperPanelVisible(true);
  service.openPanel({ id: "workspace-1" });
  service.selectSection("appearance");

  service.setDeveloperPanelVisible(false);

  assert.equal(service.store.activeSection, "appearance");
});

test("WorkspaceSettingsService opens the managed models pane with a focused provider", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.openPanel(
    { id: "workspace-1" },
    {
      pane: "managed-models",
      provider: "anthropic",
      section: "general"
    }
  );

  assert.equal(service.store.activeSection, "apps");
  assert.equal(service.store.managedModels.focusedProvider, "anthropic");
  assert.equal(service.store.managedModels.focusRequestID, 1);

  service.openPanel(
    { id: "workspace-1" },
    {
      pane: "managed-models",
      provider: "anthropic"
    }
  );

  assert.equal(service.store.managedModels.focusedProvider, "anthropic");
  assert.equal(service.store.managedModels.focusRequestID, 2);
});

test("WorkspaceSettingsService tolerates provider configs with null models", async () => {
  const notifications = createNotificationRecorder();
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({
        listManagedModelProviders: async () => [
          {
            enabled: true,
            hasApiKey: true,
            models: null,
            provider: "agnes"
          } as unknown as Awaited<
            ReturnType<
              DesktopWorkspaceSettingsClient["listManagedModelProviders"]
            >
          >[number]
        ]
      })
    },
    createDesktopPreferencesService({
      state: createPreferencesState({})
    }),
    notifications.service
  );

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);

  const agnesProvider = service.store.managedModels.providers.find(
    (provider) => provider.provider === "agnes"
  );
  assert.deepEqual(agnesProvider?.models, []);
  assert.deepEqual(notifications.items, []);
});

test("WorkspaceSettingsService echoes saved managed provider API keys", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listManagedModelProviders: async () => [
        {
          apiKey: "agnes-secret",
          baseUrl: "https://apihub.agnes-ai.com/v1",
          enabled: true,
          hasApiKey: true,
          models: [],
          provider: "agnes"
        }
      ]
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);

  const agnesProvider = service.store.managedModels.providers.find(
    (provider) => provider.provider === "agnes"
  );
  assert.equal(agnesProvider?.apiKey, "agnes-secret");
});

test("WorkspaceSettingsService fills detected managed provider models", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listManagedModelProviders: async () => [
        {
          apiKey: "agnes-secret",
          baseUrl: "https://apihub.agnes-ai.com/v1",
          enabled: true,
          hasApiKey: true,
          models: [],
          provider: "agnes"
        }
      ],
      listManagedModelProviderModels: async () => [
        {
          id: "agnes-2.0-flash",
          name: "Agnes 2.0 Flash",
          provider: "agnes"
        }
      ]
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  await service.detectManagedModelProviderModels("agnes");

  const agnesProvider = service.store.managedModels.providers.find(
    (provider) => provider.provider === "agnes"
  );
  assert.deepEqual(agnesProvider?.models, [
    {
      id: "agnes-2.0-flash",
      name: "Agnes 2.0 Flash",
      provider: "agnes"
    }
  ]);
});

test("WorkspaceSettingsService lists only saved managed providers", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listManagedModelProviders: async () => [
        {
          enabled: true,
          hasApiKey: true,
          models: [],
          provider: "openai"
        }
      ]
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);

  assert.deepEqual(
    service.store.managedModels.providers.map((provider) => provider.provider),
    ["openai"]
  );
});

test("WorkspaceSettingsService starts a draft for an unconfigured provider", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.openPanel({ id: "workspace-1" });
  service.beginManagedModelProviderDraft("openai");

  assert.equal(service.store.managedModels.draft?.provider, "openai");
  assert.equal(service.store.managedModels.draft?.enabled, true);
});

test("WorkspaceSettingsService refuses a draft for a configured provider", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listManagedModelProviders: async () => [
        {
          enabled: true,
          hasApiKey: true,
          models: [],
          provider: "openai"
        }
      ]
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  service.beginManagedModelProviderDraft("openai");

  assert.equal(service.store.managedModels.draft, null);
});

test("WorkspaceSettingsService edits and cancels a draft", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.openPanel({ id: "workspace-1" });
  service.beginManagedModelProviderDraft("openai");
  service.updateManagedModelDraft({ apiKey: "sk-test" });

  assert.equal(service.store.managedModels.draft?.apiKey, "sk-test");

  service.cancelManagedModelProviderDraft();

  assert.equal(service.store.managedModels.draft, null);
});

test("WorkspaceSettingsService saves a draft into the provider list", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  service.beginManagedModelProviderDraft("openai");
  service.updateManagedModelDraft({
    apiKey: "sk-test",
    models: [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }]
  });
  await service.saveManagedModelDraft();

  assert.equal(service.store.managedModels.draft, null);
  assert.deepEqual(
    service.store.managedModels.providers.map((provider) => provider.provider),
    ["openai"]
  );
  assert.equal(
    service.store.managedModels.providers.find(
      (provider) => provider.provider === "openai"
    )?.hasApiKey,
    true
  );
});

test("WorkspaceSettingsService persists a provider toggle immediately", async () => {
  const puts: Array<{ enabled: boolean; hasApiKey: boolean }> = [];
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listManagedModelProviders: async () => [
        {
          enabled: true,
          hasApiKey: true,
          models: [],
          provider: "openai"
        }
      ],
      putManagedModelProvider: async (_workspaceID, providerID, input) => {
        puts.push({
          enabled: input.enabled,
          hasApiKey: Boolean(input.apiKey)
        });
        return {
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          hasApiKey: true,
          models: input.models,
          provider: providerID
        };
      }
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  await service.setManagedModelProviderEnabled("openai", false);

  assert.equal(
    service.store.managedModels.providers.find(
      (provider) => provider.provider === "openai"
    )?.enabled,
    false
  );
  assert.deepEqual(puts, [{ enabled: false, hasApiKey: false }]);
});

test("WorkspaceSettingsService records an inline test result without a toast", async () => {
  const notifications = createNotificationRecorder();
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({
        listManagedModelProviders: async () => [
          {
            baseUrl: "https://api.openai.com/v1",
            enabled: true,
            hasApiKey: true,
            models: [],
            provider: "openai"
          }
        ]
      })
    },
    createDesktopPreferencesService({ state: createPreferencesState({}) }),
    notifications.service
  );

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  await service.testManagedModelProvider("openai");

  assert.equal(service.store.managedModels.feedback.openai?.kind, "testOk");
  assert.deepEqual(notifications.items, []);
});

test("WorkspaceSettingsService records an inline test failure", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listManagedModelProviders: async () => [
        {
          baseUrl: "https://api.openai.com/v1",
          enabled: true,
          hasApiKey: true,
          models: [],
          provider: "openai"
        }
      ],
      testManagedModelProvider: async () => {
        throw new Error("nope");
      }
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  await service.testManagedModelProvider("openai");

  assert.equal(service.store.managedModels.feedback.openai?.kind, "testFailed");
});

test("WorkspaceSettingsService flags an empty model detection inline", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listManagedModelProviders: async () => [
        {
          baseUrl: "https://api.openai.com/v1",
          enabled: true,
          hasApiKey: true,
          models: [],
          provider: "openai"
        }
      ],
      listManagedModelProviderModels: async () => []
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  await service.detectManagedModelProviderModels("openai");

  assert.equal(
    service.store.managedModels.feedback.openai?.kind,
    "detectEmpty"
  );
});

test("WorkspaceSettingsService clears feedback when a provider is edited", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listManagedModelProviders: async () => [
        {
          baseUrl: "https://api.openai.com/v1",
          enabled: true,
          hasApiKey: true,
          models: [],
          provider: "openai"
        }
      ],
      testManagedModelProvider: async () => {
        throw new Error("nope");
      }
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  await service.testManagedModelProvider("openai");
  assert.equal(service.store.managedModels.feedback.openai?.kind, "testFailed");

  service.updateManagedModelProviderDraft("openai", { apiKey: "sk-new" });

  assert.equal(service.store.managedModels.feedback.openai, undefined);
});

test("WorkspaceSettingsService blocks a draft save without required fields", async () => {
  let putCalls = 0;
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      putManagedModelProvider: async (_workspaceID, providerID, input) => {
        putCalls += 1;
        return {
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          hasApiKey: Boolean(input.apiKey),
          models: input.models,
          provider: providerID
        };
      }
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  service.beginManagedModelProviderDraft("openai");
  service.updateManagedModelDraft({ baseUrl: "" });
  await service.saveManagedModelDraft();

  assert.equal(putCalls, 0);
  assert.equal(
    service.store.managedModels.feedback.openai?.kind,
    "requiredFields"
  );
  assert.notEqual(service.store.managedModels.draft, null);
});

test("WorkspaceSettingsService records a save failure inline without a toast", async () => {
  const notifications = createNotificationRecorder();
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({
        listManagedModelProviders: async () => [
          {
            baseUrl: "https://api.openai.com/v1",
            enabled: true,
            hasApiKey: true,
            models: [],
            provider: "openai"
          }
        ],
        putManagedModelProvider: async () => {
          throw new Error("nope");
        }
      })
    },
    createDesktopPreferencesService({ state: createPreferencesState({}) }),
    notifications.service
  );

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  const provider = service.store.managedModels.providers.find(
    (candidate) => candidate.provider === "openai"
  );
  assert.ok(provider);
  await service.saveManagedModelProvider(provider);

  assert.equal(service.store.managedModels.feedback.openai?.kind, "saveFailed");
  assert.deepEqual(notifications.items, []);
});

test("WorkspaceSettingsService still toasts when a provider toggle fails", async () => {
  const notifications = createNotificationRecorder();
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({
        listManagedModelProviders: async () => [
          {
            baseUrl: "https://api.openai.com/v1",
            enabled: true,
            hasApiKey: true,
            models: [],
            provider: "openai"
          }
        ],
        putManagedModelProvider: async () => {
          throw new Error("nope");
        }
      })
    },
    createDesktopPreferencesService({ state: createPreferencesState({}) }),
    notifications.service
  );

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  await service.setManagedModelProviderEnabled("openai", false);

  assert.equal(
    service.store.managedModels.providers.find(
      (candidate) => candidate.provider === "openai"
    )?.enabled,
    true
  );
  assert.equal(notifications.items.length, 1);
});

test("WorkspaceSettingsService drops a removed provider from the list", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listManagedModelProviders: async () => [
        {
          enabled: true,
          hasApiKey: true,
          models: [],
          provider: "openai"
        }
      ]
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.managedModels.loading === false);
  await service.removeManagedModelProvider("openai");

  assert.deepEqual(service.store.managedModels.providers, []);
});

test("WorkspaceSettingsService refreshes developer logs when opening the panel", async () => {
  let logRefreshes = 0;
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      getLogsState: async () => {
        logRefreshes += 1;

        return {
          desktopVersion: "0.0.0",
          files: [],
          logsDir: "",
          totalFiles: 0,
          totalSizeBytes: 0
        };
      }
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.developerLogs.loading === false);

  assert.equal(logRefreshes, 1);
  assert.equal(service.store.developerLogs.logs?.totalFiles, 0);
});

test("WorkspaceSettingsService does not restart log refresh while already open", async () => {
  let logRefreshes = 0;
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      getLogsState: async () => {
        logRefreshes += 1;

        return {
          desktopVersion: "0.0.0",
          files: [],
          logsDir: "",
          totalFiles: 0,
          totalSizeBytes: 0
        };
      }
    })
  });

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.developerLogs.loading === false);
  service.openPanel({ id: "workspace-1" });

  assert.equal(logRefreshes, 1);
});

test("WorkspaceSettingsService skips unchanged locale writes", async () => {
  const writes: string[] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({})
    },
    createDesktopPreferencesService({
      onSetLocale: async (locale) => {
        writes.push(locale);
        return locale;
      },
      state: createPreferencesState({
        locale: "zh-CN"
      })
    })
  );

  await service.changeLocale("zh-CN");

  assert.deepEqual(writes, []);
});

test("WorkspaceSettingsService skips pending locale writes", async () => {
  const writes: string[] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({})
    },
    createDesktopPreferencesService({
      onSetLocale: async (locale) => {
        writes.push(locale);
        return locale;
      },
      state: createPreferencesState({
        changingLocale: "en"
      })
    })
  );

  await service.changeLocale("en");

  assert.deepEqual(writes, []);
});

test("WorkspaceSettingsService writes changed preferences", async () => {
  const writes: string[] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({})
    },
    createDesktopPreferencesService({
      onSetLocale: async (locale) => {
        writes.push(locale);
        return locale;
      },
      onSetDockPlacement: async (placement) => {
        writes.push(placement);
        return placement;
      },
      onSetDefaultAgentProvider: async (provider) => {
        writes.push(provider);
        return provider;
      },
      onSetThemeSource: async (source) => {
        writes.push(source);
        return createTheme(source);
      },
      state: createPreferencesState({})
    })
  );

  await service.changeLocale("zh-CN");
  await service.changeDockPlacement("left");
  await service.changeDefaultAgentProvider("claude-code");
  await service.changeThemeSource("dark");

  assert.deepEqual(writes, ["zh-CN", "left", "claude-code", "dark"]);
});

test("WorkspaceSettingsService reports preference save failures", async () => {
  const notifications = createNotificationRecorder();
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({})
    },
    createDesktopPreferencesService({
      onSetLocale: async () => {
        throw new Error("locale failed");
      },
      onSetDockPlacement: async () => {
        throw new Error("dock placement failed");
      },
      onSetDefaultAgentProvider: async () => {
        throw new Error("provider failed");
      },
      onSetThemeSource: async () => {
        throw new Error("theme failed");
      },
      state: createPreferencesState({})
    }),
    notifications.service
  );

  await service.changeLocale("zh-CN");
  await service.changeDockPlacement("left");
  await service.changeDefaultAgentProvider("claude-code");
  await service.changeThemeSource("dark");

  assert.deepEqual(notifications.items, [
    "We couldn't switch the app language right now.",
    "We couldn't update the dock layout right now.",
    "We couldn't update the default provider right now.",
    "We couldn't switch the app appearance right now."
  ]);
});

test("WorkspaceSettingsService tracks settings panel open and section switches", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({})
    },
    createDesktopPreferencesService({
      state: createPreferencesState({})
    }),
    createNotificationRecorder().service,
    createReporterService(reporterCalls),
    () => 1749124800000
  );

  service.openPanel({ id: "workspace-1" });
  service.selectSection("developer");

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "settings.opened",
        params: {}
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "settings.section_switched",
        params: {
          section: "developer"
        }
      }
    ]
  ]);
});

test("WorkspaceSettingsService tracks theme changes without developer log clear analytics", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({})
    },
    createDesktopPreferencesService({
      onSetThemeSource: async (source) => createTheme(source),
      state: createPreferencesState({
        theme: createTheme("system")
      })
    }),
    createNotificationRecorder().service,
    createReporterService(reporterCalls),
    () => 1749124800000
  );

  await service.changeThemeSource("dark");
  await service.clearDeveloperLogs();

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "settings.theme_changed",
        params: {
          from_theme: "system",
          to_theme: "dark"
        }
      }
    ]
  ]);
});

test("WorkspaceSettingsService tracks language changes", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({})
    },
    createDesktopPreferencesService({
      onSetLocale: async (locale) => locale,
      state: createPreferencesState({
        locale: "en"
      })
    }),
    createNotificationRecorder().service,
    createReporterService(reporterCalls),
    () => 1749124800000
  );

  await service.changeLocale("zh-CN");

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "settings.language_changed",
        params: {
          from_language: "en",
          to_language: "zh-CN"
        }
      }
    ]
  ]);
});

function createWorkspaceSettingsClient(
  overrides: Partial<DesktopWorkspaceSettingsClient>
): DesktopWorkspaceSettingsClient {
  return {
    clearLogs: async () => ({
      clearedFiles: 0,
      clearedPaths: [],
      clearedSizeBytes: 0
    }),
    exportLogs: async () => ({
      canceled: true,
      fileCount: 0,
      filePath: null
    }),
    deleteManagedModelProvider: async () => {},
    getLogsState: async () => ({
      desktopVersion: "0.0.0",
      files: [],
      logsDir: "",
      totalFiles: 0,
      totalSizeBytes: 0
    }),
    listManagedModelProviders: async () => [],
    listManagedModelProviderModels: async () => [],
    openLogDirectory: async () => {},
    openLogFile: async () => {},
    putManagedModelProvider: async (_workspaceID, providerID, input) => ({
      baseUrl: input.baseUrl,
      enabled: input.enabled,
      hasApiKey: Boolean(input.apiKey),
      models: input.models,
      provider: providerID
    }),
    testManagedModelProvider: async () => {},
    ...overrides
  };
}

function createDesktopPreferencesService(input: {
  onSetDefaultAgentProvider?: IDesktopPreferencesService["setDefaultAgentProvider"];
  onSetBrowserUseConnectionMode?: IDesktopPreferencesService["setBrowserUseConnectionMode"];
  onSetDockIconStyle?: IDesktopPreferencesService["setDockIconStyle"];
  onSetDockPlacement?: IDesktopPreferencesService["setDockPlacement"];
  onSetLocale?: IDesktopPreferencesService["setLocale"];
  onSetSleepPreventionMode?: IDesktopPreferencesService["setSleepPreventionMode"];
  onSetThemeSource?: IDesktopPreferencesService["setThemeSource"];
  onSetUpdateChannel?: IDesktopPreferencesService["setUpdateChannel"];
  onSetUpdatePolicy?: IDesktopPreferencesService["setUpdatePolicy"];
  state: DesktopPreferencesReadableStoreState;
}): IDesktopPreferencesService {
  return {
    _serviceBrand: undefined,
    store: input.state,
    rememberAgentComposerDefaults: async () => {},
    setBrowserUseConnectionMode:
      input.onSetBrowserUseConnectionMode ?? (async (mode) => mode),
    setDefaultAgentProvider:
      input.onSetDefaultAgentProvider ?? (async (provider) => provider),
    setDockIconStyle: input.onSetDockIconStyle ?? (async (style) => style),
    setDockPlacement:
      input.onSetDockPlacement ?? (async (placement) => placement),
    setLocale: input.onSetLocale ?? (async (locale) => locale),
    setSleepPreventionMode:
      input.onSetSleepPreventionMode ?? (async (enabled) => enabled),
    setThemeSource:
      input.onSetThemeSource ?? (async (source) => createTheme(source)),
    setUpdateChannel: input.onSetUpdateChannel ?? (async (channel) => channel),
    setUpdatePolicy: input.onSetUpdatePolicy ?? (async (policy) => policy)
  };
}

function createPreferencesState(
  overrides: Partial<DesktopPreferencesReadableStoreState>
): DesktopPreferencesReadableStoreState {
  return {
    agentComposerDefaultsByProvider: {},
    browserUseConnectionMode: "isolated",
    changingBrowserUseConnectionMode: null,
    changingDefaultAgentProvider: null,
    changingDockIconStyle: null,
    changingDockPlacement: null,
    changingLocale: null,
    changingSleepPreventionMode: null,
    changingThemeSource: null,
    changingUpdateChannel: null,
    changingUpdatePolicy: null,
    defaultAgentProvider: "codex",
    dockIconStyle: "default",
    dockPlacement: "bottom",
    locale: "en",
    sleepPreventionMode: "never",
    theme: createTheme("system"),
    updateChannel: "stable",
    updatePolicy: "prompt",
    ...overrides
  };
}

function createNotificationRecorder(): {
  items: string[];
  service: NotificationService;
} {
  const items: string[] = [];
  return {
    items,
    service: {
      _serviceBrand: undefined,
      error(input) {
        items.push(input.title);
      },
      info() {},
      notify(input) {
        items.push(input.title);
      },
      success() {},
      warning(input) {
        items.push(input.title);
      }
    }
  };
}

function createReporterService(calls: ReporterEventInput[][] = []) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      calls.push(events);
    }
  };
}

function createTheme(source: DesktopThemeState["source"]): DesktopThemeState {
  return {
    appearance: source === "dark" ? "dark" : "light",
    source
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 10; attempts += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  assert.fail("Timed out waiting for condition");
}
