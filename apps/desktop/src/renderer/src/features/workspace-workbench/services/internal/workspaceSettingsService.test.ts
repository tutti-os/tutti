import assert from "node:assert/strict";
import test from "node:test";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type { AgentTarget } from "@tutti-os/client-tuttid-ts";
import type { DesktopThemeState } from "@shared/theme";
import type { IDesktopPreferencesService } from "../../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import type { DesktopPreferencesReadableStoreState } from "../../../desktop-preferences/services/desktopPreferencesTypes.ts";
import type { ReporterEventInput } from "../../../analytics/services/reporterService.interface.ts";
import {
  AGENT_EXTENSION_ACTIVATION_FLAGS,
  AGENT_EXTENSION_GEMINI_FLAG,
  AGENT_QUICK_PROMPT_LIBRARY_FLAG,
  LAB_ENABLED_FLAG
} from "../../../../../../shared/featureFlags/catalog.ts";
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
  assert.equal(service.store.generalFocusAnchor, null);
  assert.equal(service.store.generalFocusRequestID, 0);
  assert.equal(service.store.workspaceID, "workspace-2");
});

test("WorkspaceSettingsService hides the developer panel by default", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  assert.equal(service.store.developerPanelVisible, false);
});

test("WorkspaceSettingsService reads Tutti Agent visibility from the daemon target", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listAgentTargets: async () => [createTuttiAgentTarget(true)]
    })
  });

  await waitForAsyncInitialization();

  assert.equal(service.store.tuttiAgentSwitchEnabled, true);
});

test("WorkspaceSettingsService persists Tutti Agent visibility before updating UI", async () => {
  let persisted: boolean | null = null;
  let refreshes = 0;
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listAgentTargets: async () => [createTuttiAgentTarget(true)],
      setSystemAgentTargetEnabled: async (_agentTargetID, enabled) => {
        persisted = enabled;
        return createTuttiAgentTarget(enabled);
      }
    }),
    onAgentTargetsChanged: async () => {
      refreshes += 1;
    }
  });
  await waitForAsyncInitialization();

  await service.setTuttiAgentSwitchEnabled(false);

  assert.equal(persisted, false);
  assert.equal(service.store.tuttiAgentSwitchEnabled, false);
  assert.equal(refreshes, 1);
});

test("WorkspaceSettingsService persists a system Agent Target enabled state and refreshes consumers", async () => {
  const writes: Array<{ agentTargetID: string; enabled: boolean }> = [];
  let refreshes = 0;
  const codexTarget: AgentTarget = {
    ...createTuttiAgentTarget(true),
    id: "local:codex",
    iconKey: "codex",
    launchRef: { provider: "codex", type: "builtin_local" },
    name: "Codex",
    provider: "codex"
  };
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      setSystemAgentTargetEnabled: async (agentTargetID, enabled) => {
        writes.push({ agentTargetID, enabled });
        return { ...codexTarget, enabled };
      }
    }),
    onAgentTargetsChanged: async () => {
      refreshes += 1;
    }
  });

  await service.setAgentTargetEnabled(" local:codex ", false);

  assert.deepEqual(writes, [{ agentTargetID: "local:codex", enabled: false }]);
  assert.equal(refreshes, 1);
});

test("WorkspaceSettingsService migrates a legacy switch value into the daemon once", async () => {
  const writes: boolean[] = [];
  let markedComplete = false;
  let refreshes = 0;
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listAgentTargets: async () => [createTuttiAgentTarget(true)],
      setSystemAgentTargetEnabled: async (_agentTargetID, enabled) => {
        writes.push(enabled);
        return createTuttiAgentTarget(enabled);
      }
    }),
    onAgentTargetsChanged: async () => {
      refreshes += 1;
    },
    tuttiAgentSwitchMigration: {
      clearComplete: () => {},
      hasMigrated: () => false,
      markComplete: () => {
        markedComplete = true;
        return true;
      },
      readLegacyEnabled: () => ({ enabled: false, status: "value" })
    }
  });

  await waitForAsyncInitialization();

  assert.deepEqual(writes, [false]);
  assert.equal(markedComplete, true);
  assert.equal(refreshes, 1);
  assert.equal(service.store.tuttiAgentSwitchEnabled, false);
});

