import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentTarget,
  AgentProviderStatus,
  TuttidClient,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";
import {
  tuttiAgentAssetUrls,
  tuttiFileAssetUrls,
  tuttiFolderAssetUrls,
  tuttiIssueAssetUrls
} from "../../../../../../shared/tuttiAssetProtocol.ts";
import { DesktopRichTextAtService } from "./desktopRichTextAtService.ts";
import {
  mapAgentTargetsToPresentations,
  mapAgentTargetPresentationsToAgents
} from "../../../workspace-agent/services/internal/desktopAgentsService.ts";
import type {
  DesktopRichTextAtCapability,
  DesktopRichTextTriggerProviderRequest
} from "../richTextAtService.interface.ts";
import type {
  AgentsSnapshot,
  IAgentsService
} from "../../../workspace-agent/services/agentsService.interface.ts";

function createTuttidClient(methods: object = {}): TuttidClient {
  return methods as unknown as TuttidClient;
}

function getProvider(
  service: DesktopRichTextAtService,
  capability: DesktopRichTextAtCapability,
  overrides: Partial<DesktopRichTextTriggerProviderRequest> = {}
): RichTextTriggerProvider {
  const providers = service.getProviders({
    capabilities: [capability],
    surface: "agent-composer",
    target: "agent-gui",
    workspaceId: "workspace-1",
    ...overrides
  });
  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.ok(provider);
  return provider;
}

function queryProvider(
  provider: RichTextTriggerProvider,
  keyword = "",
  overrides: Partial<Parameters<RichTextTriggerProvider["query"]>[0]> = {}
) {
  return provider.query({
    context: {},
    keyword,
    maxResults: 5,
    trigger: "@",
    ...overrides
  });
}

test("desktop rich text @ service assembles workspace file providers by capability", async () => {
  const searchCalls: Array<{
    workspaceId: string;
    limit?: number;
    query: string;
    signal?: AbortSignal;
  }> = [];
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
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
        const entries = [
          {
            kind: "directory",
            name: "issues",
            path: "/Users/test/project/tutti/issues",
            score: 100
          },
          {
            kind: "directory",
            name: "docs",
            path: "/Users/test/project/tutti/docs",
            score: 90
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
          },
          {
            kind: "file",
            name: "README.md",
            path: "/Users/test/project/tutti/docs/README.md",
            score: 1
          }
        ].filter((entry) => {
          const query = input.query.toLowerCase();
          return (
            entry.name.toLowerCase().includes(query) ||
            entry.path.toLowerCase().includes(query)
          );
        });
        return {
          entries,
          root: "/Users/test/project/tutti",
          workspaceID: workspaceId
        };
      }
    })
  });

  const provider = getProvider(service, "file", {
    surface: "issue",
    target: "issue-manager"
  });
  const items = await queryProvider(provider, "readme", { maxResults: 3 });

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
      displayPath: "README.md",
      kind: "file",
      path: "/Users/test/project/tutti/README.md"
    },
    {
      displayName: "README.md",
      displayPath: "docs/README.md",
      kind: "file",
      path: "/Users/test/project/tutti/docs/README.md"
    }
  ]);
  assert.equal(provider.getItemSubtitle?.(items[0]), "README.md");
  assert.equal(provider.getItemSubtitle?.(items[1]), "docs/README.md");
  assert.equal(provider.getItemIconUrl?.(items[0]), tuttiFileAssetUrls.default);
  assert.deepEqual(provider.toInsertResult(items[0]), {
    href: "/Users/test/project/tutti/README.md",
    kind: "markdown-link",
    label: "README.md"
  });

  const folderItems = await queryProvider(provider, "docs", { maxResults: 3 });
  assert.deepEqual(folderItems, [
    {
      displayName: "docs",
      displayPath: "docs",
      kind: "directory",
      path: "/Users/test/project/tutti/docs"
    },
    {
      displayName: "README.md",
      displayPath: "docs/README.md",
      kind: "file",
      path: "/Users/test/project/tutti/docs/README.md"
    }
  ]);
  assert.equal(provider.getItemSubtitle?.(folderItems[0]), "docs");
  assert.equal(
    provider.getItemIconUrl?.(folderItems[0]),
    tuttiFolderAssetUrls.default
  );
  assert.deepEqual(provider.toInsertResult(folderItems[0]), {
    href: "/Users/test/project/tutti/docs/",
    kind: "markdown-link",
    label: "docs"
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
    tuttidClient: createTuttidClient({
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
      },
      async getWorkspaceIssueDetail(workspaceId: string, issueId: string) {
        return {
          issue: {
            content: "Handle flaky login captcha",
            creatorDisplayName: "Alice",
            issueId,
            status: "running",
            title: "Login polish",
            topicId: "topic-1",
            workspaceId
          },
          tasks: []
        };
      }
    })
  });

  const provider = getProvider(service, "workspace-issue");
  const items = await queryProvider(provider, "login");

  assert.deepEqual(listCalls, [
    {
      workspaceId: "workspace-1",
      pageSize: 10,
      searchQuery: "login",
      topicId: "topic-1"
    }
  ]);
  assert.equal(
    provider.getItemIconUrl?.(items[0]),
    "tutti-asset://issue/default.png"
  );
  assert.deepEqual(provider.toInsertResult(items[0]), {
    kind: "mention",
    mention: {
      entityId: "issue-1",
      label: "Login polish",
      presentation: {
        description: "Handle flaky login captcha",
        iconUrl: "tutti-asset://issue/default.png",
        status: "running"
      },
      scope: {
        topicId: "topic-1",
        workspaceId: "workspace-1"
      }
    }
  });
  assert.deepEqual(
    await provider.resolveMention?.({
      entityId: "issue-1",
      label: "Login polish",
      providerId: "workspace-issue",
      scope: {
        topicId: "topic-1",
        workspaceId: "workspace-1"
      }
    }),
    {
      label: "Login polish",
      presentation: {
        description: "Handle flaky login captcha",
        iconUrl: "tutti-asset://issue/default.png",
        status: "running"
      }
    }
  );
});

