import { afterEach, describe, expect, it, vi } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../i18n/testUtils";
import { AgentMentionSearchController as BaseAgentMentionSearchController } from "./AgentMentionSearchController";
import { issuePreviewText } from "./agentMentionSearchHelpers";
import type { AgentContextMentionProvider } from "./agentContextMentionProvider";
import { AGENT_CONTEXT_MENTION_PROVIDER_IDS } from "./agentContextMentionProvider";

interface TestFileMentionItem {
  label: string;
  href: string;
}

interface TestIssueMentionItem {
  issueId: string;
  title: string;
  status: string;
}

interface TestSessionMentionItem {
  agentName: string;
  id: string;
  initiatorName: string;
  provider: string;
  scope?: "my_sessions" | "collab_sessions";
  status: string;
  title: string;
  updatedAtUnixMs: number;
  userId: string;
  workspaceId: string;
}

const {
  agentGeneratedFile: AGENT_GENERATED_FILE_PROVIDER_ID,
  agentSession: AGENT_SESSION_PROVIDER_ID,
  file: FILE_PROVIDER_ID,
  workspaceApp: WORKSPACE_APP_PROVIDER_ID,
  workspaceIssue: WORKSPACE_ISSUE_PROVIDER_ID
} = AGENT_CONTEXT_MENTION_PROVIDER_IDS;

interface TestContextMentionProviderOptions {
  queryAgentGeneratedFiles?: (input: any) => Promise<any>;
  queryFiles?: (input: any) => Promise<any>;
  queryIssues?: (input: any) => Promise<any>;
  querySessions?: (input: any) => Promise<any>;
  loadSessionSummary?: (input: any) => Promise<any>;
  loadUserProfiles?: (input: any) => Promise<any>;
  loadSessionMessages?: (input: any) => Promise<any>;
  contextMentionProviders?: readonly AgentContextMentionProvider[];
  debounceMs?: number;
  diagnosticInfoLogger?: (payload: any) => void;
  diagnosticNow?: () => number;
  diagnosticSlowThresholdMs?: number;
  fileLimit?: number;
  issueLimit?: number;
  providerTimeoutMs?: number;
}

class AgentMentionSearchController extends BaseAgentMentionSearchController {
  constructor(options: TestContextMentionProviderOptions) {
    super({
      debounceMs: options.debounceMs,
      diagnosticInfoLogger: options.diagnosticInfoLogger,
      diagnosticNow: options.diagnosticNow,
      diagnosticSlowThresholdMs: options.diagnosticSlowThresholdMs,
      fileLimit: options.fileLimit,
      issueLimit: options.issueLimit,
      providerTimeoutMs: options.providerTimeoutMs,
      contextMentionProviders:
        options.contextMentionProviders ??
        createTestContextMentionProviders(options)
    });
  }
}

function createTestContextMentionProviders(
  options: TestContextMentionProviderOptions
): readonly AgentContextMentionProvider[] {
  return [
    createTestFileProvider(options),
    createTestAgentGeneratedFileProvider(options),
    createTestIssueProvider(options),
    createTestSessionProvider(options)
  ];
}

function createTestAgentGeneratedFileProvider(
  options: TestContextMentionProviderOptions
): AgentContextMentionProvider<{ label: string; href: string }> {
  return {
    id: AGENT_GENERATED_FILE_PROVIDER_ID,
    trigger: "@",
    async query({ context, keyword, maxResults }) {
      if (!options.queryAgentGeneratedFiles) {
        return [];
      }
      const result = await options.queryAgentGeneratedFiles({
        workspaceId: context?.metadata?.workspaceId,
        query: keyword,
        limit: maxResults
      });
      return (result.entries ?? []).map((entry: any) => ({
        label: entry.name,
        href: entry.path
      }));
    },
    getItemKey: (item) => item.href,
    getItemLabel: (item) => item.label,
    toInsertResult: (item) => ({
      kind: "markdown-link",
      label: item.label,
      href: item.href
    })
  };
}

function createTestFileProvider(
  options: TestContextMentionProviderOptions
): AgentContextMentionProvider<{ label: string; href: string }> {
  return {
    id: FILE_PROVIDER_ID,
    trigger: "@",
    async query({ context, keyword, maxResults }) {
      if (!options.queryFiles) {
        return [];
      }
      const result = await options.queryFiles({
        workspaceId: context?.metadata?.workspaceId,
        query: keyword,
        limit: maxResults,
        includeKinds: ["file", "directory"]
      });
      return (result.entries ?? []).map((entry: any) => ({
        label: entry.name,
        href: entry.path
      }));
    },
    getItemKey: (item) => item.href,
    getItemLabel: (item) => item.label,
    toInsertResult: (item) => ({
      kind: "markdown-link",
      label: item.label,
      href: item.href
    })
  };
}

function createTestIssueProvider(
  options: TestContextMentionProviderOptions
): AgentContextMentionProvider<any> {
  return {
    id: WORKSPACE_ISSUE_PROVIDER_ID,
    trigger: "@",
    async query({ context, keyword, maxResults }) {
      if (!options.queryIssues) {
        return [];
      }
      const result = await options.queryIssues({
        workspaceId: context?.metadata?.workspaceId,
        pageSize: maxResults,
        searchQuery: keyword
      });
      return result.issues ?? [];
    },
    getItemKey: (item) => item.issueId,
    getItemLabel: (item) => item.title,
    getItemSubtitle: (item) => issuePreviewText(item.content),
    toInsertResult: (item) => ({
      kind: "mention",
      mention: {
        entityId: item.issueId,
        label: item.title,
        scope: { workspaceId: item.workspaceId },
        presentation: {
          description: issuePreviewText(item.content),
          status: item.status
        }
      }
    })
  };
}

