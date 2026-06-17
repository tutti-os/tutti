import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { DesktopRichTextAtService } from "./desktopRichTextAtService.ts";

test("desktop rich text @ service assembles workspace file providers by capability", async () => {
  const searchCalls: Array<{
    workspaceId: string;
    limit?: number;
    query: string;
    signal?: AbortSignal;
  }> = [];
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async searchWorkspaceFiles(
        workspaceId: string,
        input: { limit?: number; query: string },
        requestOptions?: { signal?: AbortSignal }
      ) {
        searchCalls.push({
          workspaceId,
          limit: input.limit,
          query: input.query,
          signal: requestOptions?.signal
        });
        return {
          entries: [
            {
              kind: "directory",
              name: "issues",
              path: "/Users/test/project/tutti/issues",
              score: 100
            },
            {
              kind: "file",
              name: "summary.md",
              path: "/Users/test/project/tutti/issues/issue-1/tasks/task-1/runs/run-1/summary.md",
              score: 80
            },
            {
              kind: "file",
              name: "README.md",
              path: "/Users/test/project/tutti/README.md",
              score: 1
            }
          ],
          root: "/Users/test/project/tutti",
          workspaceID: workspaceId
        };
      }
    } as unknown as TuttidClient
  });

  const providers = service.getProviders({
    capabilities: ["workspace-file"],
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });

  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.ok(provider);
  const items = await provider.query({
    context: {},
    keyword: "readme",
    maxResults: 3
  });

  assert.equal(searchCalls.length, 1);
  assert.deepEqual(searchCalls[0], {
    workspaceId: "workspace-1",
    limit: 3,
    query: "readme",
    signal: undefined
  });
  assert.deepEqual(items, [
    {
      displayName: "README.md",
      kind: "file",
      path: "/Users/test/project/tutti/README.md"
    }
  ]);
  assert.deepEqual(provider.toInsertResult(items[0]), {
    href: "/Users/test/project/tutti/README.md",
    kind: "markdown-link",
    label: "README.md"
  });
});

test("desktop rich text @ service assembles workspace issue providers by capability", async () => {
  const listCalls: Array<{
    workspaceId: string;
    pageSize?: number;
    searchQuery?: string;
    topicId?: string;
  }> = [];
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async listWorkspaceIssueTopics(workspaceId: string) {
        return {
          topics: [
            {
              isDefault: true,
              summary: "",
              title: "Default",
              topicId: "topic-1",
              workspaceId
            }
          ]
        };
      },
      async listWorkspaceIssues(
        workspaceId: string,
        request?: { pageSize?: number; searchQuery?: string; topicId: string }
      ) {
        listCalls.push({
          workspaceId,
          pageSize: request?.pageSize,
          searchQuery: request?.searchQuery,
          topicId: request?.topicId
        });
        return {
          issues: [
            {
              content: "Handle flaky login captcha",
              creatorDisplayName: "Alice",
              issueId: "issue-1",
              status: "running",
              title: "Login polish",
              topicId: "topic-1",
              workspaceId
            }
          ],
          statusCounts: {},
          totalCount: 1
        };
      }
    } as unknown as TuttidClient
  });

  const providers = service.getProviders({
    capabilities: ["workspace-issue"],
    surface: "agent-composer",
    target: "agent-gui",
    workspaceId: "workspace-1"
  });

  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.ok(provider);
  const items = await provider.query({
    context: {},
    keyword: "login",
    maxResults: 5
  });

  assert.deepEqual(listCalls, [
    {
      workspaceId: "workspace-1",
      pageSize: 5,
      searchQuery: "login",
      topicId: "topic-1"
    }
  ]);
  assert.deepEqual(provider.toInsertResult(items[0]), {
    kind: "mention",
    mention: {
      entityId: "issue-1",
      href: "mention://workspace-issue?workspaceId=workspace-1&id=issue-1&topicId=topic-1",
      kind: "workspace-issue",
      label: "Login polish",
      meta: {
        contentPreview: "Handle flaky login captcha",
        creatorDisplayName: "Alice",
        status: "running",
        topicId: "topic-1",
        workspaceId: "workspace-1"
      }
    }
  });
});