test("WorkspaceSettingsService serializes startup initialization before a user toggle", async () => {
  const initialTargets = createDeferred<AgentTarget[]>();
  const writes: boolean[] = [];
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listAgentTargets: () => initialTargets.promise,
      setSystemAgentTargetEnabled: async (_agentTargetID, enabled) => {
        writes.push(enabled);
        return createTuttiAgentTarget(enabled);
      }
    }),
    tuttiAgentSwitchMigration: {
      clearComplete: () => {},
      hasMigrated: () => true,
      markComplete: () => true,
      readLegacyEnabled: () => ({ status: "missing" })
    }
  });

  const toggle = service.setTuttiAgentSwitchEnabled(false);
  initialTargets.resolve([createTuttiAgentTarget(true)]);
  await toggle;

  assert.deepEqual(writes, [false]);
  assert.equal(service.store.tuttiAgentSwitchEnabled, false);
});

test("WorkspaceSettingsService retries failed daemon initialization when settings opens", async () => {
  let attempts = 0;
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listAgentTargets: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("daemon starting");
        }
        return [createTuttiAgentTarget(true)];
      }
    })
  });
  await waitForAsyncInitialization();

  service.openPanel({ id: "workspace-1" });
  await waitFor(() => service.store.tuttiAgentSwitchEnabled);

  // The bindings refresh triggered by openPanel also lists agent targets, so
  // only require that the switch initialization retried at least once.
  assert.ok(attempts >= 2);
});

test("WorkspaceSettingsService leaves migration pending after a legacy read error", async () => {
  let markedComplete = false;
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listAgentTargets: async () => [createTuttiAgentTarget(true)]
    }),
    tuttiAgentSwitchMigration: {
      clearComplete: () => {},
      hasMigrated: () => false,
      markComplete: () => {
        markedComplete = true;
        return true;
      },
      readLegacyEnabled: () => ({ status: "error" })
    }
  });

  await waitForAsyncInitialization();

  assert.equal(markedComplete, false);
  assert.equal(service.store.tuttiAgentSwitchEnabled, false);
});

test("WorkspaceSettingsService does not apply legacy state when the migration marker cannot persist", async () => {
  const writes: boolean[] = [];
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listAgentTargets: async () => [createTuttiAgentTarget(true)],
      setSystemAgentTargetEnabled: async (_agentTargetID, enabled) => {
        writes.push(enabled);
        return createTuttiAgentTarget(enabled);
      }
    }),
    tuttiAgentSwitchMigration: {
      clearComplete: () => {},
      hasMigrated: () => false,
      markComplete: () => false,
      readLegacyEnabled: () => ({ enabled: false, status: "value" })
    }
  });

  await waitForAsyncInitialization();

  assert.deepEqual(writes, []);
  assert.equal(service.store.tuttiAgentSwitchEnabled, false);
});

test("WorkspaceSettingsService keeps daemon state when visibility update fails", async () => {
  const notifications = createNotificationRecorder();
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({
        listAgentTargets: async () => [createTuttiAgentTarget(true)],
        setSystemAgentTargetEnabled: async () => {
          throw new Error("daemon unavailable");
        }
      })
    },
    createDesktopPreferencesService({ state: createPreferencesState({}) }),
    notifications.service
  );
  await waitForAsyncInitialization();

  await service.setTuttiAgentSwitchEnabled(false);

  assert.equal(service.store.tuttiAgentSwitchEnabled, true);
  assert.equal(notifications.items.length, 1);
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

test("WorkspaceSettingsService opens the model plans pane for managed-models requests", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.openPanel(
    { id: "workspace-1" },
    {
      pane: "managed-models",
      section: "general"
    }
  );

  assert.equal(service.store.activeSection, "model");
});