function createTestSessionProvider(
  options: TestContextMentionProviderOptions
): AgentContextMentionProvider<any> {
  return {
    id: AGENT_SESSION_PROVIDER_ID,
    trigger: "@",
    async query({ context, keyword, maxResults }) {
      if (!options.querySessions) {
        return [];
      }
      const workspaceId = String(context?.metadata?.workspaceId ?? "");
      const currentUserId = String(context?.metadata?.currentUserId ?? "");
      const snapshot = await options.querySessions({
        workspaceId,
        sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
      });
      const sessions = (snapshot.sessions ?? []).slice(0, maxResults);
      const userIds = [
        ...new Set(
          sessions
            .map((session: any) => String(session.userId ?? "").trim())
            .filter(Boolean)
        )
      ];
      const profilesResult =
        userIds.length > 0 && options.loadUserProfiles
          ? await options.loadUserProfiles({ userIds })
          : { users: [] };
      const profiles = new Map(
        (profilesResult.users ?? []).map((user: any) => [user.userId, user])
      );
      const items = await Promise.all(
        sessions.map(async (session: any) => {
          const summary = options.loadSessionSummary
            ? await Promise.resolve(
                options.loadSessionSummary({
                  workspaceId,
                  agentSessionId: session.agentSessionId,
                  agentReplyLimit: 1,
                  recentTurnLimit: 1
                })
              ).catch(() => null)
            : null;
          const userId = String(session.userId ?? "");
          const profile = profiles.get(userId) as any;
          const title =
            compactSessionText(session.title) ||
            compactSessionText(summary?.latestUserRequirement) ||
            compactSessionText(summary?.initialUserRequirement) ||
            (await testSessionFallbackTitle({
              loadSessionMessages: options.loadSessionMessages,
              session,
              workspaceId
            })) ||
            session.agentSessionId;
          return {
            agentName: testProviderLabel(session.provider),
            id: session.agentSessionId,
            initiatorAvatarUrl: profile?.avatar ?? "",
            initiatorName: profile?.name || userId,
            provider: session.provider,
            scope:
              userId && userId === currentUserId
                ? "my_sessions"
                : "collab_sessions",
            status: testSessionStatus(summary, session),
            title,
            inputPreview:
              compactSessionText(summary?.latestUserRequirement) ||
              compactSessionText(summary?.initialUserRequirement),
            summaryPreview: compactSessionText(
              summary?.recentAgentReplies?.[0]
            ),
            updatedAtUnixMs:
              session.updatedAtUnixMs ?? session.createdAtUnixMs ?? 0,
            userId,
            workspaceId
          };
        })
      );
      const normalizedKeyword = keyword.trim().toLowerCase();
      return normalizedKeyword
        ? items.filter((item) =>
            [
              item.agentName,
              item.initiatorName,
              item.provider,
              item.title,
              item.inputPreview,
              item.summaryPreview
            ]
              .join("\n")
              .toLowerCase()
              .includes(normalizedKeyword)
          )
        : items;
    },
    getItemKey: (item) => item.id,
    getItemLabel: (item) => item.title,
    getItemSubtitle: (item) => item.inputPreview || item.status,
    toInsertResult: (item) => ({
      kind: "mention",
      mention: {
        entityId: item.id,
        label: item.title,
        scope: {
          scope: item.scope ?? "",
          userId: item.userId,
          workspaceId: item.workspaceId
        },
        presentation: {
          description: item.inputPreview || item.summaryPreview,
          status: item.status,
          subtitle: item.agentName
        }
      }
    })
  };
}

function compactSessionText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function testProviderLabel(provider: string): string {
  if (provider === "codex") {
    return "Codex";
  }
  if (provider === "nexight") {
    return "Nexight";
  }
  if (provider === "claude-code") {
    return "Claude Code";
  }
  return provider;
}

function testSessionStatus(summary: any, session: any): string {
  const raw = String(
    (typeof summary?.executionStatus === "string"
      ? summary.executionStatus
      : summary?.executionStatus?.currentOrFinalStatus) ??
      summary?.currentOrFinalStatus ??
      session.lifecycleStatus ??
      session.status ??
      "idle"
  ).toLowerCase();
  return raw === "running" ? "working" : raw;
}

async function testSessionFallbackTitle({
  loadSessionMessages,
  session,
  workspaceId
}: {
  loadSessionMessages?: (input: any) => Promise<any>;
  session: any;
  workspaceId: string;
}): Promise<string> {
  if (!loadSessionMessages) {
    return "";
  }
  const result = await loadSessionMessages({
    workspaceId,
    agentSessionId: session.agentSessionId,
    ...(session.sessionOrigin ? { sessionOrigin: session.sessionOrigin } : {}),
    afterVersion: 0,
    limit: 20
  }).catch(() => null);
  const messages = result?.messages ?? [];
  const firstUserMessage = messages.find((message: any) => {
    return message.role === "user" || message.kind === "user";
  });
  return compactSessionText(
    firstUserMessage?.payload?.text ?? firstUserMessage?.body ?? ""
  );
}