test("workspace issue provider queries every topic in order and pages one group", async () => {
  const calls: Array<{
    topicId: string;
    pageToken?: string;
    signal?: AbortSignal;
  }> = [];
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceIssueTopics(
        workspaceId: string,
        options?: { signal?: AbortSignal }
      ) {
        assert.equal(workspaceId, "workspace-1");
        assert.ok(options?.signal);
        return {
          topics: ["pinned/topic", "recent:topic", "empty-topic"].map(
            (topicId, index) => ({
              isDefault: index === 0,
              summary: "",
              title: index === 0 ? "Pinned" : index === 1 ? "Recent" : "Empty",
              topicId,
              workspaceId
            })
          )
        };
      },
      async listWorkspaceIssues(
        workspaceId: string,
        request: {
          pageSize?: number;
          pageToken?: string;
          searchQuery?: string;
          topicId: string;
        },
        options?: { signal?: AbortSignal }
      ) {
        calls.push({
          topicId: request.topicId,
          pageToken: request.pageToken,
          signal: options?.signal
        });
        if (request.topicId === "empty-topic") {
          return {
            issues: [],
            statusCounts: {},
            totalCount: 0
          };
        }
        const suffix = request.pageToken ? "next" : "first";
        return {
          issues: [
            {
              content: request.searchQuery,
              issueId: `issue-${request.topicId}-${suffix}`,
              status: "open",
              title: `${request.topicId} ${suffix}`,
              topicId: request.topicId,
              workspaceId
            }
          ],
          nextPageToken: request.pageToken
            ? undefined
            : `cursor-${request.topicId}`,
          statusCounts: {},
          totalCount: 11
        };
      }
    })
  });
  const provider = getProvider(service, "workspace-issue");
  assert.ok(provider.queryGroups);
  assert.ok(provider.queryGroupPage);
  const abortController = new AbortController();
  const result = await provider.queryGroups({
    context: {},
    keyword: "  login   bug ",
    abortSignal: abortController.signal,
    trigger: "@"
  });
  assert.deepEqual(
    result.groups.map((group) => ({
      id: group.id,
      label: group.label,
      totalCount: group.totalCount,
      nextCursor: group.nextCursor
    })),
    [
      {
        id: "pinned/topic",
        label: "Pinned",
        totalCount: 11,
        nextCursor: "cursor-pinned/topic"
      },
      {
        id: "recent:topic",
        label: "Recent",
        totalCount: 11,
        nextCursor: "cursor-recent:topic"
      }
    ]
  );
  const page = await provider.queryGroupPage({
    context: {},
    keyword: "login bug",
    groupId: "recent:topic",
    cursor: "cursor-recent:topic",
    pageSize: 10,
    abortSignal: abortController.signal,
    trigger: "@"
  });
  assert.equal(
    (page.items[0] as { issueId?: string } | undefined)?.issueId,
    "issue-recent:topic-next"
  );
  assert.deepEqual(
    calls.map((call) => ({
      topicId: call.topicId,
      pageToken: call.pageToken,
      hasSignal: call.signal === abortController.signal
    })),
    [
      { topicId: "pinned/topic", pageToken: undefined, hasSignal: true },
      { topicId: "recent:topic", pageToken: undefined, hasSignal: true },
      { topicId: "empty-topic", pageToken: undefined, hasSignal: true },
      {
        topicId: "recent:topic",
        pageToken: "cursor-recent:topic",
        hasSignal: true
      }
    ]
  );
});