test("WorkspaceSettingsService opens agent settings with a focused anchor", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.openPanel(
    { id: "workspace-1" },
    {
      anchor: "browser-use",
      section: "appearance"
    }
  );

  assert.equal(service.store.activeSection, "agent");
  assert.equal(service.store.generalFocusAnchor, "browser-use");
  assert.equal(service.store.generalFocusRequestID, 1);

  service.selectSection("appearance");
  service.openPanel(
    { id: "workspace-1" },
    {
      anchor: "computer-use"
    }
  );

  assert.equal(service.store.activeSection, "agent");
  assert.equal(service.store.generalFocusAnchor, "computer-use");
  assert.equal(service.store.generalFocusRequestID, 2);
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
      onSetAgentConversationDetailMode: async (mode) => {
        writes.push(mode);
        return mode;
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
  await service.changeAgentConversationDetailMode("general");
  await service.changeThemeSource("dark");

  assert.deepEqual(writes, ["zh-CN", "left", "claude-code", "general", "dark"]);
});

test("WorkspaceSettingsService changes workspace UI mode without replacing other flags", async () => {
  const writes: Array<Record<string, boolean>> = [];
  const replacements: Array<{ mode: string; workspaceId: string }> = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({}),
      replaceWorkspaceWindow: async (input) => {
        replacements.push(input);
      }
    },
    createDesktopPreferencesService({
      onSetFeatureFlags: async (flags) => {
        writes.push(flags);
        return flags;
      },
      state: createPreferencesState({
        featureFlags: { "lab.enabled": true }
      })
    })
  );

  service.openPanel({ id: "workspace-1" });
  await service.changeWorkspaceUiMode("agent");

  assert.deepEqual(writes, [
    {
      "lab.enabled": true,
      "workspace.standaloneAgentMode": true
    }
  ]);
  assert.deepEqual(replacements, [
    { mode: "agent", workspaceId: "workspace-1" }
  ]);
});

for (const flag of AGENT_EXTENSION_ACTIVATION_FLAGS) {
  test(`WorkspaceSettingsService refreshes Agent Targets after changing ${flag}`, async () => {
    assert.deepEqual(
      await changeFeatureFlagsAndRecordEffects({ next: { [flag]: true } }),
      ["save", "refresh"]
    );
  });
}

test("WorkspaceSettingsService does not refresh Agent Targets after changing an ordinary flag", async () => {
  assert.deepEqual(
    await changeFeatureFlagsAndRecordEffects({
      next: { [LAB_ENABLED_FLAG]: true }
    }),
    ["save"]
  );
});

test("WorkspaceSettingsService reports a quick prompt specific save failure", async () => {
  const notifications = createNotificationRecorder();
  const service = new WorkspaceSettingsService(
    { client: createWorkspaceSettingsClient({}) },
    createDesktopPreferencesService({
      onSetFeatureFlags: async () => {
        throw new Error("preferences unavailable");
      },
      state: createPreferencesState({ featureFlags: {} })
    }),
    notifications.service
  );

  await service.changeFeatureFlags({
    [AGENT_QUICK_PROMPT_LIBRARY_FLAG]: true
  });

  assert.equal(notifications.items.length, 1);
  assert.ok(
    notifications.items[0] ===
      "We couldn't update quick-prompt library availability." ||
      notifications.items[0] === "暂时无法更新快捷提示词库可用状态"
  );
});

test("WorkspaceSettingsService compares Agent Extension activation against pending flags", async () => {
  assert.deepEqual(
    await changeFeatureFlagsAndRecordEffects({
      changing: { [AGENT_EXTENSION_GEMINI_FLAG]: true },
      next: {
        [AGENT_EXTENSION_GEMINI_FLAG]: true,
        [LAB_ENABLED_FLAG]: true
      }
    }),
    ["save"]
  );
});

async function changeFeatureFlagsAndRecordEffects(input: {
  changing?: Record<string, boolean>;
  next: Record<string, boolean>;
}): Promise<string[]> {
  const effects: string[] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({}),
      onAgentTargetsChanged: async () => {
        effects.push("refresh");
      }
    },
    createDesktopPreferencesService({
      onSetFeatureFlags: async (flags) => {
        effects.push("save");
        return flags;
      },
      state: createPreferencesState({
        changingFeatureFlags: input.changing ?? null,
        featureFlags: {}
      })
    })
  );

  await service.changeFeatureFlags(input.next);
  return effects;
}