test("desktop rich text @ service assembles agent session providers by capability", async () => {
  const listCalls: Array<{
    limit?: number;
    searchQuery?: string;
    visibleOnly?: boolean;
    workspaceId: string;
  }> = [];
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async listWorkspaceAgentSessions(
        workspaceId: string,
        request?: {
          limit?: number;
          searchQuery?: string;
          visibleOnly?: boolean;
        }
      ) {
        listCalls.push({
          limit: request?.limit,
          searchQuery: request?.searchQuery,
          visibleOnly: request?.visibleOnly,
          workspaceId
        });
        return {
          workspaceId,
          sessions: [
            {
              createdAt: "2026-06-01T00:00:00Z",
              cwd: null,
              id: "session-1",
              provider: "codex",
              status: "working",
              title:
                "[@wang jomes & Codex hi](mention://agent-session?workspaceId=workspace-1&id=session-2)",
              updatedAt: null
            }
          ]
        };
      }
    } as unknown as TuttidClient
  });

  const providers = service.getProviders({
    capabilities: ["agent-session"],
    surface: "agent-composer",
    target: "agent-gui",
    workspaceId: "workspace-1"
  });

  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.ok(provider);
  const items = await provider.query({
    context: {},
    keyword: "mentions",
    maxResults: 5
  });

  assert.deepEqual(listCalls, [
    {
      limit: 5,
      searchQuery: "mentions",
      visibleOnly: true,
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(items, [
    {
      agentName: "Codex",
      createdAtUnixMs: 1780272000000,
      id: "session-1",
      initiatorName: "local",
      provider: "codex",
      scope: "my_sessions",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
      status: "working",
      title:
        "[@wang jomes & Codex hi](mention://agent-session?workspaceId=workspace-1&id=session-2)",
      updatedAtUnixMs: 1780272000000,
      userId: "local",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(provider.getItemLabel(items[0]), "@wang jomes & Codex hi");
  assert.deepEqual(provider.toInsertResult(items[0]), {
    kind: "mention",
    mention: {
      entityId: "session-1",
      href: "mention://agent-session?id=session-1&provider=codex&workspaceId=workspace-1",
      kind: "agent-session",
      label: "@wang jomes & Codex hi",
      meta: {
        agentName: "Codex",
        initiatorName: "local",
        provider: "codex",
        scope: "my_sessions",
        sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
        status: "working",
        title: "@wang jomes & Codex hi",
        updatedAtUnixMs: "1780272000000",
        userId: "local",
        workspaceId: "workspace-1"
      }
    }
  });
});

test("desktop rich text @ service assembles workspace app providers by capability", async () => {
  const listCalls: string[] = [];
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async listCliCapabilities(workspaceId?: string) {
        listCalls.push(workspaceId ?? "");
        return {
          commands: [
            {
              id: "issue-manager.issue.list",
              path: ["issue", "list"],
              summary: "List issues",
              output: { defaultMode: "table", json: true, table: null },
              source: { kind: "builtin" }
            },
            {
              id: "app.app-weather.weather.forecast",
              description: "Inspect weather forecasts.",
              path: ["weather", "forecast"],
              summary: "Get a forecast",
              output: { defaultMode: "json", json: true, table: null },
              source: {
                appId: "app-weather",
                appDescription: "Weather app manifest description.",
                appName: "Weather Desk",
                cliDescription: "Plan weather-sensitive work.",
                iconUrl: "data:image/png;base64,weather",
                kind: "app"
              }
            },
            {
              id: "app.app-weather.weather.alerts",
              path: ["weather", "alerts"],
              summary: "List weather alerts",
              output: { defaultMode: "json", json: true, table: null },
              source: {
                appId: "app-weather",
                appDescription: "Weather app manifest description.",
                appName: "Weather Desk",
                cliDescription: "Plan weather-sensitive work.",
                kind: "app"
              }
            }
          ]
        };
      }
    } as unknown as TuttidClient
  });

  const providers = service.getProviders({
    capabilities: ["workspace-app"],
    surface: "agent-composer",
    target: "agent-gui",
    workspaceId: "workspace-1"
  });

  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.ok(provider);
  const items = await provider.query({
    context: {},
    keyword: "weather",
    maxResults: 5
  });

  assert.deepEqual(listCalls, ["workspace-1"]);
  assert.deepEqual(items, [
    {
      appId: "app-weather",
      commandCount: 2,
      commandDescriptions: ["Inspect weather forecasts."],
      commandPaths: ["weather forecast", "weather alerts"],
      description: "Plan weather-sensitive work.",
      commandSummaries: ["Get a forecast", "List weather alerts"],
      displayName: "Weather Desk",
      iconUrl: "data:image/png;base64,weather",
      scopes: ["weather"],
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(provider.toInsertResult(items[0]), {
    kind: "mention",
    mention: {
      entityId: "app-weather",
      href: "mention://workspace-app?appId=app-weather&workspaceId=workspace-1",
      kind: "workspace-app",
      label: "Weather Desk",
      meta: {
        appId: "app-weather",
        commandCount: "2",
        commandDescriptions: "Inspect weather forecasts.",
        commandPaths: "weather forecast\nweather alerts",
        commandSummaries: "Get a forecast\nList weather alerts",
        description: "Plan weather-sensitive work.",
        iconUrl: "data:image/png;base64,weather",
        scopes: "weather",
        workspaceId: "workspace-1"
      }
    }
  });
});

test("desktop rich text @ service assembles provider agent mention apps from capabilities", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async listCliCapabilities() {
        return {
          commands: [
            {
              id: "agent-context.codex.start",
              description:
                "Start a Codex agent session in the current workspace.",
              path: ["codex", "start"],
              summary: "Start a Codex agent session",
              output: { defaultMode: "table", json: true, table: null },
              source: {
                appId: "agent-codex",
                appName: "Codex",
                cliDescription:
                  "Start a Codex agent session in the current workspace.",
                kind: "app"
              }
            },
            {
              id: "agent-context.claude.start",
              description:
                "Start a Claude Code agent session in the current workspace.",
              path: ["claude", "start"],
              summary: "Start a Claude Code agent session",
              output: { defaultMode: "table", json: true, table: null },
              source: {
                appId: "agent-claude-code",
                appName: "Claude Code",
                cliDescription:
                  "Start a Claude Code agent session in the current workspace.",
                kind: "app"
              }
            }
          ]
        };
      }
    } as unknown as TuttidClient
  });

  const [provider] = service.getProviders({
    capabilities: ["workspace-app"],
    surface: "agent-composer",
    target: "agent-gui",
    workspaceId: "workspace-1"
  });
  assert.ok(provider);
  const items = await provider.query({
    context: {},
    keyword: "agent",
    maxResults: 5
  });

  assert.equal(items.length, 2);
  const claudeItem = items[0];
  const codexItem = items[1];
  const claudeIconUrl = iconUrlFromProviderItem(claudeItem);
  const codexIconUrl = iconUrlFromProviderItem(codexItem);
  assert.match(claudeIconUrl, /claudecode.*\.png$/u);
  assert.match(codexIconUrl, /codex.*\.png$/u);
  assert.deepEqual(items, [
    {
      appId: "agent-claude-code",
      commandCount: 1,
      commandDescriptions: [
        "Start a Claude Code agent session in the current workspace."
      ],
      commandPaths: ["claude start"],
      description:
        "Start a Claude Code agent session in the current workspace.",
      commandSummaries: ["Start a Claude Code agent session"],
      displayName: "Claude Code",
      iconUrl: claudeIconUrl,
      scopes: ["claude"],
      workspaceId: "workspace-1"
    },
    {
      appId: "agent-codex",
      commandCount: 1,
      commandDescriptions: [
        "Start a Codex agent session in the current workspace."
      ],
      commandPaths: ["codex start"],
      description: "Start a Codex agent session in the current workspace.",
      commandSummaries: ["Start a Codex agent session"],
      displayName: "Codex",
      iconUrl: codexIconUrl,
      scopes: ["codex"],
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(provider.toInsertResult(codexItem), {
    kind: "mention",
    mention: {
      entityId: "agent-codex",
      href: "mention://workspace-app?appId=agent-codex&workspaceId=workspace-1",
      kind: "workspace-app",
      label: "Codex",
      meta: {
        appId: "agent-codex",
        commandCount: "1",
        commandDescriptions:
          "Start a Codex agent session in the current workspace.",
        commandPaths: "codex start",
        commandSummaries: "Start a Codex agent session",
        description: "Start a Codex agent session in the current workspace.",
        iconUrl: codexIconUrl,
        scopes: "codex",
        workspaceId: "workspace-1"
      }
    }
  });
});

function iconUrlFromProviderItem(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }
  const iconUrl = (item as { readonly iconUrl?: unknown }).iconUrl;
  return typeof iconUrl === "string" ? iconUrl : "";
}

test("desktop rich text @ service falls back to app description for workspace app mentions", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async listCliCapabilities() {
        return {
          commands: [
            {
              id: "app.automation.automation.list",
              path: ["automation", "list"],
              summary: "List automations",
              output: { defaultMode: "table", json: true, table: null },
              source: {
                appId: "automation",
                appDescription:
                  "Schedule and review recurring automation runs.",
                appName: "Automation",
                kind: "app"
              }
            }
          ]
        };
      }
    } as unknown as TuttidClient
  });

  const [provider] = service.getProviders({
    capabilities: ["workspace-app"],
    surface: "agent-composer",
    target: "agent-gui",
    workspaceId: "workspace-1"
  });
  assert.ok(provider);
  const items = await provider.query({
    context: {},
    keyword: "recurring",
    maxResults: 5
  });

  const item = items[0] as
    | { description: string; displayName: string }
    | undefined;
  assert.ok(item);
  assert.equal(item.displayName, "Automation");
  assert.equal(
    item.description,
    "Schedule and review recurring automation runs."
  );
  assert.equal(
    provider.getItemSubtitle?.(item),
    "Schedule and review recurring automation runs."
  );
});