test("workspace issue provider limits first-page topic concurrency to four", async () => {
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceIssueTopics(workspaceId: string) {
        return {
          topics: Array.from({ length: 8 }, (_, index) => ({
            isDefault: index === 0,
            summary: "",
            title: `Topic ${index}`,
            topicId: `topic-${index}`,
            workspaceId
          }))
        };
      },
      async listWorkspaceIssues(
        workspaceId: string,
        request: { topicId: string }
      ) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return {
          issues: [
            {
              issueId: `issue-${request.topicId}`,
              status: "open",
              title: request.topicId,
              topicId: request.topicId,
              workspaceId
            }
          ],
          statusCounts: {},
          totalCount: 1
        };
      }
    })
  });
  const provider = getProvider(service, "workspace-issue");
  assert.ok(provider.queryGroups);
  const pending = provider.queryGroups({
    context: {},
    keyword: "",
    trigger: "@"
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(active, 4);
  assert.equal(maxActive, 4);
  release();
  const result = await pending;
  assert.equal(result.groups.length, 8);
  assert.equal(maxActive, 4);
});

test("desktop rich text @ service resolves workspace issue query by issue id", async () => {
  const detailCalls: Array<{ issueId: string; workspaceId: string }> = [];
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
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
        assert.equal(request?.searchQuery, "issue-restore-1");
        return {
          issues: Array.from({ length: 10 }, (_, index) => ({
            issueId: `issue-existing-${index + 1}`,
            status: "open",
            title: `Existing issue ${index + 1}`,
            topicId: "topic-1",
            workspaceId
          })),
          nextPageToken: "cursor-2",
          statusCounts: {},
          totalCount: 25,
          workspaceId
        };
      },
      async getWorkspaceIssueDetail(workspaceId: string, issueId: string) {
        detailCalls.push({ issueId, workspaceId });
        return {
          issue: {
            content: "Restore icon",
            creatorDisplayName: "Alice",
            issueId,
            status: "open",
            title: "Restore issue icon",
            topicId: "topic-1",
            workspaceId
          },
          tasks: []
        };
      }
    })
  });

  const provider = getProvider(service, "workspace-issue");

  const items = await queryProvider(provider, "issue-restore-1");
  assert.ok(provider.queryGroups);
  const grouped = await provider.queryGroups({
    context: {},
    keyword: "issue-restore-1",
    maxResults: 5,
    trigger: "@"
  });

  assert.deepEqual(detailCalls, [
    { issueId: "issue-restore-1", workspaceId: "workspace-1" },
    { issueId: "issue-restore-1", workspaceId: "workspace-1" }
  ]);
  assert.equal(items.length, 11);
  assert.equal(provider.getItemKey(items[0]), "issue-restore-1");
  assert.equal(
    provider.getItemIconUrl?.(items[0]),
    "tutti-asset://issue/default.png"
  );
  assert.deepEqual(
    grouped.groups.map((group) => ({
      id: group.id,
      label: group.label,
      totalCount: group.totalCount,
      nextCursor: group.nextCursor,
      issueIds: group.items.map((item) => (item as { issueId: string }).issueId)
    })),
    [
      {
        id: "topic-1",
        label: "Default",
        totalCount: 25,
        nextCursor: "cursor-2",
        issueIds: [
          "issue-restore-1",
          "issue-existing-1",
          "issue-existing-2",
          "issue-existing-3",
          "issue-existing-4",
          "issue-existing-5",
          "issue-existing-6",
          "issue-existing-7",
          "issue-existing-8",
          "issue-existing-9",
          "issue-existing-10"
        ]
      }
    ]
  );
});

test("workspace issue compatibility query interleaves topics before global truncation", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceIssueTopics(workspaceId: string) {
        return {
          topics: ["topic-a", "topic-b"].map((topicId) => ({
            isDefault: topicId === "topic-a",
            summary: "",
            title: topicId,
            topicId,
            workspaceId
          }))
        };
      },
      async listWorkspaceIssues(
        workspaceId: string,
        request: { topicId: string }
      ) {
        const itemCount = request.topicId === "topic-a" ? 10 : 2;
        return {
          issues: Array.from({ length: itemCount }, (_, index) => ({
            issueId: `${request.topicId}-${index + 1}`,
            status: "open",
            title: `${request.topicId} issue ${index + 1}`,
            topicId: request.topicId,
            workspaceId
          })),
          statusCounts: {},
          totalCount: itemCount
        };
      },
      async getWorkspaceIssueDetail(workspaceId: string, issueId: string) {
        return {
          issue: {
            issueId,
            status: "open",
            title: "Exact issue",
            topicId: "topic-b",
            workspaceId
          },
          tasks: []
        };
      }
    })
  });
  const provider = getProvider(service, "workspace-issue");

  const items = await queryProvider(provider);

  assert.deepEqual(
    items.slice(0, 5).map((item) => provider.getItemKey(item)),
    ["topic-a-1", "topic-b-1", "topic-a-2", "topic-b-2", "topic-a-3"]
  );

  const exactItems = await queryProvider(provider, "issue-exact");
  assert.equal(provider.getItemKey(exactItems[0]), "issue-exact");
});