test("WorkspaceSettingsService refreshes App Center after changing catalog channel", async () => {
  const refreshedWorkspaceIDs: string[] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({})
    },
    createDesktopPreferencesService({
      onSetAppCatalogChannel: async (channel) => channel,
      state: createPreferencesState({})
    }),
    createNotificationRecorder().service,
    null,
    {
      refreshCatalog: async (workspaceID) => {
        refreshedWorkspaceIDs.push(workspaceID);
      }
    }
  );

  service.openPanel({ id: "workspace-1" });
  await service.changeAppCatalogChannel("staging");

  assert.deepEqual(refreshedWorkspaceIDs, ["workspace-1"]);
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
    null,
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
    null,
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

test("WorkspaceSettingsService forwards the selected developer log export options", async () => {
  const inputs: Array<{
    includeAgentSessions: boolean;
    scope: string;
  }> = [];
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      exportLogs: async (input) => {
        inputs.push(input);
        return {
          canceled: true,
          fileCount: 0,
          filePath: null
        };
      }
    })
  });

  await service.exportDeveloperLogs({
    includeAgentSessions: true,
    scope: "recent-3-days"
  });

  assert.deepEqual(inputs, [
    { includeAgentSessions: true, scope: "recent-3-days" }
  ]);
});

test("WorkspaceSettingsService clears workspace conversation history", async () => {
  const calls: string[] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({
        async clearWorkspaceAgentSessions(workspaceID) {
          calls.push(workspaceID);
          return { removedMessages: 3, removedSessions: 2 };
        }
      })
    },
    createDesktopPreferencesService({
      state: createPreferencesState({})
    })
  );

  service.openPanel({ id: "workspace-1" });
  await service.clearConversationHistory();

  assert.deepEqual(calls, ["workspace-1"]);
  assert.equal(service.store.developerLogs.clearingConversationHistory, false);
});

test("WorkspaceSettingsService purges deleted conversations once and reports the result", async () => {
  let calls = 0;
  const notifications = createNotificationRecorder();
  notifications.service.success = (input) => {
    notifications.items.push(input.title);
  };
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({
        purgeDeletedAgentConversations: async () => {
          calls += 1;
          return {
            removedSessions: 2,
            removedMessages: 5,
            payloadBytes: 128
          };
        }
      })
    },
    createDesktopPreferencesService({ state: createPreferencesState({}) }),
    notifications.service
  );

  await service.purgeDeletedConversations();

  assert.equal(calls, 1);
  assert.equal(service.store.purgingDeletedConversations, false);
  assert.deepEqual(notifications.items, [
    "Cleaned up 2 deleted conversations."
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
    null,
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

test("WorkspaceSettingsService keeps reporter clock separate from App Center injection", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const refreshedWorkspaceIDs: string[] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({})
    },
    createDesktopPreferencesService({
      state: createPreferencesState({})
    }),
    createNotificationRecorder().service,
    createReporterService(reporterCalls),
    {
      refreshCatalog: async (workspaceID) => {
        refreshedWorkspaceIDs.push(workspaceID);
      }
    },
    () => 1749124800000
  );

  assert.doesNotThrow(() => {
    service.openPanel({ id: "workspace-1" });
  });

  assert.deepEqual(refreshedWorkspaceIDs, []);
  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "settings.opened",
        params: {}
      }
    ]
  ]);
});

test("WorkspaceSettingsService passes driver restarts through to the client", async () => {
  let restartCalls = 0;
  const restartResult = {
    result: { success: true, output: "" },
    status: {
      installed: true,
      permissions: {
        accessibility: true,
        screenRecording: true,
        screenRecordingCapturable: true,
        source: "driver-daemon" as const
      },
      authorization: "authorized" as const
    }
  };
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({
        restartComputerUseDriver: async () => {
          restartCalls += 1;
          return restartResult;
        }
      })
    },
    createDesktopPreferencesService({
      state: createPreferencesState({})
    }),
    createNotificationRecorder().service
  );

  assert.deepEqual(await service.restartComputerUseDriver(), restartResult);
  assert.equal(restartCalls, 1);
});

