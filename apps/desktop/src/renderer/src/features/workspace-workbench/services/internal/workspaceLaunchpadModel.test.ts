import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import { createWorkspaceLaunchpadDockEntry } from "./workspaceLaunchpadDockEntry.ts";
import {
  buildWorkspaceLaunchpadItems,
  filterWorkspaceLaunchpadItems,
  paginateWorkspaceLaunchpadItems,
  resolveWorkspaceLaunchpadGrid,
  resolveWorkspaceLaunchpadPreviewIconUrls
} from "./workspaceLaunchpadModel.ts";

test("launchpad model includes installed apps, system nodes, and all agent providers", () => {
  const items = buildWorkspaceLaunchpadItems({
    agentDescriptors: [
      {
        iconUrl: "codex.png",
        label: "Codex",
        provider: "codex"
      },
      {
        iconUrl: "gemini.png",
        label: "Gemini CLI",
        provider: "gemini"
      }
    ],
    agentStatuses: [
      createAgentStatus({ availability: "ready", provider: "codex" }),
      createAgentStatus({ availability: "not_installed", provider: "gemini" })
    ],
    apps: [
      createApp({
        appId: "notes",
        installed: true,
        name: "Notes",
        runtimeStatus: "running",
        launchUrl: "https://notes.local"
      }),
      createApp({
        appId: "draft",
        installed: false,
        name: "Draft",
        runtimeStatus: "idle",
        launchUrl: null
      })
    ],
    copy: {
      agentComingSoon: "coming soon",
      agentUnavailable: "agent unavailable",
      appUnavailable: "app unavailable"
    },
    nodeDescriptors: [
      {
        dockEntryId: "app-center",
        iconUrl: "app-center.png",
        id: "app-center",
        label: "Applications",
        typeId: "app-center"
      },
      {
        dockEntryId: "task-center",
        iconUrl: "task-center.png",
        id: "task-center",
        label: "Issues",
        typeId: "task-center"
      },
      {
        dockEntryId: "files",
        iconUrl: "files.png",
        id: "files",
        label: "Files",
        typeId: "files"
      }
    ]
  });

  assert.deepEqual(
    items.map((item) => ({
      disabledReason: item.disabledReason,
      id: item.id,
      launchEnabled: item.launchEnabled
    })),
    [
      {
        disabledReason: undefined,
        id: "node:app-center",
        launchEnabled: true
      },
      {
        disabledReason: undefined,
        id: "node:task-center",
        launchEnabled: true
      },
      { disabledReason: undefined, id: "app:notes", launchEnabled: true },
      {
        disabledReason: undefined,
        id: "node:files",
        launchEnabled: true
      },
      { disabledReason: undefined, id: "agent:codex", launchEnabled: true },
      {
        disabledReason: "agent unavailable",
        id: "agent:gemini",
        launchEnabled: false
      }
    ]
  );
});

test("launchpad model keeps coming soon agents disabled", () => {
  const items = buildWorkspaceLaunchpadItems({
    agentDescriptors: [
      {
        comingSoon: true,
        iconUrl: "nexight.png",
        label: "Nexight",
        provider: "nexight"
      }
    ],
    agentStatuses: [
      createAgentStatus({ availability: "ready", provider: "nexight" })
    ],
    apps: [],
    copy: {
      agentComingSoon: "coming soon",
      agentUnavailable: "agent unavailable",
      appUnavailable: "app unavailable"
    }
  });

  assert.deepEqual(items, [
    {
      comingSoon: true,
      disabledReason: "coming soon",
      iconUrl: "nexight.png",
      id: "agent:nexight",
      kind: "agent",
      label: "Nexight",
      launchEnabled: false,
      provider: "nexight",
      status: createAgentStatus({ availability: "ready", provider: "nexight" })
    }
  ]);
});

test("launchpad model treats unsupported status as coming soon", () => {
  const unsupportedStatus = createAgentStatus({
    availability: "unsupported",
    provider: "openclaw"
  });
  const items = buildWorkspaceLaunchpadItems({
    agentDescriptors: [
      {
        iconUrl: "openclaw.png",
        label: "OpenClaw",
        provider: "openclaw"
      }
    ],
    agentStatuses: [unsupportedStatus],
    apps: [],
    copy: {
      agentComingSoon: "coming soon",
      agentUnavailable: "agent unavailable",
      appUnavailable: "app unavailable"
    }
  });

  assert.deepEqual(items, [
    {
      comingSoon: true,
      disabledReason: "coming soon",
      iconUrl: "openclaw.png",
      id: "agent:openclaw",
      kind: "agent",
      label: "OpenClaw",
      launchEnabled: false,
      provider: "openclaw",
      status: unsupportedStatus
    }
  ]);
});

test("launchpad search filters by label", () => {
  const items = [
    { label: "Notes" },
    { label: "Gemini CLI" },
    { label: "Codex" }
  ];

  assert.deepEqual(
    filterWorkspaceLaunchpadItems(items, "cli").map((item) => item.label),
    ["Gemini CLI"]
  );
  assert.deepEqual(
    filterWorkspaceLaunchpadItems(items, "  ").map((item) => item.label),
    ["Notes", "Gemini CLI", "Codex"]
  );
});

test("launchpad pagination clamps page and uses page size", () => {
  const page = paginateWorkspaceLaunchpadItems([1, 2, 3, 4, 5], {
    page: 4,
    pageSize: 2
  });

  assert.deepEqual(page, {
    currentPage: 2,
    pageCount: 3,
    pageItems: [5]
  });
});