test("desktop rich text @ service assembles agent session providers by capability", async () => {
  const listCalls: Array<{
    limit?: number;
    searchQuery?: string;
    workspaceId: string;
  }> = [];
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceAgentSessions(
        workspaceId: string,
        request?: {
          limit?: number;
          searchQuery?: string;
        }
      ) {
        listCalls.push({
          limit: request?.limit,
          searchQuery: request?.searchQuery,
          workspaceId
        });
        return {
          hasMore: false,
          workspaceId,
          sessions: [
            {
              activeTurnId: "turn-1",
              latestTurnInteractions: [],
              pendingInteractions: [],
              activeTurn: {
                agentSessionId: "session-1",
                completedCommand: null,
                error: null,
                fileChanges: null,
                outcome: null,
                phase: "running",
                settledAtUnixMs: null,
                startedAtUnixMs: 1780272000000,
                turnId: "turn-1",
                updatedAtUnixMs: 1780272000000
              },
              createdAtUnixMs: 1780272000000,
              cwd: null,
              id: "session-1",
              provider: "codex",
              title: "@wang jomes & Codex hi",
              updatedAtUnixMs: 1780272000000
            }
          ]
        };
      }
    })
  });

  const provider = getProvider(service, "agent-session");
  const items = await queryProvider(provider, "mentions", {
    context: { metadata: { currentUserId: "account-user-1" } }
  });

  assert.deepEqual(listCalls, [
    {
      limit: 5,
      searchQuery: "mentions",
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
      title: "@wang jomes & Codex hi",
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
      label: "@wang jomes & Codex hi",
      presentation: {
        agentProviderId: "codex",
        participant: "local & Codex",
        status: "working",
        subtitle: "Codex"
      },
      scope: {
        scope: "my_sessions",
        userId: "local",
        workspaceId: "workspace-1"
      }
    }
  });
});

test("desktop agent session mentions query each selected Agent before merging", async () => {
  const agentTargetIds: Array<string | undefined> = [];
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceAgentSessions(
        workspaceId: string,
        request?: { agentTargetId?: string }
      ) {
        agentTargetIds.push(request?.agentTargetId);
        const agentTargetId = request?.agentTargetId ?? "all";
        return {
          hasMore: false,
          workspaceId,
          sessions: [
            {
              activeTurn: null,
              activeTurnId: null,
              agentTargetId,
              createdAtUnixMs: agentTargetId === "agent-b" ? 2 : 1,
              cwd: null,
              id: `session-${agentTargetId}`,
              latestTurn: {
                startedAtUnixMs: agentTargetId === "agent-a" ? 10 : 5
              },
              latestTurnInteractions: [],
              pendingInteractions: [],
              provider: "codex",
              providerSessionId: null,
              title: agentTargetId,
              updatedAtUnixMs: agentTargetId === "agent-b" ? 100 : 1
            }
          ]
        };
      }
    })
  });
  const provider = getProvider(service, "agent-session");

  const items = await queryProvider(provider, "", {
    context: {
      metadata: {
        referenceProvenanceFilter: {
          agentTargetIds: ["agent-a", "agent-b"],
          memberIds: null
        }
      }
    }
  });

  assert.deepEqual(agentTargetIds, ["agent-a", "agent-b"]);
  assert.deepEqual(
    items.map((item) => (item as { agentTargetId?: string }).agentTargetId),
    ["agent-a", "agent-b"]
  );
});

test("desktop rich text @ service presents extension sessions with Agent Target identity", async () => {
  const extensionTarget = createAgentTarget({
    iconUrl: "data:image/svg+xml;base64,gemini",
    id: "extension:gemini",
    launchRef: {
      type: "agent_extension",
      extensionInstallationId: "gemini@1.0.0"
    },
    name: "Gemini CLI",
    provider: "acp:gemini",
    sortOrder: 700
  });
  const service = new DesktopRichTextAtService({
    agentsService: createAgentsService([extensionTarget]),
    resolveAgentIconUrl: () => "tutti-asset://agent/all.png",
    resolveSessionStatusView: (status) => ({
      dataStatus: status,
      label: status,
      pulse: false
    }),
    tuttidClient: createTuttidClient({
      async listWorkspaceAgentSessions(workspaceId: string) {
        return {
          hasMore: false,
          workspaceId,
          sessions: [
            {
              activeTurn: null,
              activeTurnId: null,
              agentTargetId: "extension:gemini",
              createdAtUnixMs: 1780272000000,
              cwd: null,
              id: "gemini-session",
              latestTurn: null,
              latestTurnInteractions: [],
              pendingInteractions: [],
              provider: "acp:gemini",
              providerSessionId: "gemini-provider-session",
              title: "hi",
              updatedAtUnixMs: 1780272000000
            }
          ]
        };
      }
    }),
    userAvatarPlaceholderUrl: "tutti-asset://user/placeholder.png"
  });

  const provider = getProvider(service, "agent-session");
  const items = await queryProvider(provider);
  assert.equal(items.length, 1);
  assert.equal(
    provider.getItemIconUrl?.(items[0]),
    "data:image/svg+xml;base64,gemini"
  );
  const insertResult = provider.toInsertResult(items[0]);
  assert.equal(insertResult.kind, "mention");
  if (insertResult.kind !== "mention") {
    return;
  }
  assert.equal(insertResult.mention.scope?.agentTargetId, "extension:gemini");
  assert.equal(insertResult.mention.presentation?.subtitle, "Gemini CLI");
  assert.equal(
    insertResult.mention.presentation?.participant,
    "local & Gemini CLI"
  );
  assert.equal(
    insertResult.mention.presentation?.agentIconUrl,
    "data:image/svg+xml;base64,gemini"
  );
});