function createWorkspaceSettingsClient(
  overrides: Partial<DesktopWorkspaceSettingsClient>
): DesktopWorkspaceSettingsClient {
  return {
    checkComputerUseStatus: async () => ({
      installed: false,
      permissions: null,
      authorization: "unknown",
      reason: "not-installed"
    }),
    installComputerUse: async () => ({ success: false, output: "" }),
    uninstallComputerUse: async () => ({ success: false, output: "" }),
    grantComputerUsePermissions: async () => ({ success: false, output: "" }),
    startComputerUsePermissionGrant: async () => ({
      id: "computer-use-permission-grant",
      running: false,
      startedAtUnixMs: 0,
      elapsedMs: 0,
      result: { success: false, output: "" }
    }),
    getComputerUsePermissionGrantStatus: async () => null,
    logComputerUsePermissionDiagnostic: async () => {},
    openComputerUsePermissionSettings: async () => undefined,
    restartComputerUseDriver: async () => ({
      result: { success: false, output: "" },
      status: {
        installed: false,
        permissions: null,
        authorization: "unknown",
        reason: "not-installed"
      }
    }),
    listAgentTargets: async () => [],
    listWorkspaceAgents: async () => [],
    createWorkspaceAgent: async () => {
      throw new Error("not used");
    },
    updateWorkspaceAgent: async () => {
      throw new Error("not used");
    },
    deleteWorkspaceAgent: async () => {},
    listAutomationRules: async () => [],
    getAutomationTargetCatalog: async () => ({
      permissionModes: [],
      tools: []
    }),
    createAutomationRule: async () => {
      throw new Error("not used");
    },
    updateAutomationRule: async () => {
      throw new Error("not used");
    },
    deleteAutomationRule: async () => {},
    setSystemAgentTargetEnabled: async () => {
      throw new Error("not used");
    },
    clearLogs: async () => ({
      clearedFiles: 0,
      clearedPaths: [],
      clearedSizeBytes: 0
    }),
    clearWorkspaceAgentSessions: async () => ({
      removedMessages: 0,
      removedSessions: 0
    }),
    purgeDeletedAgentConversations: async () => ({
      removedSessions: 0,
      removedMessages: 0,
      payloadBytes: 0
    }),
    exportLogs: async () => ({
      canceled: true,
      fileCount: 0,
      filePath: null
    }),
    getLogsState: async () => ({
      desktopVersion: "0.0.0",
      files: [],
      logsDir: "",
      totalFiles: 0,
      totalSizeBytes: 0
    }),
    openLogDirectory: async () => {},
    openLogFile: async () => {},
    listModelPlans: async () => [],
    createModelPlan: async () => {
      throw new Error("not used");
    },
    updateModelPlan: async () => {
      throw new Error("not used");
    },
    deleteModelPlan: async () => {},
    duplicateModelPlan: async () => {
      throw new Error("not used");
    },
    setModelPlanEnabled: async () => {
      throw new Error("not used");
    },
    listModelPlanReferences: async () => [],
    detectModelPlan: async () => ({
      detection: { stages: [] },
      discoveredModels: []
    }),
    ...overrides
  };
}

function createTuttiAgentTarget(enabled: boolean): AgentTarget {
  return {
    createdAtUnixMs: 1,
    enabled,
    iconKey: "tutti-agent",
    id: "local:tutti-agent",
    launchRef: { provider: "tutti-agent", type: "builtin_local" },
    name: "Tutti Agent",
    provider: "tutti-agent",
    sortOrder: 30,
    source: "system",
    updatedAtUnixMs: 1
  };
}

