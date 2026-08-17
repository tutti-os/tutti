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
  LAB_CONNECTORS_FLAG,
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

test("WorkspaceSettingsService maps the legacy Account section to Connection", () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({})
  });

  service.openPanel(
    { id: "workspace-1" },
    {
      section: "account"
    }
  );

  assert.equal(service.store.activeSection, "connection");
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

test("WorkspaceSettingsService enables Agent mode, preserves other flags, and hands off persisted analytics", async () => {
  const writes: Array<Record<string, boolean>> = [];
  const replacements: Array<{
    clientTs: number;
    mode: string;
    previousMode: string;
    workspaceId: string;
  }> = [];
  const reporterCalls: ReporterEventInput[][] = [];
  const effects: string[] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({}),
      replaceWorkspaceWindow: async (input) => {
        effects.push("replace");
        replacements.push(input);
      }
    },
    createDesktopPreferencesService({
      onSetFeatureFlags: async (flags) => {
        effects.push("save");
        writes.push(flags);
        return flags;
      },
      state: createPreferencesState({
        featureFlags: { "lab.enabled": true }
      })
    }),
    createNotificationRecorder().service,
    {
      async trackEvents(events) {
        effects.push("track");
        reporterCalls.push(events);
      }
    },
    null,
    () => 1749124800000
  );

  service.openPanel({ id: "workspace-1" });
  reporterCalls.length = 0;
  effects.length = 0;
  await service.changeWorkspaceUiMode("agent");

  assert.deepEqual(writes, [
    {
      "lab.enabled": true,
      "workspace.standaloneAgentMode": true
    }
  ]);
  assert.deepEqual(replacements, [
    {
      clientTs: 1749124800000,
      mode: "agent",
      previousMode: "os",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(reporterCalls, []);
  assert.deepEqual(effects, ["save", "replace"]);
});

test("WorkspaceSettingsService hands off the reverse Agent-to-OS transition", async () => {
  const writes: Array<Record<string, boolean>> = [];
  const replacements: Array<{
    clientTs: number;
    mode: string;
    previousMode: string;
    workspaceId: string;
  }> = [];
  const reporterCalls: ReporterEventInput[][] = [];
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
        featureFlags: { "workspace.standaloneAgentMode": true }
      })
    }),
    createNotificationRecorder().service,
    createReporterService(reporterCalls),
    null,
    () => 1749124800000
  );

  service.openPanel({ id: "workspace-1" });
  reporterCalls.length = 0;
  await service.changeWorkspaceUiMode("os");

  assert.deepEqual(writes, [{ "workspace.standaloneAgentMode": false }]);
  assert.deepEqual(replacements, [
    {
      clientTs: 1749124800000,
      mode: "os",
      previousMode: "agent",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(reporterCalls, []);
});

test("WorkspaceSettingsService does not persist, replace, or track an already selected UI mode", async () => {
  let writes = 0;
  let replacements = 0;
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({}),
      replaceWorkspaceWindow: async () => {
        replacements += 1;
      }
    },
    createDesktopPreferencesService({
      onSetFeatureFlags: async (flags) => {
        writes += 1;
        return flags;
      },
      state: createPreferencesState({ featureFlags: {} })
    }),
    createNotificationRecorder().service,
    createReporterService(reporterCalls)
  );

  service.openPanel({ id: "workspace-1" });
  reporterCalls.length = 0;
  await service.changeWorkspaceUiMode("os");

  assert.equal(writes, 0);
  assert.equal(replacements, 0);
  assert.deepEqual(reporterCalls, []);
});

test("WorkspaceSettingsService does not duplicate a UI mode change that is already pending", async () => {
  let writes = 0;
  let replacements = 0;
  const reporterCalls: ReporterEventInput[][] = [];
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({}),
      replaceWorkspaceWindow: async () => {
        replacements += 1;
      }
    },
    createDesktopPreferencesService({
      onSetFeatureFlags: async (flags) => {
        writes += 1;
        return flags;
      },
      state: createPreferencesState({
        changingFeatureFlags: { "workspace.standaloneAgentMode": true },
        featureFlags: {}
      })
    }),
    createNotificationRecorder().service,
    createReporterService(reporterCalls)
  );

  service.openPanel({ id: "workspace-1" });
  reporterCalls.length = 0;
  await service.changeWorkspaceUiMode("agent");

  assert.equal(writes, 0);
  assert.equal(replacements, 0);
  assert.deepEqual(reporterCalls, []);
});

test("WorkspaceSettingsService does not replace or track when UI mode persistence fails", async () => {
  let replacements = 0;
  const reporterCalls: ReporterEventInput[][] = [];
  const modeErrors: Array<{
    error: unknown;
    mode: string;
    previousMode: string;
    workspaceId: string | null;
  }> = [];
  const notifications = createNotificationRecorder();
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({}),
      replaceWorkspaceWindow: async () => {
        replacements += 1;
      },
      onWorkspaceUiModeChangeError: (input) => {
        modeErrors.push(input);
      }
    },
    createDesktopPreferencesService({
      onSetFeatureFlags: async () => {
        throw new Error("save failed");
      },
      state: createPreferencesState({ featureFlags: {} })
    }),
    notifications.service,
    createReporterService(reporterCalls)
  );

  service.openPanel({ id: "workspace-1" });
  reporterCalls.length = 0;
  await service.changeWorkspaceUiMode("agent");

  assert.equal(replacements, 0);
  assert.deepEqual(reporterCalls, []);
  assert.equal(modeErrors.length, 1);
  const modeError = modeErrors[0];
  assert.ok(modeError);
  assert.equal((modeError.error as Error).message, "save failed");
  assert.deepEqual(modeErrors[0], {
    error: modeError.error,
    mode: "agent",
    previousMode: "os",
    workspaceId: "workspace-1"
  });
  assert.deepEqual(notifications.items, [
    "We couldn't update the startup interface right now."
  ]);
});