test("desktop rich text @ service assembles workspace app providers from mention candidates", async () => {
  const listCalls: string[] = [];
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceAppMentionCandidates(workspaceId: string) {
        listCalls.push(workspaceId);
        return {
          workspaceId,
          apps: [
            createWorkspaceAppMentionCandidate({
              appId: "app-weather",
              commandCount: 2,
              commandDescriptions: ["Inspect weather forecasts."],
              commandPaths: ["weather forecast", "weather alerts"],
              commandSummaries: ["Get a forecast", "List weather alerts"],
              description: "Plan weather-sensitive work.",
              displayName: "Weather Desk",
              iconUrl: "data:image/png;base64,weather",
              referencesListSupported: true,
              scopes: ["weather"]
            })
          ]
        };
      }
    })
  });

  const provider = getProvider(service, "workspace-app");
  const items = await queryProvider(provider, "weather");

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
      referencesListSupported: true,
      scopes: ["weather"],
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    provider.getItemSubtitle?.(items[0]),
    "Plan weather-sensitive work."
  );
  assert.deepEqual(provider.toInsertResult(items[0]), {
    kind: "mention",
    mention: {
      entityId: "app-weather",
      label: "Weather Desk",
      presentation: {
        description: "Plan weather-sensitive work.",
        iconUrl: "data:image/png;base64,weather",
        referencesListSupported: "true",
        subtitle: "Plan weather-sensitive work."
      },
      scope: {
        workspaceId: "workspace-1"
      }
    }
  });
});

test("desktop rich text @ service excludes legacy provider agent pseudo apps from workspace app mentions", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceAppMentionCandidates(workspaceId: string) {
        return {
          workspaceId,
          apps: [
            createWorkspaceAppMentionCandidate({
              appId: "agent-codex",
              description:
                "Start a Codex agent session in the current workspace.",
              displayName: "Codex"
            }),
            createWorkspaceAppMentionCandidate({
              appId: "agent-claude-code",
              description:
                "Start a Claude Code agent session in the current workspace.",
              displayName: "Claude Code"
            })
          ]
        };
      }
    })
  });

  const provider = getProvider(service, "workspace-app");
  const items = await queryProvider(provider);

  assert.deepEqual(items, []);
});

test("desktop rich text @ service assembles agent target mentions", async () => {
  const targets = [
    createAgentTarget({
      id: "local:codex",
      name: "Codex",
      provider: "codex",
      sortOrder: 10
    }),
    createAgentTarget({
      id: "local:claude-code",
      name: "Claude Code",
      provider: "claude-code",
      sortOrder: 20
    }),
    createAgentTarget({
      enabled: false,
      id: "disabled-codex",
      name: "Disabled Codex",
      provider: "codex",
      sortOrder: 30
    })
  ];
  const service = new DesktopRichTextAtService({
    agentsService: createAgentsService(targets),
    tuttidClient: createTuttidClient()
  });

  const provider = getProvider(service, "agent-target");
  const items = await queryProvider(provider);

  assert.deepEqual(
    items.map((item) => provider.getItemKey(item)),
    ["local:codex", "local:claude-code"]
  );
  assert.equal(provider.getItemIconUrl?.(items[0]), tuttiAgentAssetUrls.codex);
  assert.equal(provider.getItemSubtitle, undefined);
  assert.deepEqual(provider.toInsertResult(items[0]), {
    kind: "mention",
    mention: {
      entityId: "local:codex",
      label: "Codex",
      presentation: {
        agentProviderId: "codex",
        iconUrl: tuttiAgentAssetUrls.codex
      },
      scope: {
        workspaceId: "workspace-1"
      }
    }
  });
});

test("desktop rich text @ service includes ready open-provider extension targets", async () => {
  const targets = [
    createAgentTarget({
      iconUrl: "data:image/svg+xml;base64,gemini",
      id: "extension:gemini",
      launchRef: {
        type: "agent_extension",
        extensionInstallationId: "gemini@1.0.0"
      },
      name: "Gemini CLI",
      provider: "acp:gemini",
      sortOrder: 700
    })
  ];
  const service = new DesktopRichTextAtService({
    agentsService: createAgentsService(targets),
    tuttidClient: createTuttidClient()
  });

  const provider = getProvider(service, "agent-target");
  const items = await queryProvider(provider, "gemini");

  assert.equal(items.length, 1);
  assert.equal(provider.getItemKey(items[0]), "extension:gemini");
  assert.equal(provider.getItemLabel(items[0]), "Gemini CLI");
  assert.equal(
    provider.getItemIconUrl?.(items[0]),
    "data:image/svg+xml;base64,gemini"
  );
  assert.deepEqual(provider.toInsertResult(items[0]), {
    kind: "mention",
    mention: {
      entityId: "extension:gemini",
      label: "Gemini CLI",
      presentation: {
        agentProviderId: "acp:gemini",
        iconUrl: "data:image/svg+xml;base64,gemini"
      },
      scope: { workspaceId: "workspace-1" }
    }
  });
});