test("desktop rich text @ service prefers cli scope description for workspace app mentions", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async listCliCapabilities() {
        return {
          commands: [
            {
              id: "app.automation.automation.list",
              description: "List automation definitions.",
              path: ["automation", "list"],
              summary: "List automations",
              output: { defaultMode: "table", json: true, table: null },
              source: {
                appId: "automation",
                appDescription:
                  "Schedule and review recurring automation runs.",
                appName: "Automation",
                cliDescription: "Manage automations.",
                kind: "app"
              }
            }
          ]
        };
      }
    } as unknown as TuttidClient
  });

  const [provider] = service.getProviders({
    capabilities: ["workspace-app"],
    surface: "agent-composer",
    target: "agent-gui",
    workspaceId: "workspace-1"
  });
  assert.ok(provider);
  const items = await provider.query({
    context: {},
    keyword: "automations",
    maxResults: 5
  });

  const item = items[0] as
    | { description: string; displayName: string }
    | undefined;
  assert.ok(item);
  assert.equal(item.displayName, "Automation");
  assert.equal(item.description, "Manage automations.");
  assert.equal(provider.getItemSubtitle?.(item), "Manage automations.");
});

test("desktop rich text @ service emits enriched app + session meta when enrichment deps supplied", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async listCliCapabilities() {
        return {
          commands: [
            {
              id: "app.app-weather.weather.forecast",
              description: "Inspect weather forecasts.",
              path: ["weather", "forecast"],
              summary: "Get a forecast",
              output: { defaultMode: "json", json: true, table: null },
              source: {
                appId: "app-weather",
                appDescription: "Weather app manifest description.",
                appName: "Weather Desk",
                cliDescription: "Plan weather-sensitive work.",
                kind: "app"
              }
            }
          ]
        };
      },
      async listWorkspaceAgentSessions(workspaceId: string) {
        return {
          workspaceId,
          sessions: [
            {
              createdAt: "2026-06-01T00:00:00Z",
              cwd: null,
              id: "session-1",
              provider: "codex",
              status: "working",
              title: "Codex run",
              updatedAt: null
            }
          ]
        };
      }
    } as unknown as TuttidClient,
    appCenterApps: () => [
      {
        appId: "app-weather",
        name: "Weather Desk",
        description: "Plan weather-sensitive work.",
        localizations: [
          {
            locale: "fr-FR",
            name: "Bureau Météo",
            description: "Planifiez selon la météo."
          }
        ]
      } as never
    ],
    resolveAppIconUrl: (appId) =>
      appId === "app-weather" ? "https://icons/weather.png" : null,
    getLocale: () => "fr-FR",
    resolveAgentIconUrl: (provider) => `https://agents/${provider}.png`,
    userAvatarPlaceholderUrl: "https://avatars/placeholder.png",
    resolveSessionStatusView: (status) => ({
      dataStatus: status,
      label: status === "working" ? "Working" : status,
      pulse: status === "working"
    })
  });

  const [appProvider] = service.getProviders({
    capabilities: ["workspace-app"],
    surface: "agent-composer",
    target: "agent-gui",
    workspaceId: "workspace-1"
  });
  assert.ok(appProvider);
  const appItems = await appProvider.query({
    context: {},
    keyword: "",
    maxResults: 5
  });
  const appInsert = appProvider.toInsertResult(appItems[0]);
  assert.equal(appInsert.kind, "mention");
  assert.equal(appInsert.mention.label, "Bureau Météo");
  assert.equal(
    appInsert.mention.meta?.description,
    "Planifiez selon la météo."
  );
  assert.equal(appInsert.mention.meta?.iconUrl, "https://icons/weather.png");

  const [sessionProvider] = service.getProviders({
    capabilities: ["agent-session"],
    surface: "agent-composer",
    target: "agent-gui",
    workspaceId: "workspace-1"
  });
  assert.ok(sessionProvider);
  const sessionItems = await sessionProvider.query({
    context: {},
    keyword: "",
    maxResults: 5
  });
  const sessionInsert = sessionProvider.toInsertResult(sessionItems[0]);
  assert.equal(sessionInsert.kind, "mention");
  assert.equal(
    sessionInsert.mention.meta?.agentIconUrl,
    "https://agents/codex.png"
  );
  assert.equal(
    sessionInsert.mention.meta?.userAvatarPlaceholderUrl,
    "https://avatars/placeholder.png"
  );
  assert.equal(sessionInsert.mention.meta?.statusLabel, "Working");
  assert.equal(sessionInsert.mention.meta?.statusDataStatus, "working");
  assert.equal(sessionInsert.mention.meta?.statusPulse, "true");
});

