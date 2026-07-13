import assert from "node:assert/strict";
import test from "node:test";
import type { WorkbenchHostDockEntry } from "@tutti-os/workbench-surface";
import type { DesktopFusionWindowDescriptor } from "@shared/contracts/fusion.ts";
import type { FusionBackgroundResource } from "./fusionDockResourceModel.ts";
import {
  countFusionDockLauncherInstances,
  isFusionDockLauncherBlocked,
  projectFusionDockLauncherInstanceCounts,
  resolveFusionDockLauncherActivationTarget,
  resolveFusionDockLaunchers
} from "./fusionDockLauncherModel.ts";

test("Fusion launchers preserve canonical order and installed Workspace App identity", () => {
  const launchers = resolveFusionDockLaunchers({
    dockEntries: [
      createEntry("browser", "browser"),
      createEntry("workspace-app:notes", "workspace-app-webview", {
        appId: "payload-must-not-override-entry-id"
      }),
      createEntry("workspace-launchpad", "workspace-launchpad")
    ],
    resources: [],
    windows: [],
    workspaceId: "workspace-1"
  });

  assert.deepEqual(
    launchers.map((launcher) => [
      launcher.entry.id,
      launcher.kind,
      launcher.resourceId
    ]),
    [
      ["browser", "browser", null],
      ["workspace-app:notes", "workspace-app", "notes"]
    ]
  );
});

test("normal launcher activation prefers an exact MRU native window over background work", () => {
  const target = resolveFusionDockLauncherActivationTarget({
    launcher: { kind: "terminal", workspaceId: "workspace-1" },
    resources: [
      {
        ...createTerminalResource("terminal-new", 30),
        attachedWindowCount: 0
      }
    ],
    windows: [
      createWindowAt("terminal", "terminal-old", 10),
      createWindowAt("terminal", "terminal-mru", 20),
      {
        ...createWindowAt("terminal", "other-workspace", 40),
        workspaceId: "workspace-2"
      }
    ]
  });

  assert.equal(target.kind, "window");
  assert.equal(
    target.kind === "window" ? target.window.windowInstanceId : null,
    "terminal:terminal-mru"
  );
});

test("normal generic launch reconnects the newest background resource while exact launch never crosses resource identity", () => {
  const resources = [
    createTerminalResource("terminal-old", 10),
    createTerminalResource("terminal-new", 20)
  ];

  const generic = resolveFusionDockLauncherActivationTarget({
    launcher: { kind: "terminal", workspaceId: "workspace-1" },
    resources,
    windows: []
  });
  assert.equal(generic.kind, "resource");
  assert.equal(
    generic.kind === "resource" ? generic.resource.id : null,
    "terminal-new"
  );

  const exact = resolveFusionDockLauncherActivationTarget({
    launcher: {
      kind: "terminal",
      resourceId: "terminal-old",
      workspaceId: "workspace-1"
    },
    resources,
    windows: []
  });
  assert.equal(exact.kind, "resource");
  assert.equal(
    exact.kind === "resource" ? exact.resource.id : null,
    "terminal-old"
  );

  assert.deepEqual(
    resolveFusionDockLauncherActivationTarget({
      launcher: {
        kind: "terminal",
        resourceId: "missing",
        workspaceId: "workspace-1"
      },
      resources,
      windows: []
    }),
    { kind: "new" }
  );
});

test("generic Agent activation and launcher counts ignore recoverable sessions", () => {
  const [agent] = resolveFusionDockLaunchers({
    dockEntries: [createEntry("agent", "agent-gui")],
    resources: [],
    windows: [],
    workspaceId: "workspace-1"
  });
  const active = {
    ...createTerminalResource("agent-active", 10),
    kind: "agent" as const,
    provider: "codex"
  };
  const recoverable = {
    ...active,
    canStop: false,
    category: "recoverable-session" as const,
    id: "agent-completed",
    status: "completed",
    updatedAtUnixMs: 100
  };

  const target = resolveFusionDockLauncherActivationTarget({
    launcher: { kind: "agent", workspaceId: "workspace-1" },
    resources: [recoverable, active],
    windows: []
  });
  assert.equal(target.kind, "resource");
  assert.equal(
    target.kind === "resource" ? target.resource.id : null,
    "agent-active"
  );
  assert.deepEqual(
    projectFusionDockLauncherInstanceCounts({
      launcher: agent!,
      resources: [recoverable],
      windows: []
    }),
    {
      backgroundOnlyCount: 0,
      backgroundStatus: null,
      totalCount: 0,
      windowCount: 0
    }
  );
});

test("Fusion launchers apply dynamic state and only reveal transient entries for exact matches", () => {
  const dockEntries = [
    {
      ...createEntry("browser", "browser"),
      visibility: "when-open" as const
    },
    {
      ...createEntry("workspace-app:notes", "workspace-app-webview", {
        appId: "notes"
      }),
      visibility: "when-open" as const
    }
  ];
  const launchers = resolveFusionDockLaunchers({
    dockEntries,
    dynamicStateByEntryId: {
      browser: { state: { kind: "loading" } }
    },
    resources: [createResource("calendar")],
    windows: [createWindow("browser", null)],
    workspaceId: "workspace-1"
  });

  assert.deepEqual(
    launchers.map((launcher) => launcher.entry.id),
    ["browser"]
  );
  assert.equal(isFusionDockLauncherBlocked(launchers[0]!), true);
});