test("launchpad grid resolves page size from available dimensions", () => {
  assert.deepEqual(resolveWorkspaceLaunchpadGrid({ width: 900, height: 420 }), {
    columns: 6,
    pageSize: 18,
    rows: 3
  });
  assert.deepEqual(resolveWorkspaceLaunchpadGrid({ width: 120, height: 20 }), {
    columns: 2,
    pageSize: 2,
    rows: 1
  });
});

test("launchpad dock preview prioritizes not-ready agent icons and deduplicates", () => {
  const icons = resolveWorkspaceLaunchpadPreviewIconUrls({
    agentDescriptors: [
      { iconUrl: "agent-one.png", label: "Agent one", provider: "codex" },
      {
        iconUrl: "claude.png",
        label: "Claude Code",
        provider: "claude-code"
      },
      { iconUrl: "nexight.png", label: "Nexight", provider: "nexight" },
      { iconUrl: "duplicate.png", label: "Agent two", provider: "gemini" },
      { iconUrl: "agent-three.png", label: "Agent three", provider: "openclaw" }
    ],
    agentStatuses: [
      createAgentStatus({ availability: "ready", provider: "codex" }),
      createAgentStatus({
        availability: "not_installed",
        provider: "claude-code"
      }),
      createAgentStatus({ availability: "auth_required", provider: "nexight" }),
      createAgentStatus({ availability: "not_installed", provider: "gemini" }),
      createAgentStatus({ availability: "auth_required", provider: "openclaw" })
    ],
    apps: [
      {
        iconUrl: "duplicate.png",
        installed: true,
        runtimeStatus: "running",
        launchUrl: "https://ready.local"
      },
      {
        iconUrl: "one.png",
        installed: false,
        runtimeStatus: "idle",
        launchUrl: null
      },
      {
        iconUrl: null,
        installed: false,
        runtimeStatus: "idle",
        launchUrl: null
      },
      {
        iconUrl: "three.png",
        installed: true,
        runtimeStatus: "starting",
        launchUrl: null
      },
      {
        iconUrl: "four.png",
        installed: true,
        runtimeStatus: "running",
        launchUrl: null
      },
      {
        iconUrl: "five.png",
        installed: false,
        runtimeStatus: "idle",
        launchUrl: null
      }
    ],
    excludedAgentProviders: ["claude-code", "nexight"],
    fallbackIconUrl: "fallback.png"
  });

  assert.deepEqual(icons, [
    "duplicate.png",
    "agent-three.png",
    "three.png",
    "four.png"
  ]);
});

test("launchpad dock entry uses its own trailing dock section", () => {
  const entry = createWorkspaceLaunchpadDockEntry({
    agentStatuses: [],
    apps: [],
    fallbackIconUrl: "fallback.png",
    label: "Launchpad"
  });

  assert.equal(entry.order, 0);
  assert.equal(entry.sectionId, "launchpad");
});

test("launchpad dock entry uses fixed agent icon preview", () => {
  const entry = createWorkspaceLaunchpadDockEntry({
    agentStatuses: [
      createAgentStatus({ availability: "ready", provider: "codex" }),
      createAgentStatus({ availability: "not_installed", provider: "gemini" })
    ],
    apps: [
      createApp({
        appId: "notes",
        iconUrl: "notes.png",
        installed: true,
        name: "Notes",
        runtimeStatus: "running",
        launchUrl: "https://notes.local"
      })
    ],
    fallbackIconUrl: "fallback.png",
    label: "Launchpad"
  });

  const srcs = readLaunchpadDockIconSrcs(entry);

  assert.equal(srcs.length, 4);
  assert.ok(srcs[0]?.includes("tutti.png"));
  assert.ok(srcs[1]?.includes("hermes.png"));
  assert.ok(srcs[2]?.includes("openclaw.png"));
  assert.ok(srcs[3]?.includes("gemini.png"));
});

function createApp(
  input: Partial<WorkspaceAppCenterApp> & {
    appId: string;
    name: string;
  }
): WorkspaceAppCenterApp {
  return {
    appId: input.appId,
    createdAtUnixMs: input.createdAtUnixMs ?? 1,
    enabled: input.enabled ?? false,
    exportable: input.exportable ?? false,
    iconUrl: input.iconUrl,
    installed: input.installed ?? false,
    minimizeBehavior: input.minimizeBehavior ?? "keep-mounted",
    name: input.name,
    references: input.references ?? { listSupported: false },
    runtimeStatus: input.runtimeStatus ?? "idle",
    source: input.source ?? "builtin",
    stateRevision: input.stateRevision ?? 1,
    launchUrl: input.launchUrl
  };
}

function createAgentStatus(input: {
  availability: AgentProviderStatus["availability"]["status"];
  provider: WorkspaceAgentProvider;
}): AgentProviderStatus {
  return {
    actions: [],
    adapter: {
      command: [],
      installed:
        input.availability !== "not_installed" &&
        input.availability !== "unsupported"
    },
    auth: {
      status: input.availability === "auth_required" ? "required" : "unknown"
    },
    availability: {
      status: input.availability
    },
    cli: {
      installed:
        input.availability !== "not_installed" &&
        input.availability !== "unsupported"
    },
    provider: input.provider
  };
}

function readLaunchpadDockIconSrcs(
  entry: ReturnType<typeof createWorkspaceLaunchpadDockEntry>
): string[] {
  const icon = entry.icon as ReactElement<{ children?: unknown }>;
  const children = icon.props.children;
  const tiles = Array.isArray(children) ? children : [children];

  return tiles.map((tile) => {
    const tileElement = tile as ReactElement<{ children?: unknown }>;
    const imageElement = tileElement.props.children as ReactElement<{
      src?: unknown;
    }>;
    const src = imageElement.props.src;
    if (typeof src !== "string") {
      throw new TypeError("Launchpad dock preview image src must be a string.");
    }
    return src;
  });
}