test("desktop rich text @ service returns no providers without requested capabilities", () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: {} as TuttidClient
  });

  const providers = service.getProviders({
    capabilities: [],
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(providers, []);
});

test("desktop rich text @ service reuses provider instances for the same request", () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: {} as TuttidClient
  });

  const firstProviders = service.getProviders({
    capabilities: ["workspace-file"],
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });
  const secondProviders = service.getProviders({
    capabilities: ["workspace-file"],
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });

  assert.equal(secondProviders, firstProviders);
  assert.equal(secondProviders[0], firstProviders[0]);
});

test("desktop rich text @ service honors abort before provider search starts", async () => {
  let searchCallCount = 0;
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async searchWorkspaceFiles() {
        searchCallCount += 1;
        return {
          entries: [],
          root: "/Users/test/project/tutti",
          workspaceID: "workspace-1"
        };
      }
    } as unknown as TuttidClient
  });

  const [provider] = service.getProviders({
    capabilities: ["workspace-file"],
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });
  assert.ok(provider);
  const abortController = new AbortController();
  abortController.abort();

  const items = await provider.query({
    abortSignal: abortController.signal,
    context: {},
    keyword: "readme",
    maxResults: 3
  });

  assert.deepEqual(items, []);
  assert.equal(searchCallCount, 0);
});