describe("AgentMentionSearchController", () => {
  afterEach(() => {
    vi.useRealTimers();
    void setAgentGuiI18nTestLocale("en");
  });

  it("localizes browse filter categories using the active locale at emit time", () => {
    // Regression: browse category labels used to be frozen to the default ("en")
    // runtime because they were computed once at module load. They must reflect
    // the active agent GUI locale when a state is emitted.
    setAgentGuiI18nTestLocale("zh-CN");
    const controller = new AgentMentionSearchController({});
    const states: { categories: readonly { id: string; label: string }[] }[] =
      [];
    controller.subscribe((state) => states.push(state));

    const categories = states.at(-1)?.categories ?? [];
    const labelById = new Map(categories.map((c) => [c.id, c.label]));

    expect(labelById.get("app")).toBe("应用");
    expect(labelById.get("session")).toBe("会话");
    expect(labelById.get("issue")).toBe("事项");
    expect(labelById.get("all")).toBe("全部");
  });

  it("uses Tasks for the English issue browse category label", () => {
    setAgentGuiI18nTestLocale("en");
    const controller = new AgentMentionSearchController({});
    const states: { categories: readonly { id: string; label: string }[] }[] =
      [];
    controller.subscribe((state) => states.push(state));

    const categories = states.at(-1)?.categories ?? [];
    const labelById = new Map(categories.map((c) => [c.id, c.label]));

    expect(labelById.get("issue")).toBe("Tasks");
  });

  it("prefetches the browse overview for blank queries including dock files", async () => {
    const queryFiles = vi.fn().mockResolvedValue({
      workspaceId: "room-1",
      root: "/workspace",
      entries: []
    });
    const controller = new AgentMentionSearchController({
      queryFiles,
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({ workspaceId: "room-1", query: "   " });

    expect(states.at(-1)).toMatchObject({
      status: "loading",
      mode: "browse",
      query: ""
    });
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "browse",
        filter: "all"
      })
    );
    expect(queryFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "room-1",
        query: "",
        limit: 30
      })
    );
  });

  it("debounces grouped searches and returns file results", async () => {
    vi.useFakeTimers();
    const queryFiles = vi.fn().mockResolvedValue({
      workspaceId: "room-1",
      root: "/workspace",
      entries: [
        {
          path: "/workspace/src/App.tsx",
          name: "App.tsx",
          kind: "file",
          directoryPath: "/workspace/src",
          score: 10
        }
      ]
    });
    const controller = new AgentMentionSearchController({
      queryFiles,
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] }),
      debounceMs: 20
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: " room-1 ",
      currentUserId: "user-1",
      query: " app "
    });
    expect(states.at(-1)).toMatchObject({
      status: "loading",
      query: "app",
      mode: "results"
    });

    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() => expect(queryFiles).toHaveBeenCalledTimes(1));

    expect(queryFiles).toHaveBeenCalledWith({
      workspaceId: "room-1",
      query: "app",
      limit: 30,
      includeKinds: ["file", "directory"]
    });
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      query: "app",
      mode: "results",
      groups: expect.arrayContaining([
        expect.objectContaining({
          id: "files",
          items: [
            expect.objectContaining({
              kind: "file",
              path: "/workspace/src/App.tsx",
              name: "App.tsx"
            })
          ]
        })
      ])
    });
  });

  it("logs completed mention search diagnostics without the raw query", async () => {
    vi.useFakeTimers();
    const diagnosticLogs: any[] = [];
    const rawQuery = "secret-file";
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: [
          {
            path: "/workspace/src/App.tsx",
            name: "App.tsx",
            kind: "file",
            directoryPath: "/workspace/src",
            score: 10
          }
        ]
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] }),
      debounceMs: 20,
      diagnosticInfoLogger: (payload) => diagnosticLogs.push(payload),
      diagnosticSlowThresholdMs: 0
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: rawQuery
    });
    await vi.advanceTimersByTimeAsync(20);

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        query: rawQuery,
        mode: "results"
      })
    );
    expect(diagnosticLogs).toEqual([
      expect.objectContaining({
        debounceMs: 20,
        event: "agent_gui.mention_search",
        mode: "results",
        queryLength: rawQuery.length,
        status: "ready",
        workspaceId: "room-1",
        providerResults: expect.arrayContaining([
          expect.objectContaining({
            providerId: FILE_PROVIDER_ID,
            resultCount: 1,
            status: "success"
          }),
          expect.objectContaining({
            providerId: WORKSPACE_APP_PROVIDER_ID,
            resultCount: 0,
            status: "missing"
          })
        ])
      })
    ]);
    expect(JSON.stringify(diagnosticLogs)).not.toContain(rawQuery);
  });

  it("keeps mention search ready when diagnostic logging fails", async () => {
    vi.useFakeTimers();
    const diagnosticInfoLogger = vi.fn(() => {
      throw new Error("diagnostic sink failed");
    });
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: [
          {
            path: "/workspace/src/App.tsx",
            name: "App.tsx",
            kind: "file",
            directoryPath: "/workspace/src",
            score: 10
          }
        ]
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] }),
      debounceMs: 20,
      diagnosticInfoLogger,
      diagnosticSlowThresholdMs: 0
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: "app"
    });
    await vi.advanceTimersByTimeAsync(20);

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        query: "app",
        mode: "results"
      })
    );
    expect(diagnosticInfoLogger).toHaveBeenCalledTimes(1);
  });

  it("times out stalled result providers and keeps partial results", async () => {
    vi.useFakeTimers();
    const diagnosticLogs: any[] = [];
    const rawQuery = "secret-token";
    const queryIssues = vi.fn(
      () =>
        new Promise(() => {
          // Simulates a host provider that neither resolves nor rejects.
        })
    );
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: [
          {
            path: "/workspace/src/App.tsx",
            name: "App.tsx",
            kind: "file",
            directoryPath: "/workspace/src",
            score: 10
          }
        ]
      }),
      queryIssues,
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] }),
      debounceMs: 20,
      diagnosticInfoLogger: (payload) => diagnosticLogs.push(payload),
      providerTimeoutMs: 20
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: rawQuery
    });
    await vi.advanceTimersByTimeAsync(40);

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        query: rawQuery,
        mode: "results",
        groups: expect.arrayContaining([
          expect.objectContaining({
            id: "files",
            items: [
              expect.objectContaining({
                kind: "file",
                path: "/workspace/src/App.tsx"
              })
            ]
          })
        ])
      })
    );
    expect(queryIssues).toHaveBeenCalledTimes(1);
    expect(diagnosticLogs).toEqual([
      expect.objectContaining({
        event: "agent_gui.mention_search",
        mode: "results",
        providerTimeoutMs: 20,
        queryLength: rawQuery.length,
        status: "ready",
        providerResults: expect.arrayContaining([
          expect.objectContaining({
            providerId: WORKSPACE_ISSUE_PROVIDER_ID,
            resultCount: 0,
            status: "timeout"
          })
        ])
      })
    ]);
    expect(JSON.stringify(diagnosticLogs)).not.toContain(rawQuery);
  });

  it("times out stalled browse providers and keeps partial results", async () => {
    vi.useFakeTimers();
    const queryIssues = vi.fn(
      () =>
        new Promise(() => {
          // Simulates a host provider that neither resolves nor rejects.
        })
    );
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: [
          {
            path: "/workspace/src/App.tsx",
            name: "App.tsx",
            kind: "file",
            directoryPath: "/workspace/src",
            score: 10
          }
        ]
      }),
      queryAgentGeneratedFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues,
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] }),
      providerTimeoutMs: 20
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({ workspaceId: "room-1", query: "" });
    expect(states.at(-1)).toMatchObject({
      status: "loading",
      mode: "browse",
      query: ""
    });

    await vi.advanceTimersByTimeAsync(20);

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        query: "",
        mode: "browse",
        groups: expect.arrayContaining([
          expect.objectContaining({
            id: "files",
            items: [
              expect.objectContaining({
                kind: "file",
                path: "/workspace/src/App.tsx"
              })
            ]
          })
        ])
      })
    );
    expect(queryIssues).toHaveBeenCalledTimes(1);
  });

  it("uses rich text @ providers for workspace files, issues, and sessions when available", async () => {
    vi.useFakeTimers();
    const queryFiles = vi.fn();
    const queryIssues = vi.fn();
    const querySessions = vi.fn();
    const fileProviderQuery = vi.fn().mockResolvedValue([
      {
        label: "App.tsx",
        href: "/Users/test/project/tutti/src/App.tsx"
      }
    ]);
    const issueProviderQuery = vi.fn().mockResolvedValue([
      {
        issueId: "issue-1",
        title: "Fix mention search",
        status: "running"
      }
    ]);
    const sessionProviderQuery = vi.fn().mockResolvedValue([
      {
        agentName: "Codex",
        id: "session-1",
        initiatorName: "local",
        provider: "codex",
        status: "working",
        title: "Fix mention session provider",
        updatedAtUnixMs: 30,
        userId: "local",
        workspaceId: "room-1"
      }
    ]);
    const controller = new AgentMentionSearchController({
      queryFiles,
      queryIssues,
      querySessions,
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] }),
      contextMentionProviders: [
        {
          id: FILE_PROVIDER_ID,
          trigger: "@",
          query: fileProviderQuery,
          getItemKey: (item) => item.href,
          getItemLabel: (item) => item.label,
          toInsertResult: (item) => ({
            kind: "markdown-link",
            label: item.label,
            href: item.href
          })
        },
        {
          id: WORKSPACE_ISSUE_PROVIDER_ID,
          trigger: "@",
          query: issueProviderQuery,
          getItemKey: (item) => item.issueId,
          getItemLabel: (item) => item.title,
          getItemSubtitle: (item) => item.status,
          toInsertResult: (item) => ({
            kind: "mention",
            mention: {
              entityId: item.issueId,
              label: item.title,
              scope: { workspaceId: "room-1" },
              presentation: { status: item.status }
            }
          })
        },
        {
          id: AGENT_SESSION_PROVIDER_ID,
          trigger: "@",
          query: sessionProviderQuery,
          getItemKey: (item) => item.id,
          getItemLabel: (item) => item.title,
          getItemSubtitle: (item) => `${item.provider} · ${item.status}`,
          toInsertResult: (item) => ({
            kind: "mention",
            mention: {
              entityId: item.id,
              label: item.title,
              scope: {
                userId: item.userId,
                workspaceId: item.workspaceId
              },
              presentation: {
                status: item.status,
                subtitle: item.agentName
              }
            }
          })
        }
      ] satisfies [
        AgentContextMentionProvider<TestFileMentionItem>,
        AgentContextMentionProvider<TestIssueMentionItem>,
        AgentContextMentionProvider<TestSessionMentionItem>
      ],
      debounceMs: 20
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "local",
      query: "mention"
    });
    await vi.advanceTimersByTimeAsync(20);

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        groups: expect.arrayContaining([
          expect.objectContaining({
            id: "files",
            items: [
              expect.objectContaining({
                kind: "file",
                path: "/Users/test/project/tutti/src/App.tsx"
              })
            ]
          }),
          expect.objectContaining({
            id: "my_sessions",
            items: [
              expect.objectContaining({
                kind: "session",
                agentName: "Codex",
                initiatorName: "",
                name: "Fix mention session provider",
                scope: "my_sessions",
                targetId: "session-1"
              })
            ]
          }),
          expect.objectContaining({
            id: "issues",
            items: [
              expect.objectContaining({
                kind: "workspace-issue",
                targetId: "issue-1",
                status: "running"
              })
            ]
          })
        ])
      })
    );
    expect(queryFiles).not.toHaveBeenCalled();
    expect(queryIssues).not.toHaveBeenCalled();
    expect(querySessions).not.toHaveBeenCalled();
    expect(fileProviderQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "mention",
        maxResults: 30
      })
    );
    expect(issueProviderQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "mention",
        maxResults: 25
      })
    );
    expect(sessionProviderQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "mention",
        maxResults: 30
      })
    );
  });

  it("builds grouped issue and session results with parsed previews", async () => {
    vi.useFakeTimers();
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [
          {
            issueId: "issue-1",
            workspaceId: "room-1",
            title: "修复 room status",
            content: JSON.stringify({
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "补齐 statusBatch 的错误处理" }
                  ]
                }
              ]
            }),
            status: "running",
            creatorUserId: "user-2",
            creatorDisplayName: "Alice",
            issueCount: 0,
            notStartedCount: 0,
            runningCount: 0,
            pendingAcceptanceCount: 0,
            completedCount: 0,
            failedCount: 0,
            canceledCount: 0,
            updatedAtUnix: 20
          }
        ],
        totalCount: 1,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({
        presences: [],
        sessions: [
          {
            agentSessionId: "session-1",
            workspaceId: "room-1",
            userId: "user-1",
            provider: "codex",
            title: "看看项目有什么文件",
            effectiveStatus: "working",
            createdAtUnixMs: 1,
            updatedAtUnixMs: 10
          },
          {
            agentSessionId: "session-2",
            workspaceId: "room-1",
            userId: "user-2",
            provider: "nexight",
            title: "room status 接口整理",
            lifecycleStatus: "completed",
            createdAtUnixMs: 2,
            updatedAtUnixMs: 9
          }
        ]
      }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn().mockImplementation(({ agentSessionId }) =>
        Promise.resolve({
          workspaceId: "room-1",
          agentSessionId,
          executionStatus:
            agentSessionId === "session-1" ? "RUNNING" : "COMPLETED",
          latestUserRequirement:
            agentSessionId === "session-1"
              ? "看看项目有什么文件"
              : "整理 room status",
          recentAgentReplies:
            agentSessionId === "session-1"
              ? ["已读取 workspace 结构"]
              : ["输出了 statusBatch 调用链"],
          initialUserRequirement: "",
          initialTurn: null,
          latestTurn: null,
          recentTurns: []
        })
      ),
      loadUserProfiles: vi.fn().mockResolvedValue({
        users: [
          {
            userId: "user-1",
            name: "Wang",
            avatar: "https://cdn.example.com/wang.png"
          },
          {
            userId: "user-2",
            name: "Alice",
            avatar: "https://cdn.example.com/alice.png"
          }
        ]
      }),
      debounceMs: 20
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: "status"
    });

    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        groups: expect.arrayContaining([
          expect.objectContaining({
            id: "files",
            items: [],
            emptyLabel: "No matching files"
          }),
          expect.objectContaining({
            id: "issues",
            items: [
              expect.objectContaining({
                kind: "workspace-issue",
                targetId: "issue-1",
                contentPreview: "补齐 statusBatch 的错误处理"
              })
            ]
          })
        ])
      })
    );
  });

  it("resets the active filter when the picker closes", () => {
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn(),
      querySessions: vi.fn(),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn()
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({ workspaceId: "room-1", query: "" });
    controller.setFilter("issue");
    controller.close();

    expect(states.at(-1)).toMatchObject({
      status: "idle",
      mode: "browse",
      filter: "all"
    });
  });

  it("loads dock-backed file items when switching to the file tab without a keyword", async () => {
    const queryFiles = vi.fn().mockResolvedValue({
      workspaceId: "room-1",
      root: "/workspace",
      entries: [
        {
          path: "/workspace/README.md",
          name: "README.md",
          kind: "file"
        }
      ]
    });
    const queryAgentGeneratedFiles = vi.fn().mockResolvedValue({
      entries: [
        {
          path: "/workspace/output/report.md",
          name: "report.md"
        }
      ]
    });
    const controller = new AgentMentionSearchController({
      queryAgentGeneratedFiles,
      queryFiles,
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("file");

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "browse",
        query: "",
        filter: "file",
        groups: [
          {
            id: "opened_files",
            items: [
              expect.objectContaining({
                kind: "file",
                name: "README.md",
                path: "/workspace/README.md"
              })
            ]
          },
          {
            id: "agent_generated_files",
            items: [
              expect.objectContaining({
                kind: "file",
                name: "report.md",
                path: "/workspace/output/report.md"
              })
            ]
          }
        ]
      })
    );
    expect(queryFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "room-1",
        query: "",
        limit: 30
      })
    );
    expect(queryAgentGeneratedFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "room-1",
        query: "",
        limit: 30
      })
    );
  });

  it("groups agent-generated files by folder and supports folder drill-down", async () => {
    setAgentGuiI18nTestLocale("zh-CN");
    const queryAgentGeneratedFiles = vi.fn().mockResolvedValue({
      entries: [
        {
          path: "/workspace/demo/apps/11.md",
          name: "11.md"
        },
        {
          path: "/workspace/demo/static/app.js",
          name: "app.js"
        },
        {
          path: "/workspace/demo/static/index.html",
          name: "index.html"
        },
        {
          path: "/workspace/demo/static/styles.css",
          name: "styles.css"
        }
      ]
    });
    const controller = new AgentMentionSearchController({
      queryAgentGeneratedFiles,
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("file");

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        groups: [
          expect.objectContaining({ id: "opened_files" }),
          {
            id: "agent_generated_files",
            items: [
              expect.objectContaining({
                kind: "file",
                name: "11.md",
                path: "/workspace/demo/apps/11.md"
              }),
              expect.objectContaining({
                kind: "file",
                name: "static",
                path: "/workspace/demo/static",
                entryKind: "directory",
                mentionNavigation: "agent-generated-folder",
                childCount: 3
              })
            ],
            totalCount: 2,
            visibleCount: 2,
            hasMore: false
          }
        ]
      })
    );

    const latestState = states.at(-1) as {
      groups: Array<{
        id: string;
        items: Array<{ mentionNavigation?: string; path: string }>;
      }>;
    };
    const folderItem = latestState.groups
      .find((group) => group.id === "agent_generated_files")
      ?.items.find(
        (item) => item.mentionNavigation === "agent-generated-folder"
      );
    expect(folderItem).toBeDefined();
    controller.selectAgentGeneratedMentionItem(
      folderItem as Parameters<
        BaseAgentMentionSearchController["selectAgentGeneratedMentionItem"]
      >[0]
    );

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        groups: [
          expect.objectContaining({ id: "opened_files" }),
          {
            id: "agent_generated_files",
            items: [
              expect.objectContaining({
                mentionNavigation: "agent-generated-folder-back",
                name: "返回"
              }),
              expect.objectContaining({
                kind: "file",
                name: "app.js",
                path: "/workspace/demo/static/app.js"
              }),
              expect.objectContaining({
                kind: "file",
                name: "index.html",
                path: "/workspace/demo/static/index.html"
              }),
              expect.objectContaining({
                kind: "file",
                name: "styles.css",
                path: "/workspace/demo/static/styles.css"
              })
            ]
          }
        ]
      })
    );
    setAgentGuiI18nTestLocale("en");
  });

  it("loads default session items in browse mode when switching to the session tab", async () => {
    const querySessions = vi.fn().mockResolvedValue({
      presences: [],
      sessions: [
        {
          agentSessionId: "session-1",
          workspaceId: "room-1",
          userId: "user-1",
          provider: "codex",
          title: "@README.md 这是什么内容",
          createdAtUnixMs: 1,
          updatedAtUnixMs: 10
        }
      ]
    });
    const loadSessionSummary = vi.fn().mockResolvedValue({
      workspaceId: "room-1",
      agentSessionId: "session-1",
      executionStatus: "RUNNING",
      latestUserRequirement: "看看项目有什么文件",
      recentAgentReplies: ["已读取 workspace 结构"],
      initialUserRequirement: "",
      initialTurn: null,
      latestTurn: null,
      recentTurns: []
    });
    const loadSessionMessages = vi
      .fn()
      .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false });
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions,
      loadSessionMessages,
      loadSessionSummary,
      loadUserProfiles: vi.fn().mockResolvedValue({
        users: [{ userId: "user-1", name: "Wang" }]
      })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("session");

    expect(states.at(-1)).toMatchObject({
      status: "loading",
      mode: "browse",
      filter: "session",
      query: ""
    });

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "browse",
        filter: "session",
        groups: [
          {
            id: "my_sessions",
            items: [
              expect.objectContaining({
                kind: "session",
                targetId: "session-1",
                agentName: "Codex",
                name: "@README.md 这是什么内容",
                title: "README.md 这是什么内容"
              })
            ]
          }
        ]
      })
    );
    expect(querySessions).toHaveBeenLastCalledWith({
      workspaceId: "room-1",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    });
    expect(loadSessionSummary).toHaveBeenCalledWith({
      workspaceId: "room-1",
      agentSessionId: "session-1",
      agentReplyLimit: 1,
      recentTurnLimit: 1
    });
    expect(loadSessionMessages).not.toHaveBeenCalled();
  });

  it("queries runtime-origin sessions in browse mode when switching to the session tab", async () => {
    const querySessions = vi.fn().mockImplementation(async (input) => {
      if (
        typeof input !== "string" &&
        input.sessionOrigin === "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
      ) {
        return {
          presences: [],
          sessions: [
            {
              agentSessionId: "runtime-session-1",
              workspaceId: "room-1",
              userId: "user-1",
              provider: "codex",
              sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
              title: "分析open code 架构设计",
              createdAtUnixMs: 1,
              updatedAtUnixMs: 10
            }
          ]
        };
      }
      return { presences: [], sessions: [] };
    });
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions,
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        agentSessionId: "runtime-session-1",
        executionStatus: "RUNNING",
        latestUserRequirement: "分析open code 架构设计",
        recentAgentReplies: [],
        initialUserRequirement: "",
        initialTurn: null,
        latestTurn: null,
        recentTurns: []
      }),
      loadUserProfiles: vi.fn().mockResolvedValue({
        users: [{ userId: "user-1", name: "Wang" }]
      })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("session");

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "browse",
        filter: "session",
        groups: [
          {
            id: "my_sessions",
            items: [
              expect.objectContaining({
                kind: "session",
                targetId: "runtime-session-1",
                title: "分析open code 架构设计"
              })
            ]
          }
        ]
      })
    );
    expect(querySessions).toHaveBeenLastCalledWith({
      workspaceId: "room-1",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    });
  });

  it("uses session messages instead of timeline for missing runtime session titles", async () => {
    const loadSessionMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 1,
          messageId: "message-user-1",
          agentSessionId: "runtime-session-1",
          role: "user",
          kind: "text",
          payload: { text: "这个会话里面做了什么事情" },
          version: 1,
          occurredAtUnixMs: 10
        }
      ],
      latestVersion: 1,
      hasMore: false
    });
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({
        presences: [],
        sessions: [
          {
            agentSessionId: "runtime-session-1",
            workspaceId: "room-1",
            userId: "user-1",
            provider: "codex",
            sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
            title: "",
            createdAtUnixMs: 1,
            updatedAtUnixMs: 10
          }
        ]
      }),
      loadSessionMessages,
      loadSessionSummary: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        agentSessionId: "runtime-session-1",
        executionStatus: "RUNNING",
        latestUserRequirement: "",
        recentAgentReplies: [],
        initialUserRequirement: "",
        initialTurn: null,
        latestTurn: null,
        recentTurns: []
      }),
      loadUserProfiles: vi.fn().mockResolvedValue({
        users: [{ userId: "user-1", name: "Wang" }]
      })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("session");

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "browse",
        filter: "session",
        groups: [
          {
            id: "my_sessions",
            items: [
              expect.objectContaining({
                kind: "session",
                targetId: "runtime-session-1",
                title: "这个会话里面做了什么事情"
              })
            ]
          }
        ]
      })
    );
    expect(loadSessionMessages).toHaveBeenCalledWith({
      workspaceId: "room-1",

      agentSessionId: "runtime-session-1",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
      afterVersion: 0,
      limit: 20
    });
  });

  it("loads default issue items in browse mode when switching to the issue tab", async () => {
    const queryIssues = vi.fn().mockResolvedValue({
      issues: [
        {
          issueId: "issue-1",
          workspaceId: "room-1",
          title: "修复 room status",
          content: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "补齐 statusBatch 的错误处理" }]
              }
            ]
          }),
          status: "running",
          creatorUserId: "user-2",
          creatorDisplayName: "Alice",
          issueCount: 0,
          notStartedCount: 0,
          runningCount: 0,
          pendingAcceptanceCount: 0,
          completedCount: 0,
          failedCount: 0,
          canceledCount: 0,
          updatedAtUnix: 20
        }
      ],
      totalCount: 1,
      statusCounts: undefined
    });
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues,
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("issue");

    expect(states.at(-1)).toMatchObject({
      status: "loading",
      mode: "browse",
      filter: "issue",
      query: ""
    });

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "browse",
        filter: "issue",
        groups: [
          {
            id: "issues",
            items: [
              expect.objectContaining({
                kind: "workspace-issue",
                targetId: "issue-1",
                contentPreview: "补齐 statusBatch 的错误处理"
              })
            ]
          }
        ]
      })
    );
    expect(queryIssues).toHaveBeenLastCalledWith({
      workspaceId: "room-1",
      pageSize: 25,
      searchQuery: ""
    });
  });

  it("loads grouped browse overview for the all tab without a query", async () => {
    const queryIssues = vi.fn().mockResolvedValue({
      issues: [
        {
          issueId: "issue-1",
          workspaceId: "room-1",
          title: "修复 room status",
          content: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "补齐 statusBatch 的错误处理" }]
              }
            ]
          }),
          status: "running",
          creatorUserId: "user-2",
          creatorDisplayName: "Alice",
          issueCount: 0,
          notStartedCount: 0,
          runningCount: 0,
          pendingAcceptanceCount: 0,
          completedCount: 0,
          failedCount: 0,
          canceledCount: 0,
          updatedAtUnix: 20
        }
      ],
      totalCount: 1,
      statusCounts: undefined
    });
    const querySessions = vi.fn().mockResolvedValue({
      presences: [],
      sessions: [
        {
          agentSessionId: "session-1",
          workspaceId: "room-1",
          userId: "user-1",
          provider: "codex",
          title: "看看项目有什么文件",
          createdAtUnixMs: 1,
          updatedAtUnixMs: 10
        },
        {
          agentSessionId: "session-2",
          workspaceId: "room-1",
          userId: "user-2",
          provider: "nexight",
          title: "room status 接口整理",
          createdAtUnixMs: 2,
          updatedAtUnixMs: 9
        }
      ]
    });
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues,
      querySessions,
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn().mockImplementation(({ agentSessionId }) =>
        Promise.resolve({
          workspaceId: "room-1",
          agentSessionId,
          executionStatus:
            agentSessionId === "session-1" ? "RUNNING" : "COMPLETED",
          latestUserRequirement:
            agentSessionId === "session-1"
              ? "看看项目有什么文件"
              : "整理 room status",
          recentAgentReplies:
            agentSessionId === "session-1"
              ? ["已读取 workspace 结构"]
              : ["输出了 statusBatch 调用链"],
          initialUserRequirement: "",
          initialTurn: null,
          latestTurn: null,
          recentTurns: []
        })
      ),
      loadUserProfiles: vi.fn().mockResolvedValue({
        users: [
          { userId: "user-1", name: "Wang" },
          { userId: "user-2", name: "Alice" }
        ]
      })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("all");

    expect(states.at(-1)).toMatchObject({
      status: "loading",
      mode: "browse",
      filter: "all",
      query: ""
    });

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "browse",
        filter: "all",
        groups: expect.arrayContaining([
          expect.objectContaining({
            id: "files",
            items: [],
            emptyLabel:
              "No open files in the dock yet. Type to search workspace files."
          }),
          expect.objectContaining({
            id: "my_sessions",
            items: [
              expect.objectContaining({
                targetId: "session-1",
                kind: "session"
              })
            ]
          }),
          expect.objectContaining({
            id: "issues",
            items: [
              expect.objectContaining({
                targetId: "issue-1",
                kind: "workspace-issue"
              })
            ]
          })
        ])
      })
    );

    expect(querySessions).toHaveBeenCalledWith({
      workspaceId: "room-1",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME"
    });
    expect(queryIssues).toHaveBeenCalledWith({
      workspaceId: "room-1",
      pageSize: 25,
      searchQuery: ""
    });
    expect(
      (
        states.at(-1) as {
          groups: Array<{ id: string }>;
        }
      ).groups.map((group) => group.id)
    ).toEqual(["my_sessions", "issues", "files", "apps"]);
  });

  it("keeps non-file groups visible with empty labels in the all tab browse state", async () => {
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("all");

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "browse",
        filter: "all",
        groups: [
          { id: "my_sessions", items: [], emptyLabel: "No sessions yet" },
          {
            id: "files",
            items: [],
            emptyLabel:
              "No open files in the dock yet. Type to search workspace files."
          },
          { id: "issues", items: [], emptyLabel: "No tasks yet" },
          {
            id: "apps",
            items: [],
            emptyLabel: "No apps yet"
          }
        ]
      })
    );
  });

  it("omits empty file subgroups while searching on the file tab when another subgroup has matches", async () => {
    vi.useFakeTimers();
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: [
          {
            path: "/workspace/quickPhrases.ts",
            name: "quickPhrases.ts",
            kind: "file"
          }
        ]
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] }),
      debounceMs: 20
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("file");

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "browse",
        filter: "file"
      })
    );

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: "quick"
    });

    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "results",
        filter: "file",
        groups: [
          {
            id: "opened_files",
            items: [
              expect.objectContaining({
                kind: "file",
                name: "quickPhrases.ts",
                path: "/workspace/quickPhrases.ts"
              })
            ]
          }
        ]
      })
    );
    expect(
      (states.at(-1) as { groups: Array<{ id: string }> }).groups.some(
        (group) => group.id === "agent_generated_files"
      )
    ).toBe(false);
    vi.useRealTimers();
  });

  it("orders matching app groups ahead of weaker session and file matches in all results", async () => {
    vi.useFakeTimers();
    const controller = new AgentMentionSearchController({
      contextMentionProviders: [
        {
          id: FILE_PROVIDER_ID,
          trigger: "@",
          query: vi.fn().mockResolvedValue([
            {
              label: "automation.md",
              href: "/workspace/docs/automation.md"
            }
          ]),
          getItemKey: (item) => item.href,
          getItemLabel: (item) => item.label,
          toInsertResult: (item) => ({
            kind: "markdown-link",
            label: item.label,
            href: item.href
          })
        },
        {
          id: WORKSPACE_APP_PROVIDER_ID,
          trigger: "@",
          query: vi.fn().mockResolvedValue([
            {
              appId: "automation",
              name: "Automation"
            }
          ]),
          getItemKey: (item) => item.appId,
          getItemLabel: (item) => item.name,
          toInsertResult: (item) => ({
            kind: "mention",
            mention: {
              entityId: item.appId,
              label: item.name,
              scope: { workspaceId: "room-1" }
            }
          })
        },
        {
          id: AGENT_SESSION_PROVIDER_ID,
          trigger: "@",
          query: vi.fn().mockResolvedValue([
            {
              agentName: "Codex",
              id: "session-automation",
              initiatorName: "local",
              provider: "codex",
              status: "completed",
              title: "Automation cleanup",
              updatedAtUnixMs: 30,
              userId: "local",
              workspaceId: "room-1"
            }
          ]),
          getItemKey: (item) => item.id,
          getItemLabel: (item) => item.title,
          toInsertResult: (item) => ({
            kind: "mention",
            mention: {
              entityId: item.id,
              label: item.title,
              scope: {
                scope: "my_sessions",
                userId: item.userId,
                workspaceId: item.workspaceId
              },
              presentation: {
                subtitle: item.agentName
              }
            }
          })
        }
      ],
      debounceMs: 20
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "local",
      query: "automation"
    });
    await vi.advanceTimersByTimeAsync(20);

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "results",
        filter: "all",
        groups: [
          expect.objectContaining({ id: "apps" }),
          expect.objectContaining({ id: "my_sessions" }),
          expect.objectContaining({ id: "files" }),
          expect.objectContaining({ id: "issues" })
        ]
      })
    );
    vi.useRealTimers();
  });

  it("shows an empty file group only after a search query produces no file matches", async () => {
    vi.useFakeTimers();
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] }),
      debounceMs: 20
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: "readme"
    });

    await vi.advanceTimersByTimeAsync(20);
    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "results",
        filter: "all",
        groups: [
          { id: "my_sessions", items: [], emptyLabel: "No sessions yet" },
          {
            id: "files",
            items: [],
            emptyLabel: "No matching files"
          },
          { id: "issues", items: [], emptyLabel: "No tasks yet" },
          {
            id: "apps",
            items: [],
            emptyLabel: "No apps yet"
          }
        ]
      })
    );
  });

  it("switches from browse overview into the matching tab when expanding a group", async () => {
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: Array.from({ length: 8 }, (_, index) => ({
          issueId: `issue-${index + 1}`,
          workspaceId: "room-1",
          title: `Issue ${index + 1}`,
          content: "",
          status: "running",
          creatorUserId: "user-2",
          creatorDisplayName: "Alice",
          issueCount: 0,
          notStartedCount: 0,
          runningCount: 0,
          pendingAcceptanceCount: 0,
          completedCount: 0,
          failedCount: 0,
          canceledCount: 0,
          updatedAtUnix: 20 + index
        })),
        totalCount: 8,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({ presences: [], sessions: [] }),
      loadSessionMessages: vi
        .fn()
        .mockResolvedValue({ messages: [], latestVersion: 0, hasMore: false }),
      loadSessionSummary: vi.fn(),
      loadUserProfiles: vi.fn().mockResolvedValue({ users: [] })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("all");

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        mode: "browse",
        filter: "all",
        groups: expect.arrayContaining([
          expect.objectContaining({
            id: "my_sessions",
            items: [],
            emptyLabel: "No sessions yet"
          }),
          expect.objectContaining({
            id: "issues",
            visibleCount: 5,
            hasMore: true
          })
        ])
      })
    );

    controller.expandGroup("issues");

    expect(states.at(-1)).toMatchObject({
      status: "ready",
      mode: "browse",
      filter: "issue",
      groups: [
        {
          id: "issues",
          visibleCount: 8,
          hasMore: false
        }
      ]
    });
  });

  it("falls back to the first user message when session title and summary are empty", async () => {
    const loadSessionMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 1,
          messageId: "message-user-1",
          agentSessionId: "session-1",
          role: "user",
          kind: "text",
          payload: { text: "hi" },
          version: 1,
          occurredAtUnixMs: 10
        }
      ],
      latestVersion: 1,
      hasMore: false
    });
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({
        presences: [],
        sessions: [
          {
            agentSessionId: "session-1",
            workspaceId: "room-1",
            userId: "user-1",
            provider: "codex",
            title: "",
            createdAtUnixMs: 1,
            updatedAtUnixMs: 10
          }
        ]
      }),
      loadSessionMessages,
      loadSessionSummary: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        executionStatus: "COMPLETED",
        latestUserRequirement: "",
        recentAgentReplies: [],
        initialUserRequirement: "",
        initialTurn: null,
        latestTurn: null,
        recentTurns: []
      }),
      loadUserProfiles: vi.fn().mockResolvedValue({
        users: [{ userId: "user-1", name: "Wang" }]
      })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("session");

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        groups: [
          {
            id: "my_sessions",
            items: [
              expect.objectContaining({
                kind: "session",
                targetId: "session-1",
                agentName: "Codex",
                name: "hi"
              })
            ]
          }
        ]
      })
    );
    expect(loadSessionMessages).toHaveBeenCalledWith({
      workspaceId: "room-1",

      agentSessionId: "session-1",
      afterVersion: 0,
      limit: 20
    });
  });

  it("falls back to the first user message when the session title is missing", async () => {
    const loadSessionMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          id: 1,
          messageId: "message-user-1",
          agentSessionId: "session-1",
          role: "user",
          kind: "text",
          payload: { text: "如何做excel的数据清理" },
          version: 1,
          occurredAtUnixMs: 10
        }
      ],
      latestVersion: 1,
      hasMore: false
    });
    const controller = new AgentMentionSearchController({
      queryFiles: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        root: "/workspace",
        entries: []
      }),
      queryIssues: vi.fn().mockResolvedValue({
        issues: [],
        totalCount: 0,
        statusCounts: undefined
      }),
      querySessions: vi.fn().mockResolvedValue({
        presences: [],
        sessions: [
          {
            agentSessionId: "session-1",
            workspaceId: "room-1",
            userId: "user-1",
            provider: "codex",
            sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
            title: "",
            createdAtUnixMs: 1,
            updatedAtUnixMs: 10
          }
        ]
      }),
      loadSessionMessages,
      loadSessionSummary: vi.fn().mockResolvedValue({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        executionStatus: "COMPLETED",
        latestUserRequirement: "",
        recentAgentReplies: [],
        initialUserRequirement: "",
        initialTurn: null,
        latestTurn: null,
        recentTurns: []
      }),
      loadUserProfiles: vi.fn().mockResolvedValue({
        users: [{ userId: "user-1", name: "Wang" }]
      })
    });
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    controller.updateQuery({
      workspaceId: "room-1",
      currentUserId: "user-1",
      query: ""
    });
    controller.setFilter("session");

    await vi.waitFor(() =>
      expect(states.at(-1)).toMatchObject({
        status: "ready",
        query: "",
        groups: [
          {
            id: "my_sessions",
            items: [
              expect.objectContaining({
                kind: "session",
                targetId: "session-1",
                agentName: "Codex",
                name: "如何做excel的数据清理",
                title: "如何做excel的数据清理"
              })
            ]
          }
        ]
      })
    );
    expect(loadSessionMessages).toHaveBeenCalledWith({
      workspaceId: "room-1",

      agentSessionId: "session-1",
      sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
      afterVersion: 0,
      limit: 20
    });
  });
});