async function waitForAsyncInitialization(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createDesktopPreferencesService(input: {
  onSetAgentCliUpdateCheckEnabled?: IDesktopPreferencesService["setAgentCliUpdateCheckEnabled"];
  onSetDefaultAgentProvider?: IDesktopPreferencesService["setDefaultAgentProvider"];
  onSetAgentConversationDetailMode?: IDesktopPreferencesService["setAgentConversationDetailMode"];
  onSetAppCatalogChannel?: IDesktopPreferencesService["setAppCatalogChannel"];
  onSetBrowserUseConnectionMode?: IDesktopPreferencesService["setBrowserUseConnectionMode"];
  onSetDockIconStyle?: IDesktopPreferencesService["setDockIconStyle"];
  onSetDockPlacement?: IDesktopPreferencesService["setDockPlacement"];
  onSetDeletedAgentConversationRetentionDays?: IDesktopPreferencesService["setDeletedAgentConversationRetentionDays"];
  onSetFeatureFlags?: IDesktopPreferencesService["setFeatureFlags"];
  onSetFileDefaultOpenersByExtension?: IDesktopPreferencesService["setFileDefaultOpenersByExtension"];
  onSetLocale?: IDesktopPreferencesService["setLocale"];
  onSetMinimizeAnimation?: IDesktopPreferencesService["setMinimizeAnimation"];
  onSetSleepPreventionMode?: IDesktopPreferencesService["setSleepPreventionMode"];
  onSetThemeSource?: IDesktopPreferencesService["setThemeSource"];
  onSetUpdateChannel?: IDesktopPreferencesService["setUpdateChannel"];
  onSetUpdatePolicy?: IDesktopPreferencesService["setUpdatePolicy"];
  onSetWorkbenchShortcuts?: IDesktopPreferencesService["setWorkbenchShortcuts"];
  onSetWorkbenchWindowSnapping?: IDesktopPreferencesService["setWorkbenchWindowSnapping"];
  state: DesktopPreferencesReadableStoreState;
}): IDesktopPreferencesService {
  return {
    _serviceBrand: undefined,
    store: input.state,
    setAgentCliUpdateCheckEnabled:
      input.onSetAgentCliUpdateCheckEnabled ?? (async (enabled) => enabled),
    rememberAgentComposerDefaultsForAgentTarget: async () => ({
      acknowledgedFields: [],
      supersededFields: []
    }),
    rememberAgentGuiConversationRailCollapsed: async () => {},
    setAppCatalogChannel:
      input.onSetAppCatalogChannel ?? (async (channel) => channel),
    setAgentConversationDetailMode:
      input.onSetAgentConversationDetailMode ?? (async (mode) => mode),
    setBrowserUseConnectionMode:
      input.onSetBrowserUseConnectionMode ?? (async (mode) => mode),
    setDefaultAgentProvider:
      input.onSetDefaultAgentProvider ?? (async (provider) => provider),
    setDockIconStyle: input.onSetDockIconStyle ?? (async (style) => style),
    setDockPlacement:
      input.onSetDockPlacement ?? (async (placement) => placement),
    setDeletedAgentConversationRetentionDays:
      input.onSetDeletedAgentConversationRetentionDays ??
      (async (days) => days),
    setFeatureFlags: input.onSetFeatureFlags ?? (async (flags) => flags),
    setFileDefaultOpenersByExtension:
      input.onSetFileDefaultOpenersByExtension ??
      (async (openersByExtension) => openersByExtension),
    setLocale: input.onSetLocale ?? (async (locale) => locale),
    setMinimizeAnimation:
      input.onSetMinimizeAnimation ?? (async (animation) => animation),
    setShowAppDeveloperSources: async (show) => show,
    setSleepPreventionMode:
      input.onSetSleepPreventionMode ?? (async (enabled) => enabled),
    setWorkbenchShortcuts:
      input.onSetWorkbenchShortcuts ?? (async (shortcuts) => shortcuts),
    setWorkbenchWindowSnapping:
      input.onSetWorkbenchWindowSnapping ?? (async (value) => value),
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
    agentCliUpdateCheckEnabled: true,
    agentComposerDefaultsByProvider: {},
    agentComposerDefaultsByAgentTarget: {},
    agentGuiConversationRailCollapsedByProvider: {},
    agentConversationDetailMode: "coding",
    appCatalogChannel: "production",
    browserUseConnectionMode: "isolated",
    changingAppCatalogChannel: null,
    changingAgentCliUpdateCheckEnabled: null,
    changingAgentConversationDetailMode: null,
    changingBrowserUseConnectionMode: null,
    changingDefaultAgentProvider: null,
    changingDockIconStyle: null,
    changingDockPlacement: null,
    changingDeletedAgentConversationRetentionDays: null,
    changingFeatureFlags: null,
    changingLocale: null,
    changingMinimizeAnimation: null,
    changingShowAppDeveloperSources: null,
    changingSleepPreventionMode: null,
    changingThemeSource: null,
    changingUpdateChannel: null,
    changingUpdatePolicy: null,
    changingWorkbenchWindowSnapping: null,
    defaultAgentProvider: "codex",
    dockIconStyle: "default",
    dockPlacement: "bottom",
    deletedAgentConversationRetentionDays: 30,
    featureFlags: {},
    fileDefaultOpenersByExtension: { html: "defaultBrowser" },
    locale: "en",
    minimizeAnimation: "scale",
    showAppDeveloperSources: false,
    sleepPreventionMode: "never",
    theme: createTheme("system"),
    updateChannel: "stable",
    updatePolicy: "prompt",
    workbenchShortcuts: {
      newAgentConversation: null,
      newSameTypeWindow: null
    },
    workbenchWindowSnapping: {
      enabled: false,
      shortcutPreset: "commandArrows"
    },
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

test("WorkspaceSettingsService selects the agent sub-tab without side effects", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });
  service.openPanel({ id: "workspace-1" });
  assert.equal(service.store.agentTab, "general");
  service.selectAgentTab("agents");
  assert.equal(service.store.agentTab, "agents");
  // Idempotent: selecting the same tab is a no-op.
  service.selectAgentTab("agents");
  assert.equal(service.store.agentTab, "agents");
});