test("Fusion launchers reapply canonical ordering after dynamic state changes", () => {
  const launchers = resolveFusionDockLaunchers({
    dockEntries: [
      { ...createEntry("browser", "browser"), order: 10 },
      { ...createEntry("terminal", "workspace-terminal"), order: 20 }
    ],
    dynamicStateByEntryId: {
      terminal: { order: 0 }
    },
    resources: [],
    windows: [],
    workspaceId: "workspace-1"
  });

  assert.deepEqual(
    launchers.map((launcher) => launcher.entry.id),
    ["terminal", "browser"]
  );
});

test("Fusion launcher counts never fold App Center or file previews into another entry", () => {
  const [appCenter, files, notes] = resolveFusionDockLaunchers({
    dockEntries: [
      createEntry("workspace-app-center", "workspace-app-center"),
      createEntry("workspace-files", "workspace-files"),
      createEntry("workspace-app:notes", "workspace-app-webview", {
        appId: "notes"
      })
    ],
    resources: [createResource("notes")],
    windows: [
      createWindow("workspace-app", "notes"),
      createWindow("file-preview", "/tmp/readme.md")
    ],
    workspaceId: "workspace-1"
  });

  assert.equal(
    countFusionDockLauncherInstances({
      launcher: appCenter!,
      resources: [createResource("notes")],
      windows: [createWindow("workspace-app", "notes")]
    }),
    0
  );
  assert.equal(
    countFusionDockLauncherInstances({
      launcher: files!,
      resources: [],
      windows: [createWindow("file-preview", "/tmp/readme.md")]
    }),
    0
  );
  assert.equal(
    countFusionDockLauncherInstances({
      launcher: notes!,
      resources: [createResource("notes")],
      windows: [createWindow("workspace-app", "notes")]
    }),
    1
  );
});

test("Fusion launcher projection keeps native windows separate from background-only tasks", () => {
  const [terminal] = resolveFusionDockLaunchers({
    dockEntries: [createEntry("terminal", "workspace-terminal")],
    resources: [],
    windows: [],
    workspaceId: "workspace-1"
  });
  const counts = projectFusionDockLauncherInstanceCounts({
    launcher: terminal!,
    resources: [
      createTerminalResource("attached", 10),
      createTerminalResource("background", 20)
    ].map((resource, index) => ({
      ...resource,
      attachedWindowCount: index === 0 ? 1 : 0
    })),
    windows: [createWindow("terminal", "attached")]
  });

  assert.deepEqual(counts, {
    backgroundOnlyCount: 1,
    backgroundStatus: "running",
    totalCount: 2,
    windowCount: 1
  });
});

test("Fusion background badge status prioritizes failures and warnings", () => {
  const [terminal] = resolveFusionDockLaunchers({
    dockEntries: [createEntry("terminal", "workspace-terminal")],
    resources: [],
    windows: [],
    workspaceId: "workspace-1"
  });
  const running = createTerminalResource("running", 1);
  const warning = {
    ...createTerminalResource("waiting", 2),
    status: "waiting"
  };
  const failed = {
    ...createTerminalResource("failed", 3),
    status: "failed"
  };

  assert.equal(
    projectFusionDockLauncherInstanceCounts({
      launcher: terminal!,
      resources: [running, warning],
      windows: []
    }).backgroundStatus,
    "warning"
  );
  assert.equal(
    projectFusionDockLauncherInstanceCounts({
      launcher: terminal!,
      resources: [running, warning, failed],
      windows: []
    }).backgroundStatus,
    "failed"
  );
});

function createEntry(
  id: string,
  typeId: string,
  launchPayload?: unknown
): WorkbenchHostDockEntry {
  return {
    icon: null,
    id,
    label: id,
    launchPayload,
    typeId,
    visibility: "always"
  };
}

function createWindow(
  kind: DesktopFusionWindowDescriptor["kind"],
  resourceId: string | null
): DesktopFusionWindowDescriptor {
  return {
    createdAtUnixMs: 1,
    focused: false,
    kind,
    lastFocusedAtUnixMs: 1,
    resourceId,
    title: null,
    visibility: "visible",
    windowInstanceId: `${kind}:${resourceId ?? "generic"}`,
    workspaceId: "workspace-1"
  };
}

function createWindowAt(
  kind: DesktopFusionWindowDescriptor["kind"],
  resourceId: string | null,
  lastFocusedAtUnixMs: number
): DesktopFusionWindowDescriptor {
  return {
    ...createWindow(kind, resourceId),
    lastFocusedAtUnixMs
  };
}

function createResource(appId: string): FusionBackgroundResource {
  return {
    attachedWindowCount: appId === "notes" ? 1 : 0,
    canStop: true,
    category: "background-task",
    id: appId,
    kind: "workspace-app",
    provider: null,
    status: "running",
    subtitle: null,
    title: appId,
    updatedAtUnixMs: 1,
    workspaceId: "workspace-1",
    workspaceName: "One"
  };
}

function createTerminalResource(
  terminalId: string,
  updatedAtUnixMs: number
): FusionBackgroundResource {
  return {
    attachedWindowCount: 0,
    canStop: true,
    category: "background-task",
    id: terminalId,
    kind: "terminal",
    provider: null,
    status: "running",
    subtitle: null,
    title: terminalId,
    updatedAtUnixMs,
    workspaceId: "workspace-1",
    workspaceName: "One"
  };
}