test("desktop rich text @ service hides agent target mentions using cached provider readiness", async () => {
  const targets = [
    createAgentTarget({
      id: "local:codex",
      name: "Codex",
      provider: "codex",
      sortOrder: 10
    }),
    createAgentTarget({
      id: "local:claude-code",
      name: "Claude Code",
      provider: "claude-code",
      sortOrder: 20
    })
  ];
  const service = new DesktopRichTextAtService({
    agentsService: createAgentsService(targets),
    tuttidClient: createTuttidClient(),
    agentProviderStatuses: () => [
      createAgentProviderStatus({
        availability: "ready",
        provider: "codex"
      }),
      createAgentProviderStatus({
        availability: "not_installed",
        provider: "claude-code"
      })
    ]
  });

  const provider = getProvider(service, "agent-target");
  const items = await queryProvider(provider);

  assert.deepEqual(
    items.map((item) => provider.getItemKey(item)),
    ["local:codex"]
  );
});

test("desktop rich text @ service uses task icon fallback for issue manager app mentions", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceAppMentionCandidates(workspaceId: string) {
        return {
          workspaceId,
          apps: [
            createWorkspaceAppMentionCandidate({
              appId: "issue-manager",
              commandCount: 1,
              commandDescriptions: ["List workspace tasks."],
              commandPaths: ["issue list"],
              commandSummaries: ["List tasks"],
              description: "Manage workspace tasks and runs.",
              displayName: "Task Manager",
              scopes: ["issue"]
            })
          ]
        };
      }
    })
  });

  const provider = getProvider(service, "workspace-app");
  const items = await queryProvider(provider, "task");

  assert.deepEqual(items, [
    {
      appId: "issue-manager",
      commandCount: 1,
      commandDescriptions: ["List workspace tasks."],
      commandPaths: ["issue list"],
      description: "Manage workspace tasks and runs.",
      commandSummaries: ["List tasks"],
      displayName: "Task Manager",
      iconUrl: tuttiIssueAssetUrls.default,
      referencesListSupported: false,
      scopes: ["issue"],
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    provider.getItemIconUrl?.(items[0]),
    tuttiIssueAssetUrls.default
  );
  assert.deepEqual(provider.toInsertResult(items[0]), {
    kind: "mention",
    mention: {
      entityId: "issue-manager",
      label: "Task Manager",
      presentation: {
        description: "Manage workspace tasks and runs.",
        iconUrl: tuttiIssueAssetUrls.default,
        subtitle: "Manage workspace tasks and runs."
      },
      scope: {
        workspaceId: "workspace-1"
      }
    }
  });
});

test("desktop rich text @ service hides issue manager app mentions from issue manager", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceAppMentionCandidates(workspaceId: string) {
        return {
          workspaceId,
          apps: [
            createWorkspaceAppMentionCandidate({
              appId: "issue-manager",
              description: "Manage workspace tasks and runs.",
              displayName: "Task Manager"
            }),
            createWorkspaceAppMentionCandidate({
              appId: "app-weather",
              description: "Plan weather-sensitive work.",
              displayName: "Weather Desk"
            })
          ]
        };
      }
    })
  });

  const provider = getProvider(service, "workspace-app", {
    surface: "task",
    target: "issue-manager"
  });
  const items = await queryProvider(provider);

  assert.deepEqual(
    items.map((item) => provider.getItemKey(item)),
    ["app-weather"]
  );
});

function createWorkspaceAppMentionCandidate(input: {
  appId: string;
  commandCount?: number;
  commandDescriptions?: string[];
  commandPaths?: string[];
  commandSummaries?: string[];
  description: string;
  displayName: string;
  iconUrl?: string | null;
  localizations?: Array<{
    description?: string | null;
    displayName?: string | null;
    locale: string;
    tags?: string[];
  }>;
  referencesListSupported?: boolean;
  referencesSearchSupported?: boolean;
  scopes?: string[];
  source?: "workspace_app" | "cli_app";
}) {
  return {
    appId: input.appId,
    availableIconUrl: null,
    cli: {
      commandCount: input.commandCount ?? 0,
      commandDescriptions: input.commandDescriptions ?? [],
      commandPaths: input.commandPaths ?? [],
      commandSummaries: input.commandSummaries ?? [],
      scopes: input.scopes ?? []
    },
    description: input.description,
    displayName: input.displayName,
    enabled: true,
    iconUrl: input.iconUrl ?? null,
    installed: true,
    localizations: (input.localizations ?? []).map((localization) => ({
      description: localization.description ?? null,
      displayName: localization.displayName ?? null,
      locale: localization.locale,
      tags: localization.tags ?? []
    })),
    references: {
      listSupported: input.referencesListSupported ?? false,
      searchSupported: input.referencesSearchSupported ?? false
    },
    source: input.source ?? "cli_app"
  };
}