test("WorkspaceSettingsService hands off a persisted UI mode change even when replacement fails", async () => {
  const replacements: unknown[] = [];
  const reporterCalls: ReporterEventInput[][] = [];
  const notifications = createNotificationRecorder();
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({}),
      replaceWorkspaceWindow: async (input) => {
        replacements.push(input);
        throw new Error("replace failed");
      }
    },
    createDesktopPreferencesService({
      state: createPreferencesState({ featureFlags: {} })
    }),
    notifications.service,
    createReporterService(reporterCalls),
    null,
    () => 1749124800000
  );

  service.openPanel({ id: "workspace-1" });
  reporterCalls.length = 0;
  await service.changeWorkspaceUiMode("agent");

  assert.deepEqual(replacements, [
    {
      clientTs: 1749124800000,
      mode: "agent",
      previousMode: "os",
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(reporterCalls, []);
  assert.deepEqual(notifications.items, [
    "We couldn't update the startup interface right now."
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
  const calls: string[] = [];
  const notifications = createNotificationRecorder();
  notifications.service.success = (input) => {
    notifications.items.push(input.title);
  };
  const service = new WorkspaceSettingsService(
    {
      client: createWorkspaceSettingsClient({
        purgeWorkspaceDeletedAgentSessions: async (workspaceID) => {
          calls.push(workspaceID);
          return { removedSessions: 2 };
        }
      })
    },
    createDesktopPreferencesService({ state: createPreferencesState({}) }),
    notifications.service
  );

  service.openPanel({ id: "workspace-1" });
  service.store.deletedConversations.workspaceTotalCount = 2;
  await service.deletedConversations.purgeAll();

  assert.deepEqual(calls, ["workspace-1"]);
  assert.equal(service.store.deletedConversations.purgingAll, false);
  assert.deepEqual(notifications.items, [
    "Permanently deleted 2 conversations."
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
    listWorkspaceDeletedAgentSessions: async () => ({
      hasMore: false,
      projectOptions: [],
      sessions: [],
      totalCount: 0,
      workspaceTotalCount: 0
    }),
    purgeWorkspaceDeletedAgentSession: async () => {},
    purgeWorkspaceDeletedAgentSessions: async () => ({ removedSessions: 0 }),
    restoreWorkspaceDeletedAgentSession: async () => {},
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
    rememberAgentSessionLaunchMode: async () => {},
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
    agentSessionLaunchModesByWorkspace: {},
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
      newSameTypeWindow: null,
      captureScreenshot: null
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

test("WorkspaceSettingsService gates the Connectors deep-link with its Lab flag", () => {
  const disabled = new WorkspaceSettingsService(
    { client: createWorkspaceSettingsClient({}) },
    createDesktopPreferencesService({
      state: createPreferencesState({ featureFlags: {} })
    })
  );
  disabled.openPanel({ id: "workspace-1" }, { pane: "connectors" });
  assert.equal(disabled.store.activeSection, "agent");
  assert.equal(disabled.store.agentTab, "general");

  const enabled = new WorkspaceSettingsService(
    { client: createWorkspaceSettingsClient({}) },
    createDesktopPreferencesService({
      state: createPreferencesState({
        featureFlags: { [LAB_CONNECTORS_FLAG]: true }
      })
    })
  );
  enabled.openPanel({ id: "workspace-1" }, { pane: "connectors" });
  assert.equal(enabled.store.open, true);
  assert.equal(enabled.store.activeSection, "agent");
  assert.equal(enabled.store.agentTab, "connectors");
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

test("WorkspaceSettingsService hands off a model plan into a prefilled agent draft", async () => {
  const service = new WorkspaceSettingsService({
    client: createWorkspaceSettingsClient({
      listAgentTargets: async () => [
        {
          createdAtUnixMs: 1,
          enabled: true,
          iconKey: null,
          id: "local:claude-code",
          launchRef: { provider: "claude-code", type: "builtin_local" },
          name: "Claude Code",
          provider: "claude-code",
          sortOrder: 1,
          source: "system",
          updatedAtUnixMs: 1
        }
      ],
      listModelPlans: async () => [
        {
          baseUrl: "https://api.anthropic.com/v1",
          createdAt: "2026-07-12T00:00:00Z",
          defaultModel: null,
          detection: { stages: [] },
          enabled: true,
          hasApiKey: true,
          id: "plan-1",
          models: [],
          name: "Anthropic plan",
          protocol: "anthropic",
          status: "undetected",
          templateKind: "custom",
          updatedAt: "2026-07-12T00:00:00Z",
          workspaceId: "workspace-1"
        }
      ]
    })
  });

  service.openPanel({ id: "workspace-1" });
  await service.modelPlans.refresh();
  service.store.modelPlans.createdPlanHandoff = {
    planID: "plan-1",
    planName: "Anthropic plan"
  };

  await service.openAgentDraftForModelPlan("plan-1");

  assert.equal(service.store.activeSection, "agent");
  assert.equal(service.store.agentTab, "customAgents");
  assert.equal(service.store.modelPlans.createdPlanHandoff, null);
  assert.equal(
    service.store.agents.draft?.harnessAgentTargetId,
    "local:claude-code"
  );
  assert.equal(service.store.agents.draft?.modelPlanId, "plan-1");
});

test("WorkspaceSettingsService loads Plans only on the Model surface", async () => {
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
  await waitFor(() => listPlansCalls > 0);
  assert.equal(listWorkspaceAgentsCalls, 0);
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
