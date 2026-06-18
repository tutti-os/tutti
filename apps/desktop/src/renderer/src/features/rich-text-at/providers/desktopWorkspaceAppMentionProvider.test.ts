import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContextMentionProvider } from "@tutti-os/agent-gui/context-mention-provider";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import { createDesktopWorkspaceAppMentionProvider } from "./desktopWorkspaceAppMentionProvider.ts";

test("workspace app mention provider lists installed App Center apps without CLI capabilities", async () => {
  const provider = createDesktopWorkspaceAppMentionProvider({
    apps: [
      createWorkspaceApp({
        appId: "vibe-design",
        description: "Design prototypes in Tutti.",
        name: "Vibe Design"
      }),
      createWorkspaceApp({
        appId: "group-chat",
        description: "Workspace group chat.",
        enabled: false,
        name: "Group Chat"
      })
    ],
    baseProvider: createBaseWorkspaceAppProvider([]),
    locale: "en",
    workspaceId: "workspace-1"
  });

  const items = await provider.query({
    context: {},
    trigger: "@",
    keyword: "",
    maxResults: 10
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.appId, "vibe-design");
  assert.equal(provider.getItemLabel(items[0]!), "Vibe Design");
});

test("workspace app mention provider uses localized Chinese app text", async () => {
  const provider = createDesktopWorkspaceAppMentionProvider({
    apps: [
      createWorkspaceApp({
        appId: "automation",
        description: "Schedule and review recurring automation runs.",
        localizations: [
          {
            description: "管理工作区自动化任务。",
            locale: "zh-CN",
            name: "自动化",
            tags: ["自动化"]
          }
        ],
        name: "Automation"
      })
    ],
    baseProvider: createBaseWorkspaceAppProvider([
      {
        appId: "automation",
        description: "Schedule and review recurring automation runs.",
        label: "Automation"
      }
    ]),
    locale: "zh-CN",
    workspaceId: "workspace-1"
  });

  const items = await provider.query({
    context: {},
    trigger: "@",
    keyword: "自动",
    maxResults: 10
  });

  assert.equal(items.length, 1);
  assert.equal(provider.getItemLabel(items[0]!), "自动化");
  assert.equal(provider.getItemSubtitle?.(items[0]!), "管理工作区自动化任务。");

  assert.deepEqual(provider.toInsertResult(items[0]!), {
    kind: "mention",
    mention: {
      entityId: "automation",
      label: "自动化",
      scope: {
        workspaceId: "workspace-1"
      },
      presentation: {
        description: "管理工作区自动化任务。",
        subtitle: "管理工作区自动化任务。"
      }
    }
  });
});

test("workspace app mention provider falls back from regional locale to language", async () => {
  const provider = createDesktopWorkspaceAppMentionProvider({
    apps: [
      createWorkspaceApp({
        appId: "automation",
        localizations: [
          {
            description: "管理工作区自动化任务。",
            locale: "zh",
            name: "自动化",
            tags: []
          }
        ],
        name: "Automation"
      })
    ],
    baseProvider: createBaseWorkspaceAppProvider([
      {
        appId: "automation",
        label: "Automation"
      }
    ]),
    locale: "zh-CN",
    workspaceId: "workspace-1"
  });

  const items = await provider.query({
    context: {},
    trigger: "@",
    keyword: "",
    maxResults: 10
  });

  assert.equal(provider.getItemLabel(items[0]!), "自动化");
});

test("workspace app mention provider prefers App Center icons over base icons", async () => {
  const provider = createDesktopWorkspaceAppMentionProvider({
    apps: [
      createWorkspaceApp({
        appId: "automation",
        iconUrl: "app-center-icon.png",
        name: "Automation"
      })
    ],
    baseProvider: createBaseWorkspaceAppProvider([
      {
        appId: "automation",
        iconUrl: "base-icon.png",
        label: "Automation"
      }
    ]),
    locale: "en",
    workspaceId: "workspace-1"
  });

  const items = await provider.query({
    context: {},
    trigger: "@",
    keyword: "",
    maxResults: 10
  });

  const item = items[0];
  assert.equal(item?.iconUrl, "app-center-icon.png");
  assert.ok(item);
  const insertResult = provider.toInsertResult(item);
  assert.equal(insertResult.kind, "mention");
  assert.equal(
    insertResult.mention.presentation?.iconUrl,
    "app-center-icon.png"
  );
});

test("workspace app mention provider uses base icons without App Center metadata", async () => {
  const provider = createDesktopWorkspaceAppMentionProvider({
    apps: [],
    baseProvider: createBaseWorkspaceAppProvider([
      {
        appId: "agent-codex",
        iconUrl: "tutti-asset://agent/codex.png",
        label: "Codex",
        scopes: "codex"
      },
      {
        appId: "agent-claude-code",
        iconUrl: "tutti-asset://agent/claudecode.png",
        label: "Claude Code",
        scopes: "claude"
      }
    ]),
    locale: "en",
    workspaceId: "workspace-1"
  });

  const items = await provider.query({
    context: {},
    trigger: "@",
    keyword: "agent",
    maxResults: 10
  });

  const claude = items.find((item) => item.appId === "agent-claude-code");
  const codex = items.find((item) => item.appId === "agent-codex");
  assert.equal(claude?.iconUrl, "tutti-asset://agent/claudecode.png");
  assert.equal(codex?.iconUrl, "tutti-asset://agent/codex.png");
  assert.ok(codex);
  const insertResult = provider.toInsertResult(codex);
  assert.equal(insertResult.kind, "mention");
  assert.equal(insertResult.mention.presentation?.iconUrl, codex.iconUrl);
});

test("workspace app mention provider localizes built-in issue manager metadata", async () => {
  const provider = createDesktopWorkspaceAppMentionProvider({
    apps: [],
    baseProvider: createBaseWorkspaceAppProvider([
      {
        appId: "issue-manager",
        description: "Manage workspace tasks and runs.",
        iconUrl: "tutti-asset://issue/default.png",
        label: "Task Manager",
        scopes: "issue"
      }
    ]),
    locale: "zh-CN",
    workspaceId: "workspace-1"
  });

  const items = await provider.query({
    context: {},
    trigger: "@",
    keyword: "任务",
    maxResults: 10
  });

  assert.equal(items.length, 1);
  assert.equal(provider.getItemLabel(items[0]!), "任务管理");
  assert.equal(
    provider.getItemSubtitle?.(items[0]!),
    "管理工作区任务和运行记录。"
  );
  assert.equal(items[0]?.iconUrl, "tutti-asset://issue/default.png");
  assert.deepEqual(provider.toInsertResult(items[0]!), {
    kind: "mention",
    mention: {
      entityId: "issue-manager",
      label: "任务管理",
      presentation: {
        description: "管理工作区任务和运行记录。",
        iconUrl: "tutti-asset://issue/default.png",
        subtitle: "管理工作区任务和运行记录。"
      },
      scope: {
        workspaceId: "workspace-1"
      }
    }
  });
});

test("workspace app mention provider keeps English fallback when localization is missing", async () => {
  const provider = createDesktopWorkspaceAppMentionProvider({
    apps: [
      createWorkspaceApp({
        appId: "vibe-design",
        description:
          "Create and iterate on design prototypes inside a Tutti workspace.",
        name: "Vibe Design"
      })
    ],
    baseProvider: createBaseWorkspaceAppProvider([
      {
        appId: "vibe-design",
        description:
          "Create and iterate on design prototypes inside a Tutti workspace.",
        label: "Vibe Design"
      }
    ]),
    locale: "zh-CN",
    workspaceId: "workspace-1"
  });

  const items = await provider.query({
    context: {},
    trigger: "@",
    keyword: "vibe",
    maxResults: 10
  });

  assert.equal(provider.getItemLabel(items[0]!), "Vibe Design");
  assert.equal(
    provider.getItemSubtitle?.(items[0]!),
    "Create and iterate on design prototypes inside a Tutti workspace."
  );
});

test("workspace app mention provider uses CLI command fields for search", async () => {
  const provider = createDesktopWorkspaceAppMentionProvider({
    apps: [
      createWorkspaceApp({
        appId: "automation",
        name: "Automation"
      })
    ],
    baseProvider: createBaseWorkspaceAppProvider([
      {
        appId: "automation",
        commandDescriptions: "Trigger recurring workspace jobs.",
        commandPaths: "automation run",
        commandSummaries: "Run automation",
        label: "Automation"
      }
    ]),
    locale: "en-US",
    workspaceId: "workspace-1"
  });

  const items = await provider.query({
    context: {},
    trigger: "@",
    keyword: "recurring",
    maxResults: 1
  });

  assert.equal(items.length, 1);
  assert.equal(provider.getItemLabel(items[0]!), "Automation");
});

test("workspace app mention provider does not truncate CLI apps with maxResults", async () => {
  const requestedMaxResults: Array<number | undefined> = [];
  const provider = createDesktopWorkspaceAppMentionProvider({
    apps: [],
    baseProvider: createBaseWorkspaceAppProvider(
      Array.from({ length: 12 }, (_, index) => ({
        appId: `app-${index}`,
        label: `App ${index}`
      })),
      requestedMaxResults
    ),
    locale: "en-US",
    workspaceId: "workspace-1"
  });

  const items = await provider.query({
    context: {},
    trigger: "@",
    keyword: "",
    maxResults: 10
  });

  assert.equal(items.length, 12);
  assert.deepEqual(requestedMaxResults, [undefined]);
});

function createWorkspaceApp(
  overrides: Partial<WorkspaceAppCenterApp>
): WorkspaceAppCenterApp {
  return {
    appId: "app-1",
    createdAtUnixMs: 0,
    description: null,
    enabled: true,
    exportable: true,
    installed: true,
    localizations: [],
    minimizeBehavior: "keep-mounted",
    name: "App",
    runtimeStatus: "idle",
    source: "builtin",
    stateRevision: 1,
    ...overrides,
    references: overrides.references ?? { listSupported: false }
  };
}

function createBaseWorkspaceAppProvider(
  items: Array<{
    appId: string;
    commandDescriptions?: string;
    commandPaths?: string;
    commandSummaries?: string;
    description?: string;
    iconUrl?: string;
    label: string;
    scopes?: string;
  }>,
  requestedMaxResults: Array<number | undefined> = []
): AgentContextMentionProvider<(typeof items)[number]> {
  return {
    id: "workspace-app",
    trigger: "@",
    getItemKey: (item) => item.appId,
    getItemLabel: (item) => item.label,
    getItemSubtitle: (item) => item.description ?? "",
    query(input) {
      requestedMaxResults.push(input.maxResults);
      return items;
    },
    toInsertResult: (item) => ({
      kind: "mention",
      mention: {
        entityId: item.appId,
        label: item.label,
        scope: {
          workspaceId: "workspace-1"
        },
        presentation: {
          description: item.description ?? "",
          iconUrl: item.iconUrl ?? ""
        }
      }
    })
  };
}