function createAgentTarget(input: {
  enabled?: boolean;
  iconUrl?: string;
  id: string;
  launchRef?: AgentTarget["launchRef"];
  name: string;
  provider: string;
  sortOrder: number;
}): AgentTarget {
  return {
    createdAtUnixMs: 1780272000000,
    enabled: input.enabled ?? true,
    iconKey: "",
    iconUrl: input.iconUrl ?? resolveTestAgentIconUrl(input.provider),
    id: input.id,
    launchRef: input.launchRef ?? {
      provider: input.provider,
      type: "builtin_local"
    },
    name: input.name,
    provider: input.provider,
    sortOrder: input.sortOrder,
    source: "system",
    updatedAtUnixMs: 1780272000000
  };
}

function createAgentsService(
  targets: readonly AgentTarget[]
): Pick<IAgentsService, "load"> {
  const agentTargets = mapAgentTargetsToPresentations(targets);
  const snapshot: AgentsSnapshot = {
    agentTargets,
    capturedAtUnixMs: 1780272000000,
    agents: mapAgentTargetPresentationsToAgents(agentTargets),
    error: null,
    status: "ready"
  };
  return {
    async load() {
      return snapshot;
    }
  };
}

function resolveTestAgentIconUrl(provider: string): string {
  switch (provider) {
    case "claude-code":
      return tuttiAgentAssetUrls.claudeCode;
    case "codex":
      return tuttiAgentAssetUrls.codex;
    default:
      return "";
  }
}

function createAgentProviderStatus(input: {
  availability: AgentProviderStatus["availability"]["status"];
  provider: WorkspaceAgentProvider;
}): AgentProviderStatus {
  return {
    actions: [],
    adapter: {
      command: [],
      installed: input.availability === "ready"
    },
    auth: {
      status: "unknown"
    },
    availability: {
      status: input.availability
    },
    cli: {
      installed: input.availability === "ready"
    },
    provider: input.provider,
    update: {
      capability: "unsupported",
      currentVersion: null,
      lastCheckedAt: null,
      latestVersion: null,
      reasonCode: null,
      source: null,
      unsupportedReason: "update_strategy_unsupported",
      updateAvailable: null
    }
  };
}

test("desktop rich text @ service only matches workspace app display names", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceAppMentionCandidates(workspaceId: string) {
        return {
          workspaceId,
          apps: [
            createWorkspaceAppMentionCandidate({
              appId: "scheduler-core",
              description: "Review recurring schedules.",
              displayName: "Automation"
            })
          ]
        };
      }
    })
  });

  const provider = getProvider(service, "workspace-app");
  for (const keyword of ["scheduler", "recurring", "automations", "schedule"]) {
    const items = await queryProvider(provider, keyword);
    assert.deepEqual(items, []);
  }

  const items = await queryProvider(provider, "automation");
  assert.equal(items.length, 1);
  assert.equal((items[0] as { displayName: string }).displayName, "Automation");
});

test("desktop rich text @ service localizes workspace app presentation", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceAppMentionCandidates(workspaceId: string) {
        return {
          workspaceId,
          apps: [
            createWorkspaceAppMentionCandidate({
              appId: "app-weather",
              commandCount: 1,
              commandDescriptions: ["Inspect weather forecasts."],
              commandPaths: ["weather forecast"],
              commandSummaries: ["Get a forecast"],
              description: "Plan weather-sensitive work.",
              displayName: "Weather Desk",
              iconUrl: "https://icons/weather.png",
              localizations: [
                {
                  description: "Planifiez selon la météo.",
                  displayName: "Bureau Météo",
                  locale: "fr-FR",
                  tags: []
                }
              ],
              scopes: ["weather"]
            })
          ]
        };
      }
    }),
    getLocale: () => "fr-FR"
  });

  const appProvider = getProvider(service, "workspace-app");
  const appItems = await queryProvider(appProvider);
  const appInsert = appProvider.toInsertResult(appItems[0]);
  assert.equal(appInsert.kind, "mention");
  assert.equal(appInsert.mention.label, "Bureau Météo");
  assert.equal(
    appInsert.mention.presentation?.description,
    "Planifiez selon la météo."
  );
  assert.equal(
    appInsert.mention.presentation?.iconUrl,
    "https://icons/weather.png"
  );
});

test("desktop rich text @ service returns no providers without requested capabilities", () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient()
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
    tuttidClient: createTuttidClient()
  });

  const firstProviders = service.getProviders({
    capabilities: ["file"],
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });
  const secondProviders = service.getProviders({
    capabilities: ["file"],
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });

  assert.equal(secondProviders, firstProviders);
  assert.equal(secondProviders[0], firstProviders[0]);
});