test("desktop rich text @ service passes abort signals through to tuttid search", async () => {
  let receivedSignal: AbortSignal | undefined;
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async searchWorkspaceFiles(
        _workspaceId: string,
        _input: { limit?: number; query: string },
        requestOptions?: { signal?: AbortSignal }
      ) {
        receivedSignal = requestOptions?.signal;
        return {
          entries: [],
          root: "/Users/test/project/tutti",
          workspaceID: "workspace-1"
        };
      }
    } as unknown as TuttidClient
  });

  const [provider] = service.getProviders({
    capabilities: ["workspace-file"],
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });
  assert.ok(provider);
  const abortController = new AbortController();

  await provider.query({
    abortSignal: abortController.signal,
    context: {},
    keyword: "readme",
    maxResults: 3
  });

  assert.equal(receivedSignal, abortController.signal);
});

test("desktop rich text @ service skips provider caching when metadata is present", () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: {} as TuttidClient
  });

  const firstProviders = service.getProviders({
    capabilities: ["workspace-file"],
    metadata: { session: "a" },
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });
  const secondProviders = service.getProviders({
    capabilities: ["workspace-file"],
    metadata: { session: "b" },
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });

  assert.notEqual(secondProviders, firstProviders);
  assert.notEqual(secondProviders[0], firstProviders[0]);
});
