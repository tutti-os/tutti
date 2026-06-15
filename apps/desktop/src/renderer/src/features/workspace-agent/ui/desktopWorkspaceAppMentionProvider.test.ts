import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRichTextAtProvider } from "@tutti-os/agent-gui/agent-rich-text-at-provider";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import { createDesktopWorkspaceAppMentionProvider } from "./desktopWorkspaceAppMentionProvider.ts";

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
      href: "mention://workspace-app?appId=automation&workspaceId=workspace-1",
      kind: "workspace-app",
      label: "自动化",
      meta: {
        appId: "automation",
        commandCount: "1",
        commandDescriptions: "",
        commandPaths: "automation run",
        commandSummaries: "Run automation",
        description: "管理工作区自动化任务。",
        iconUrl: "",
        scopes: "automation",
        workspaceId: "workspace-1"
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
    keyword: "",
    maxResults: 10
  });

  assert.equal(provider.getItemLabel(items[0]!), "自动化");
});

test("workspace app mention provider prefers resolved built-in app icons", async () => {
  const provider = createDesktopWorkspaceAppMentionProvider({
    apps: [
      createWorkspaceApp({
        appId: "automation",
        iconUrl: "old-app-icon.png",
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
    resolveAppIconUrl: (appId) =>
      appId === "automation" ? "resolved-automation-icon.png" : null,
    workspaceId: "workspace-1"
  });

  const items = await provider.query({
    context: {},
    keyword: "",
    maxResults: 10
  });

  const item = items[0];
  assert.equal(item?.iconUrl, "resolved-automation-icon.png");
  assert.ok(item);
  const insertResult = provider.toInsertResult(item);
  assert.equal(insertResult.kind, "mention");
  assert.equal(
    insertResult.mention.meta?.iconUrl,
    "resolved-automation-icon.png"
  );
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
): AgentRichTextAtProvider<(typeof items)[number]> {
  return {
    id: "workspace-app",
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
        href: `mention://workspace-app?appId=${item.appId}&workspaceId=workspace-1`,
        kind: "workspace-app",
        label: item.label,
        meta: {
          appId: item.appId,
          commandCount: "1",
          commandDescriptions: item.commandDescriptions ?? "",
          commandPaths: item.commandPaths ?? "automation run",
          commandSummaries: item.commandSummaries ?? "Run automation",
          description: item.description ?? "",
          iconUrl: item.iconUrl ?? "",
          scopes: item.scopes ?? "automation",
          workspaceId: "workspace-1"
        }
      }
    })
  };
}