test("desktop rich text @ service enriches cached agent session providers", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async listWorkspaceAgentSessions(workspaceId: string) {
        return {
          hasMore: false,
          workspaceId,
          sessions: [
            {
              activeTurnId: null,
              latestTurnInteractions: [],
              pendingInteractions: [],
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
    }),
    resolveAgentIconUrl: (provider) => `https://agents/${provider}.png`,
    userAvatarPlaceholderUrl: "https://avatars/placeholder.png",
    resolveSessionStatusView: (status) => ({
      dataStatus: status,
      label: status,
      pulse: false
    })
  });
  const request = {
    capabilities: ["agent-session"],
    surface: "workspace-app-external",
    target: "workspace-app",
    workspaceId: "workspace-1"
  } as const;

  const firstProviders = service.getProviders(request);
  const secondProviders = service.getProviders(request);
  const items = await secondProviders[0]?.query({
    context: {},
    keyword: "",
    maxResults: 5,
    trigger: "@"
  });

  assert.equal(typeof firstProviders[0]?.getItemIconUrl, "function");
  assert.equal(typeof secondProviders[0]?.getItemIconUrl, "function");
  assert.equal(
    await secondProviders[0]?.getItemIconUrl?.(items?.[0]),
    "https://agents/codex.png"
  );
});

test("desktop rich text @ service honors abort before provider search starts", async () => {
  let searchCallCount = 0;
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
      async searchWorkspaceFiles() {
        searchCallCount += 1;
        return {
          entries: [],
          root: "/Users/test/project/tutti",
          workspaceID: "workspace-1"
        };
      }
    })
  });

  const [provider] = service.getProviders({
    capabilities: ["file"],
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
    maxResults: 3,
    trigger: "@"
  });

  assert.deepEqual(items, []);
  assert.equal(searchCallCount, 0);
});

test("desktop rich text @ service passes abort signals through to tuttid search", async () => {
  let receivedSignal: AbortSignal | undefined;
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient({
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
    })
  });

  const [provider] = service.getProviders({
    capabilities: ["file"],
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
    maxResults: 3,
    trigger: "@"
  });

  assert.equal(receivedSignal, abortController.signal);
});

test("desktop rich text @ service skips provider caching when metadata is present", () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: createTuttidClient()
  });

  const firstProviders = service.getProviders({
    capabilities: ["file"],
    metadata: { session: "a" },
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });
  const secondProviders = service.getProviders({
    capabilities: ["file"],
    metadata: { session: "b" },
    surface: "issue",
    target: "issue-manager",
    workspaceId: "workspace-1"
  });

  assert.notEqual(secondProviders, firstProviders);
  assert.notEqual(secondProviders[0], firstProviders[0]);
});

test("desktop rich text @ service lists enabled plan models for workspace-model mentions", async () => {
  const service = new DesktopRichTextAtService({
    tuttidClient: {
      async listModelPlans(workspaceId: string) {
        assert.equal(workspaceId, "workspace-1");
        return {
          plans: [
            {
              enabled: true,
              id: "plan-relay",
              models: [
                { id: "grok-4.5", name: "xAI: Grok 4.5" },
                { id: "glm-5.2", name: "Z.Ai: GLM 5.2" }
              ],
              name: "Relay endpoint"
            },
            {
              enabled: false,
              id: "plan-disabled",
              models: [{ id: "hidden-model", name: "Hidden" }],
              name: "Disabled plan"
            }
          ]
        };
      }
    } as unknown as TuttidClient
  });

  const providers = service.getProviders({
    capabilities: ["workspace-model"],
    surface: "composer",
    target: "agent-gui",
    workspaceId: "workspace-1"
  });
  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.ok(provider);
  assert.equal(provider.id, "workspace-model");

  const items = await provider.query({
    context: {},
    keyword: "grok",
    maxResults: 5,
    trigger: "@"
  });
  assert.equal(items.length, 1);
  assert.equal(provider.getItemLabel(items[0]), "xAI: Grok 4.5");
  assert.equal(provider.getItemSubtitle?.(items[0]), "Relay endpoint");

  const insert = provider.toInsertResult(items[0]);
  assert.deepEqual(insert, {
    kind: "mention",
    mention: {
      entityId: "grok-4.5",
      label: "xAI: Grok 4.5",
      presentation: { subtitle: "Relay endpoint" },
      scope: { modelPlanId: "plan-relay", workspaceId: "workspace-1" }
    }
  });

  const resolved = await provider.resolveMention?.({
    entityId: "grok-4.5",
    label: "xAI: Grok 4.5",
    providerId: "workspace-model",
    scope: { modelPlanId: "plan-relay", workspaceId: "workspace-1" }
  });
  assert.deepEqual(resolved, {
    label: "xAI: Grok 4.5",
    presentation: { subtitle: "Relay endpoint" }
  });

  const disabledPlanItems = await provider.query({
    context: {},
    keyword: "hidden",
    maxResults: 5,
    trigger: "@"
  });
  assert.equal(disabledPlanItems.length, 0);
});