test("WorkspaceSettingsService deep-links openPanel to the Agents tab and focuses a provider", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });
  const before = service.store.agentFocusRequestID;
  service.openPanel(
    { id: "workspace-1" },
    { pane: "agents", provider: "hermes" }
  );
  assert.equal(service.store.activeSection, "agent");
  assert.equal(service.store.agentTab, "agents");
  assert.equal(service.store.agentFocusProvider, "hermes");
  assert.equal(service.store.agentFocusRequestID, before + 1);
});

test("WorkspaceSettingsService Agents deep-link works without a provider (blank focus)", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });
  service.openPanel({ id: "workspace-1" }, { pane: "agents" });
  assert.equal(service.store.activeSection, "agent");
  assert.equal(service.store.agentTab, "agents");
  assert.equal(service.store.agentFocusProvider, null);
});

test("WorkspaceSettingsService deep-links to Custom Agents and Automation", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.openPanel({ id: "workspace-1" }, { pane: "custom-agents" });
  assert.equal(service.store.activeSection, "agent");
  assert.equal(service.store.agentTab, "customAgents");

  service.openPanel({ id: "workspace-1" }, { pane: "automation-rules" });
  assert.equal(service.store.activeSection, "agent");
  assert.equal(service.store.agentTab, "automation");
});

test("WorkspaceSettingsService loads Plans and Runtime targets only on the Model surface", async () => {
  let listPlansCalls = 0;
  let listWorkspaceAgentsCalls = 0;
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listModelPlans: async () => {
        listPlansCalls += 1;
        return [];
      },
      listWorkspaceAgents: async () => {
        listWorkspaceAgentsCalls += 1;
        return [];
      }
    })
  });

  service.openPanel({ id: "workspace-1" });
  assert.equal(listPlansCalls, 0);
  assert.equal(listWorkspaceAgentsCalls, 0);

  service.selectSection("model");
  await waitFor(() => listPlansCalls > 0 && listWorkspaceAgentsCalls > 0);
});

test("WorkspaceSettingsService refreshes Custom Agents and Automation by tab", async () => {
  let listWorkspaceAgentsCalls = 0;
  let listAutomationRulesCalls = 0;
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listAutomationRules: async () => {
        listAutomationRulesCalls += 1;
        return [];
      },
      listWorkspaceAgents: async () => {
        listWorkspaceAgentsCalls += 1;
        return [];
      }
    })
  });

  service.openPanel({ id: "workspace-1" });
  service.selectSection("agent");
  assert.equal(listWorkspaceAgentsCalls, 0);
  assert.equal(listAutomationRulesCalls, 0);

  service.selectAgentTab("customAgents");
  await waitFor(() => listWorkspaceAgentsCalls > 0);
  assert.equal(listAutomationRulesCalls, 0);

  service.selectAgentTab("automation");
  await waitFor(() => listAutomationRulesCalls > 0);
});
