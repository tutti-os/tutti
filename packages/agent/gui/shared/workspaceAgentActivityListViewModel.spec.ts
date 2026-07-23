import { setAgentGuiI18nTestLocale } from "../i18n/testUtils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentHostUserInfo } from "./contracts/dto";
import {
  normalizeAgentActivitySession,
  type AgentActivitySessionInput,
  type AgentActivityMessage,
  type AgentActivitySession
} from "@tutti-os/agent-activity-core";
import {
  buildWorkspaceAgentActivityListViewModel as buildCanonicalWorkspaceAgentActivityListViewModel,
  reuseWorkspaceAgentActivityListViewModelIfUnchanged,
  type WorkspaceAgentActivityCard
} from "./workspaceAgentActivityListViewModel";
import { collectWorkspaceAgentGeneratedFiles } from "./workspaceAgentGeneratedFiles";

type TestAgentActivitySessionInput = Omit<
  AgentActivitySessionInput,
  "activeTurnId" | "latestTurnInteractions" | "pendingInteractions"
> &
  Partial<
    Pick<
      AgentActivitySessionInput,
      "activeTurnId" | "latestTurnInteractions" | "pendingInteractions"
    >
  >;

function canonicalSource<
  Source extends { sessions: readonly TestAgentActivitySessionInput[] }
>(
  source: Source
): Omit<Source, "sessions"> & { sessions: AgentActivitySession[] } {
  return {
    ...source,
    sessions: source.sessions.map((session) =>
      normalizeAgentActivitySession({
        activeTurnId: null,
        latestTurnInteractions: [],
        pendingInteractions: [],
        ...session
      })
    )
  };
}

function buildWorkspaceAgentActivityListViewModel(
  snapshot: {
    presences: readonly Record<string, unknown>[];
    sessions: readonly Record<string, unknown>[];
  },
  options?: Parameters<
    typeof buildCanonicalWorkspaceAgentActivityListViewModel
  >[1]
) {
  const presenceById = new Map(
    snapshot.presences.map((item) => [item.id, item])
  );
  const sessions = snapshot.sessions.map((raw) => {
    const presence = presenceById.get(raw.presenceId);
    const agentSessionId = String(
      raw.agentSessionId ?? raw.sessionId ?? raw.id ?? "session"
    );
    const status = String(
      raw.effectiveStatus ?? raw.status ?? raw.turnPhase ?? "unknown"
    );
    const turn = {
      agentSessionId,
      phase: status === "working" || status === "waiting" ? status : "settled",
      startedAtUnixMs: 0,
      turnId: `turn:${agentSessionId}`,
      updatedAtUnixMs: Number(raw.updatedAtUnixMs ?? 0)
    } as const;
    return {
      ...raw,
      agentSessionId,
      workspaceId: String(raw.workspaceId ?? "workspace-1"),
      provider: String(raw.provider ?? ""),
      cwd: String(raw.cwd ?? ""),
      title: String(raw.title ?? ""),
      ...(status === "working" || status === "waiting"
        ? { activeTurn: turn, activeTurnId: turn.turnId }
        : ["completed", "failed", "canceled"].includes(status)
          ? { latestTurn: { ...turn, outcome: status } }
          : {}),
      userId: raw.userId ?? presence?.userId ?? ""
    } as unknown as AgentActivitySession;
  });
  return buildCanonicalWorkspaceAgentActivityListViewModel(
    {
      presences: snapshot.presences.map((raw, index) => ({
        id: (raw.id as string | number | undefined) ?? index,
        workspaceId: String(raw.workspaceId ?? "workspace-1"),
        provider: String(raw.provider ?? ""),
        status: String(raw.status ?? "unknown"),
        userId: typeof raw.userId === "string" ? raw.userId : null
      })),
      sessions
    },
    options
  );
}

type WorkspaceAgentMessageFixture = Partial<AgentActivityMessage> & {
  id: number;
  agentSessionId?: string;
  content?: string;
  itemType?: string;
  eventId?: string;
  actorType?: string;
  actorId?: string;
  callType?: string;
  callId?: string;
  name?: string;
  createdAtUnixMs?: number;
};

function callItem(
  overrides: WorkspaceAgentMessageFixture
): AgentActivityMessage {
  const { id, agentSessionId = "session-10", ...rest } = overrides;
  const payload = rest.payload ?? {};
  return {
    agentSessionId,
    messageId: rest.messageId ?? rest.eventId ?? `call-${id}`,
    version: rest.version ?? id,
    turnId: rest.turnId ?? `turn-${id}`,
    role: rest.role ?? "assistant",
    kind: rest.kind ?? "tool_call",
    status: "running",
    payload: {
      ...payload,
      content: payload.content ?? rest.content,
      text: payload.text ?? rest.content,
      callType: rest.callType ?? "tool",
      callId: rest.callId,
      name: rest.name ?? "exec_command"
    },
    occurredAtUnixMs: rest.occurredAtUnixMs ?? rest.createdAtUnixMs ?? id,
    startedAtUnixMs: rest.startedAtUnixMs ?? rest.createdAtUnixMs,
    completedAtUnixMs: rest.completedAtUnixMs ?? rest.occurredAtUnixMs,
    ...rest
  };
}

function messageItem(
  overrides: WorkspaceAgentMessageFixture
): AgentActivityMessage {
  const { id, agentSessionId = "session-10", ...rest } = overrides;
  const payload = rest.payload ?? {};
  return {
    agentSessionId,
    messageId: rest.messageId ?? rest.eventId ?? `message-${id}`,
    version: rest.version ?? id,
    turnId: rest.turnId ?? `turn-${id}`,
    role: "user",
    kind: rest.kind ?? rest.itemType ?? "message",
    payload: {
      ...payload,
      content: payload.content ?? rest.content,
      text: payload.text ?? rest.content
    },
    occurredAtUnixMs: rest.occurredAtUnixMs ?? rest.createdAtUnixMs ?? id,
    startedAtUnixMs: rest.startedAtUnixMs ?? rest.createdAtUnixMs,
    completedAtUnixMs: rest.completedAtUnixMs ?? rest.occurredAtUnixMs,
    ...rest
  };
}

function createActivityCard(
  overrides: Partial<WorkspaceAgentActivityCard>
): WorkspaceAgentActivityCard {
  return {
    id: "activity-session-1",
    sessionId: "session-1",
    userId: "user-a",
    userName: "Jessica",
    userAvatarUrl: "https://cdn.example.com/jessica.png",
    agentProvider: "codex",
    agentName: "Codex",
    title: "Analyze architecture",
    status: "working",
    latestActivitySummary: "Running",
    latestActivityActorName: "Codex",
    changedFiles: [],
    sortTimeUnixMs: 1_000,
    ...overrides
  };
}

describe("buildWorkspaceAgentActivityListViewModel", () => {
  beforeEach(() => {
    setAgentGuiI18nTestLocale("zh-CN");
  });

  afterEach(() => {
    setAgentGuiI18nTestLocale("en");
  });

  it("reuses the previous activity list view when rebuilt activities are unchanged", () => {
    const firstActivity = createActivityCard({
      id: "activity-session-1",
      sessionId: "session-1",
      latestActivitySummary: "Reading files"
    });
    const secondActivity = createActivityCard({
      id: "activity-session-2",
      sessionId: "session-2",
      latestActivitySummary: "Running tests"
    });
    const previous = { activities: [firstActivity, secondActivity] };
    const rebuilt = {
      activities: [
        createActivityCard({
          id: "activity-session-1",
          sessionId: "session-1",
          latestActivitySummary: "Reading files"
        }),
        createActivityCard({
          id: "activity-session-2",
          sessionId: "session-2",
          latestActivitySummary: "Running tests"
        })
      ]
    };

    expect(
      reuseWorkspaceAgentActivityListViewModelIfUnchanged(previous, rebuilt)
    ).toBe(previous);
  });

  it("reuses unchanged activity card references when one rebuilt activity changes", () => {
    const unchangedActivity = createActivityCard({
      id: "activity-session-1",
      sessionId: "session-1",
      latestActivitySummary: "Reading files"
    });
    const changedActivity = createActivityCard({
      id: "activity-session-2",
      sessionId: "session-2",
      latestActivitySummary: "Running tests"
    });
    const previous = { activities: [unchangedActivity, changedActivity] };
    const rebuiltChangedActivity = createActivityCard({
      id: "activity-session-2",
      sessionId: "session-2",
      latestActivitySummary: "Tests passed"
    });
    const rebuilt = {
      activities: [
        createActivityCard({
          id: "activity-session-1",
          sessionId: "session-1",
          latestActivitySummary: "Reading files"
        }),
        rebuiltChangedActivity
      ]
    };

    const reused = reuseWorkspaceAgentActivityListViewModelIfUnchanged(
      previous,
      rebuilt
    );

    expect(reused).not.toBe(previous);
    expect(reused.activities[0]).toBe(unchangedActivity);
    expect(reused.activities[1]).toBe(rebuiltChangedActivity);
  });

  it("keeps rebuilt activity order while reusing unchanged card references", () => {
    const firstActivity = createActivityCard({
      id: "activity-session-1",
      sessionId: "session-1",
      latestActivitySummary: "Reading files",
      sortTimeUnixMs: 1_000
    });
    const secondActivity = createActivityCard({
      id: "activity-session-2",
      sessionId: "session-2",
      latestActivitySummary: "Running tests",
      sortTimeUnixMs: 900
    });
    const previous = { activities: [firstActivity, secondActivity] };
    const rebuiltFirstActivity = createActivityCard({
      id: "activity-session-1",
      sessionId: "session-1",
      latestActivitySummary: "Reading files",
      sortTimeUnixMs: 1_000
    });
    const rebuiltSecondActivity = createActivityCard({
      id: "activity-session-2",
      sessionId: "session-2",
      latestActivitySummary: "Tests still running",
      sortTimeUnixMs: 1_200
    });
    const rebuilt = {
      activities: [rebuiltSecondActivity, rebuiltFirstActivity]
    };

    const reused = reuseWorkspaceAgentActivityListViewModelIfUnchanged(
      previous,
      rebuilt
    );

    expect(reused.activities.map((activity) => activity.sessionId)).toEqual([
      "session-2",
      "session-1"
    ]);
    expect(reused.activities[0]).toBe(rebuiltSecondActivity);
    expect(reused.activities[1]).toBe(firstActivity);
  });

  it("reuses unchanged activity card references when activities are added", () => {
    const firstActivity = createActivityCard({
      id: "activity-session-1",
      sessionId: "session-1",
      latestActivitySummary: "Reading files"
    });
    const secondActivity = createActivityCard({
      id: "activity-session-2",
      sessionId: "session-2",
      latestActivitySummary: "Running tests"
    });
    const previous = { activities: [firstActivity, secondActivity] };
    const newActivity = createActivityCard({
      id: "activity-session-3",
      sessionId: "session-3",
      latestActivitySummary: "New session",
      sortTimeUnixMs: 1_300
    });
    const rebuilt = {
      activities: [
        newActivity,
        createActivityCard({
          id: "activity-session-2",
          sessionId: "session-2",
          latestActivitySummary: "Running tests"
        }),
        createActivityCard({
          id: "activity-session-1",
          sessionId: "session-1",
          latestActivitySummary: "Reading files"
        })
      ]
    };

    const reused = reuseWorkspaceAgentActivityListViewModelIfUnchanged(
      previous,
      rebuilt
    );

    expect(reused.activities.map((activity) => activity.sessionId)).toEqual([
      "session-3",
      "session-2",
      "session-1"
    ]);
    expect(reused.activities[0]).toBe(newActivity);
    expect(reused.activities[1]).toBe(secondActivity);
    expect(reused.activities[2]).toBe(firstActivity);
  });

  it("builds one flat card per agent session without group data", () => {
    const snapshot = {
      presences: [
        {
          id: 1,
          workspaceId: "ws-1",
          userId: "user-a",
          provider: "codex",
          status: "working"
        }
      ],
      sessions: [
        {
          id: 10,
          agentSessionId: "session-10",
          presenceId: 1,
          provider: "codex",
          providerSessionId: "provider-10",
          cwd: "/repo",
          status: "working",
          updatedAtUnixMs: 2000,
          createdAtUnixMs: 2000,
          title: "帮我根据目前工作区的 Landing 页面信息出交互原型"
        },
        {
          id: 11,
          agentSessionId: "session-11",
          presenceId: 1,
          provider: "codex",
          providerSessionId: "provider-11",
          cwd: "/repo",
          status: "idle",
          updatedAtUnixMs: 1000,
          createdAtUnixMs: 1000,
          title: "Review room shell"
        }
      ]
    };
    const userProfilesById: Record<string, AgentHostUserInfo> = {
      "user-a": {
        userId: "user-a",
        name: "Jessica",
        assetUrl:
          "https://assets.tutti.sh/v1/assets/user-a/account_avatar/jessica.png",
        email: "jessica@example.com"
      }
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      userProfilesById,
      sessionMessagesById: {
        "session-10": [
          callItem({
            id: 1,
            name: "read_design_doc",
            content: "正在读取 Landing 信息设计文档与设计系统",
            status: "completed"
          })
        ]
      }
    });

    expect(view.activities).toHaveLength(2);
    expect(view.activities[0]).toMatchObject({
      id: "activity-session-10",
      sessionId: "session-10",
      userId: "user-a",
      userName: "Jessica",
      userAvatarUrl:
        "https://assets.tutti.sh/v1/assets/user-a/account_avatar/jessica.png?width=32&height=32&fit=cover&format=webp",
      agentProvider: "codex",
      agentName: "Codex",
      title: "帮我根据目前工作区的 Landing 页面信息出交互原型",
      status: "working",
      latestActivitySummary: "运行中",
      changedFiles: []
    });
    expect(view.activities[1]).toMatchObject({
      sessionId: "session-11",
      status: "idle",
      latestActivitySummary: "已完成"
    });
  });

  it("uses the canonical session id when building activity summaries", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 10,
          agentSessionId: "local-session-10",
          presenceId: 1,
          provider: "codex",
          providerSessionId: "provider-10",
          cwd: "/repo",
          effectiveStatus: "completed",
          title: "请分析 open code 架构设计",
          updatedAtUnixMs: 2000,
          createdAtUnixMs: 2000
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "local-session-10": [
          messageItem({
            id: 1,
            agentSessionId: "local-session-10",
            content: "请分析 open code 架构设计"
          })
        ]
      }
    });

    expect(view.activities[0]).toMatchObject({
      sessionId: "local-session-10",
      title: "请分析 open code 架构设计",
      latestActivitySummary: "请分析 open code 架构设计"
    });
  });

  it("prefers displayPrompt for activity titles and latest summaries", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 10,
          agentSessionId: "session-10",
          presenceId: 1,
          provider: "codex",
          providerSessionId: "provider-10",
          cwd: "/repo",
          status: "working",
          updatedAtUnixMs: 2000,
          createdAtUnixMs: 2000,
          title: "Run Automation"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-10": [
          messageItem({
            id: 1,
            content: "long automation prompt",
            payload: {
              displayPrompt: "Run Automation",
              text: "long automation prompt",
              content: "long automation prompt"
            }
          })
        ]
      }
    });

    expect(view.activities[0]).toMatchObject({
      title: "Run Automation",
      latestActivitySummary: "Run Automation"
    });
  });

  it("treats resumed active sessions without a running turn as idle", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 12,
          agentSessionId: "session-active",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-active",
          cwd: "/repo",
          lifecycleStatus: "active",
          turnPhase: "idle",
          effectiveStatus: "active",
          title: "Finished current turn"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities[0]).toMatchObject({
      sessionId: "session-active",
      status: "idle"
    });
  });

  it("hides empty runtime sessions that only have the provider default title and no timeline", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 12,
          agentSessionId: "session-empty-runtime",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-empty-runtime",
          sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
          cwd: "/repo",
          lifecycleStatus: "active",
          turnPhase: "idle",
          effectiveStatus: "idle",
          title: "Codex",
          updatedAtUnixMs: 2000,
          createdAtUnixMs: 2000
        },
        {
          id: 13,
          agentSessionId: "session-real-runtime",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-real-runtime",
          sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_RUNTIME",
          cwd: "/repo",
          lifecycleStatus: "completed",
          effectiveStatus: "completed",
          title: "Analyze architecture",
          updatedAtUnixMs: 1000,
          createdAtUnixMs: 1000
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-empty-runtime": []
      }
    });

    expect(view.activities.map((activity) => activity.sessionId)).toEqual([
      "session-real-runtime"
    ]);
  });

  it("hides empty core-native runtime sessions that omit legacy sessionOrigin", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 12,
          agentSessionId: "session-empty-runtime",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-empty-runtime",
          cwd: "/repo",
          lifecycleStatus: "active",
          turnPhase: "idle",
          effectiveStatus: "idle",
          title: "Codex",
          updatedAtUnixMs: 2000,
          createdAtUnixMs: 2000
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-empty-runtime": []
      }
    });

    expect(view.activities).toEqual([]);
  });

  it("prefers the explicit session status over the derived effective status", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 13,
          agentSessionId: "session-explicit-running",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-explicit-running",
          cwd: "/repo",
          status: "working",
          title: "Run still active"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities[0]).toMatchObject({
      sessionId: "session-explicit-running",
      status: "working"
    });
  });

  it("maps canonical working sessions to working", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 14,
          agentSessionId: "session-running-turn",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-running-turn",
          cwd: "/repo",
          status: "working",
          title: "Running current turn"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities[0]).toMatchObject({
      sessionId: "session-running-turn",
      status: "working"
    });
  });

  it("keeps lifecycle status when pending approval messages need user action", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 19,
          agentSessionId: "session-approval",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-approval",
          cwd: "/repo",
          status: "working",
          title: "Approve command"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "provider-approval": [
          callItem({
            id: 1,
            agentSessionId: "provider-approval",
            callType: "approval",
            name: "Approval",
            status: "waiting_approval",
            payload: {
              callType: "approval",
              name: "Approval",
              status: "waiting_approval",
              input: {
                requestId: "permission-1",
                options: [
                  {
                    optionId: "allow_once",
                    label: "Allow once",
                    kind: "allow_once"
                  }
                ]
              }
            }
          })
        ]
      }
    });

    expect(view.activities[0]).toMatchObject({
      sessionId: "session-approval",
      status: "working"
    });
  });

  it("treats passive active session updates as idle", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 13,
          agentSessionId: "session-passive-update",
          presenceId: 0,
          provider: "nexight",
          providerSessionId: "provider-passive-update",
          cwd: "/repo",
          lifecycleStatus: "active",
          turnPhase: "updated",
          effectiveStatus: "active",
          title: "Finished current turn"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities[0]).toMatchObject({
      sessionId: "session-passive-update",
      status: "idle"
    });
  });

  it("derives waiting from turn phase when session status still lags as idle", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 16,
          agentSessionId: "session-turn-waiting",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-turn-waiting",
          cwd: "/repo",
          lifecycleStatus: "active",
          turnPhase: "waiting_approval",
          effectiveStatus: "idle",
          activeTurn: {
            agentSessionId: "session-turn-waiting",
            phase: "waiting",
            startedAtUnixMs: 1,
            turnId: "turn-waiting",
            updatedAtUnixMs: 2
          },
          title: "Server says idle"
        },
        {
          id: 17,
          agentSessionId: "session-turn-input",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-turn-input",
          cwd: "/repo",
          lifecycleStatus: "active",
          turnPhase: "waiting_input",
          effectiveStatus: "idle",
          activeTurn: {
            agentSessionId: "session-turn-input",
            phase: "waiting",
            startedAtUnixMs: 1,
            turnId: "turn-input",
            updatedAtUnixMs: 2
          },
          title: "Needs input"
        },
        {
          id: 18,
          agentSessionId: "session-turn-failed",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-turn-failed",
          cwd: "/repo",
          lifecycleStatus: "active",
          turnPhase: "failed",
          effectiveStatus: "idle",
          title: "Recoverable failed turn"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(
      Object.fromEntries(
        view.activities.map((activity) => [activity.sessionId, activity.status])
      )
    ).toEqual({
      "session-turn-waiting": "waiting",
      "session-turn-input": "waiting",
      "session-turn-failed": "idle"
    });
  });

  it("does not derive outer working status from messages sharing a turn id", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 15,
          agentSessionId: "session-unclosed-turn",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-unclosed-turn",
          cwd: "/repo",
          lifecycleStatus: "active",
          turnPhase: "completed",
          effectiveStatus: "idle",
          title: "Analyze architecture"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-unclosed-turn": [
          messageItem({
            id: 1,
            agentSessionId: "session-unclosed-turn",
            turnId: "turn-1",
            role: "user",
            content: "Analyze architecture"
          }),
          messageItem({
            id: 2,
            agentSessionId: "session-unclosed-turn",
            turnId: "turn-1",
            role: "assistant",
            actorType: "agent",
            actorId: "session-unclosed-turn",
            itemType: "message.assistant",
            content: "正在分析架构"
          }),
          callItem({
            id: 3,
            agentSessionId: "session-unclosed-turn",
            turnId: "turn-1",
            status: "completed"
          })
        ]
      }
    });

    expect(view.activities[0]).toMatchObject({
      sessionId: "session-unclosed-turn",
      status: "idle",
      latestActivitySummary: "正在分析架构"
    });
  });

  it("uses the canonical session title without consulting user messages", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 18,
          agentSessionId: "session-placeholder-title",
          presenceId: 0,
          provider: "nexight",
          providerSessionId: "nexight-placeholder-title",
          cwd: "/repo",
          lifecycleStatus: "active",
          status: "working",
          title: "创建一个 txt 文件"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-placeholder-title": [
          messageItem({
            id: 1,
            agentSessionId: "session-placeholder-title",
            itemType: "message.user",
            payload: {
              text: "创建一个 txt 文件"
            }
          })
        ]
      }
    });

    expect(view.activities[0]).toMatchObject({
      sessionId: "session-placeholder-title",
      title: "创建一个 txt 文件"
    });
  });

  it("keeps the canonical title when synthetic messages are present", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 19,
          agentSessionId: "session-claude-interrupt",
          presenceId: 0,
          provider: "claude-code",
          providerSessionId: "claude-interrupt",
          cwd: "/repo",
          lifecycleStatus: "active",
          status: "working",
          title: "继续正常请求"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-claude-interrupt": [
          messageItem({
            id: 1,
            agentSessionId: "session-claude-interrupt",
            itemType: "message.user",
            payload: {
              text: "[Request interrupted by user]"
            }
          }),
          messageItem({
            id: 3,
            agentSessionId: "session-claude-interrupt",
            itemType: "message.user",
            payload: {
              text: "[Request interrupted by user for tool use]"
            }
          }),
          messageItem({
            id: 2,
            agentSessionId: "session-claude-interrupt",
            itemType: "message.user",
            payload: {
              text: "继续正常请求"
            }
          })
        ]
      }
    });

    expect(view.activities[0]).toMatchObject({
      sessionId: "session-claude-interrupt",
      title: "继续正常请求",
      latestActivitySummary: "继续正常请求"
    });
  });

  it("uses waiting only for session effective status", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 13,
          agentSessionId: "session-approval",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-approval",
          cwd: "/repo",
          status: "waiting",
          title: "Needs approval"
        },
        {
          id: 14,
          agentSessionId: "session-input",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-input",
          cwd: "/repo",
          status: "waiting",
          title: "Needs input"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities.map((activity) => activity.status)).toEqual([
      "waiting",
      "waiting"
    ]);
  });

  it("maps ended and failed statuses and extracts changed files from turn completion items", () => {
    const snapshot = {
      presences: [
        {
          id: 2,
          workspaceId: "ws-1",
          userId: "user-b",
          provider: "claude-code",
          status: "paused"
        }
      ],
      sessions: [
        {
          id: 20,
          agentSessionId: "session-20",
          presenceId: 2,
          provider: "claude-code",
          providerSessionId: "provider-20",
          cwd: "/repo",
          status: "completed",
          createdAtUnixMs: 1_000,
          title: "产出 Landing 页面信息设计文档"
        },
        {
          id: 21,
          agentSessionId: "session-21",
          presenceId: 2,
          provider: "claude-code",
          providerSessionId: "provider-21",
          cwd: "/repo",
          status: "failed",
          createdAtUnixMs: 2_000,
          title: "Run failing issue"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-20": [
          callItem({
            id: 1,
            agentSessionId: "session-20",
            name: "write_file",
            content: "已撰写完整的 LandingPage 信息设计文档",
            status: "completed",
            payload: {
              fileChanges: {
                files: [
                  {
                    path: "/workspace/docs/TuttiLandingPage.md",
                    change: "added"
                  }
                ]
              }
            }
          })
        ]
      }
    });

    expect(view.activities.map((activity) => activity.status)).toEqual([
      "failed",
      "completed"
    ]);
    expect(
      view.activities.find((activity) => activity.sessionId === "session-20")
    ).toMatchObject({
      agentName: "Claude Code",
      status: "completed",
      latestActivitySummary: "已完成",
      changedFiles: [
        {
          path: "/workspace/docs/TuttiLandingPage.md",
          label: "TuttiLandingPage.md"
        }
      ]
    });
    expect(
      view.activities.find((activity) => activity.sessionId === "session-21")
    ).toMatchObject({
      status: "failed",
      latestActivitySummary: "错误"
    });
  });

  it("uses the canonical latest turn status for activity cards", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 23,
          agentSessionId: "session-stale-failed",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-stale-failed",
          cwd: "/repo",
          status: "completed",
          title: "Recover after a failed turn"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-stale-failed": [
          callItem({
            id: 1,
            agentSessionId: "session-stale-failed",
            messageId: "old-failed",
            status: "failed",
            turnId: "turn-1",
            version: 1
          }),
          callItem({
            id: 2,
            agentSessionId: "session-stale-failed",
            messageId: "latest-message",
            status: "failed",
            turnId: "turn-2",
            version: 2
          })
        ]
      }
    });

    expect(view.activities).toHaveLength(1);
    expect(view.activities[0]).toMatchObject({
      sessionId: "session-stale-failed",
      status: "completed"
    });
  });

  it("uses completed as the canonical activity status instead of end", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 22,
          agentSessionId: "session-completed",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-completed",
          cwd: "/repo",
          status: "completed",
          title: "Completed session"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities[0]?.status).toBe("completed");
  });

  it("extracts changed files from message payload metadata", () => {
    const snapshot = {
      presences: [
        {
          id: 2,
          workspaceId: "ws-1",
          userId: "user-b",
          provider: "openclaw",
          status: "working"
        }
      ],
      sessions: [
        {
          id: 20,
          agentSessionId: "session-20",
          presenceId: 2,
          provider: "openclaw",
          providerSessionId: "provider-20",
          cwd: "/repo",
          status: "working",
          title: "新增一个123.txt文件，内容是 hello world"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-20": [
          callItem({
            id: 1,
            agentSessionId: "session-20",
            name: "write_file",
            status: "completed",
            payload: {
              fileChanges: {
                files: [
                  { path: "  /workspace/123.txt  ", change: "added" },
                  { path: "/workspace/123.txt", change: "modified" },
                  { path: "/workspace/src/app.ts", change: "modified" }
                ]
              }
            }
          })
        ]
      }
    });

    expect(view.activities[0]).toMatchObject({
      sessionId: "session-20",
      status: "working",
      changedFiles: [
        { path: "/workspace/123.txt", label: "123.txt" },
        { path: "/workspace/src/app.ts", label: "app.ts" }
      ]
    });
  });

  it("falls back to Codex apply_patch payload paths when fileChanges metadata is missing", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 20,
          agentSessionId: "session-20",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-20",
          cwd: "/repo",
          status: "completed",
          title: "帮我写入到 txt 文件上"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-20": [
          callItem({
            id: 1,
            agentSessionId: "session-20",
            name: "apply_patch",
            itemType: "call.completed",
            status: "completed",
            payload: {
              toolName: "apply_patch",
              paths: ["/workspace/ws-1/today_news_2026-05-27.txt"],
              output: {
                changes: {
                  "/workspace/ws-1/today_news_2026-05-27.txt": {
                    type: "add"
                  }
                }
              }
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.changedFiles).toEqual([
      {
        path: "/workspace/ws-1/today_news_2026-05-27.txt",
        label: "today_news_2026-05-27.txt"
      }
    ]);
  });

  it("keeps changed file keys from lightweight change maps", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 20,
          agentSessionId: "session-20",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-20",
          cwd: "/repo",
          status: "completed",
          title: "编辑文件"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-20": [
          callItem({
            id: 1,
            agentSessionId: "session-20",
            name: "apply_patch",
            itemType: "call.completed",
            status: "completed",
            payload: {
              toolName: "apply_patch",
              output: {
                changes: {
                  "/workspace/ws-1/src/a.ts": "add",
                  "/workspace/ws-1/src/b.ts": null
                }
              }
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.changedFiles).toEqual([
      {
        path: "/workspace/ws-1/src/a.ts",
        label: "a.ts"
      },
      {
        path: "/workspace/ws-1/src/b.ts",
        label: "b.ts"
      }
    ]);
  });

  it("extracts changed files from Codex Edit changes arrays", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 20,
          agentSessionId: "session-20",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-20",
          cwd: "/repo",
          status: "completed",
          title: "编辑 html 文件"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-20": [
          callItem({
            id: 1,
            agentSessionId: "session-20",
            name: "Edit",
            itemType: "call.completed",
            status: "completed",
            payload: {
              toolName: "Edit",
              input: {
                file_path: "/workspace/deck/assets/styles.css",
                changes: [
                  {
                    path: "/workspace/deck/slides/02-why-now.html",
                    kind: { type: "add" },
                    diff: "<section>Why now</section>\n"
                  },
                  {
                    path: "/workspace/deck/slides/01-cover.html",
                    kind: { type: "update" },
                    diff: "@@ -1 +1 @@\n-Old\n+New\n"
                  }
                ]
              }
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.changedFiles).toEqual([
      {
        path: "/workspace/deck/slides/02-why-now.html",
        label: "02-why-now.html"
      },
      {
        path: "/workspace/deck/slides/01-cover.html",
        label: "01-cover.html"
      },
      {
        path: "/workspace/deck/assets/styles.css",
        label: "styles.css"
      }
    ]);
  });

  it("does not infer changed files from failed writes without fileChanges metadata", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 20,
          agentSessionId: "session-20",
          presenceId: 0,
          provider: "claude-code",
          providerSessionId: "provider-20",
          cwd: "/repo",
          status: "failed",
          title: "写入文件失败"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-20": [
          callItem({
            id: 1,
            agentSessionId: "session-20",
            name: "Write",
            itemType: "call.errored",
            status: "failed",
            payload: {
              toolName: "Write",
              paths: ["/workspace/ws-1/todo-app/index.html"]
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.changedFiles).toEqual([]);
  });

  it("ignores structured payload strings in changed file paths", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 20,
          agentSessionId: "session-20",
          presenceId: 0,
          provider: "openclaw",
          providerSessionId: "provider-20",
          cwd: "/repo",
          status: "completed",
          title: "Completed session"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-20": [
          callItem({
            id: 1,
            agentSessionId: "session-20",
            name: "write_file",
            status: "completed",
            payload: {
              fileChanges: {
                files: [
                  {
                    path: '{"oldStart":1,"lines":["+not a path"]}',
                    change: "added"
                  },
                  { path: "/workspace/123.txt", change: "added" },
                  { path: "/workspace/123.txt", change: "added" }
                ]
              }
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.changedFiles).toEqual([
      { path: "/workspace/123.txt", label: "123.txt" }
    ]);
  });

  it("filters non-workspace file paths from left room status cards", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 20,
          agentSessionId: "session-20",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-20",
          cwd: "/repo",
          status: "completed",
          title: "Completed session"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-20": [
          callItem({
            id: 1,
            agentSessionId: "session-20",
            name: "apply_patch",
            itemType: "call.completed",
            status: "completed",
            payload: {
              toolName: "apply_patch",
              paths: [
                "/dev/null",
                "ppt_news/generate_news_ppt.py",
                "/workspace/output/image.png"
              ]
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.changedFiles).toEqual([
      { path: "/workspace/output/image.png", label: "image.png" }
    ]);
  });

  it("collects agent-generated files across sessions for mention picker", () => {
    const snapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          agentSessionId: "session-20",
          agentTargetId: "agent-a",
          cwd: "/Users/demo/project",
          provider: "codex",
          status: "completed",
          title: "Completed session",
          workspaceId: "workspace-1"
        },
        {
          agentSessionId: "session-21",
          agentTargetId: "agent-b",
          cwd: "/Users/demo/project",
          provider: "codex",
          status: "completed",
          title: "Another session",
          workspaceId: "workspace-1"
        }
      ],
      sessionMessagesById: {
        "session-20": [
          {
            agentSessionId: "session-20",
            kind: "tool_call",
            messageId: "message-1",
            payload: {
              toolName: "Write",
              status: "completed",
              fileChanges: {
                files: [{ path: "/Users/demo/project/output/report.md" }]
              }
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-1",
            occurredAtUnixMs: 1,
            version: 1
          }
        ],
        "session-21": [
          {
            agentSessionId: "session-21",
            kind: "tool_call",
            messageId: "message-2",
            payload: {
              toolName: "apply_patch",
              status: "completed",
              paths: ["/workspace/output/image.png"]
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-2",
            occurredAtUnixMs: 1,
            version: 1
          }
        ]
      }
    };

    const files = collectWorkspaceAgentGeneratedFiles(
      canonicalSource(snapshot),
      {
        workspaceRoot: "/Users/demo/project"
      }
    );

    expect(files).toEqual([
      {
        path: "/Users/demo/project/output/report.md",
        label: "report.md"
      },
      {
        path: "/workspace/output/image.png",
        label: "image.png"
      }
    ]);
    expect(
      collectWorkspaceAgentGeneratedFiles(canonicalSource(snapshot), {
        agentTargetIds: ["agent-b"],
        workspaceRoot: "/Users/demo/project"
      })
    ).toEqual([
      {
        path: "/workspace/output/image.png",
        label: "image.png"
      }
    ]);
  });

  it("derives the fallback root after applying the agent provenance filter", () => {
    const snapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          agentSessionId: "session-a",
          agentTargetId: "agent-a",
          cwd: "/Users/demo/project-a",
          provider: "codex",
          status: "completed",
          title: "Project A",
          workspaceId: "workspace-1"
        },
        {
          agentSessionId: "session-b",
          agentTargetId: "agent-b",
          cwd: "/Users/demo/project-b",
          provider: "codex",
          status: "completed",
          title: "Project B",
          workspaceId: "workspace-1"
        }
      ],
      sessionMessagesById: {
        "session-b": [
          {
            agentSessionId: "session-b",
            kind: "tool_call",
            messageId: "message-b",
            payload: {
              toolName: "Write",
              status: "completed",
              fileChanges: { files: [{ path: "output/report.md" }] }
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-b",
            occurredAtUnixMs: 1,
            version: 1
          }
        ]
      }
    };

    expect(
      collectWorkspaceAgentGeneratedFiles(canonicalSource(snapshot), {
        agentTargetIds: ["agent-b"]
      })
    ).toEqual([
      {
        path: "/Users/demo/project-b/output/report.md",
        label: "report.md"
      }
    ]);
  });

  it("collects agent-generated files from Codex Edit changes arrays", () => {
    const snapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          agentSessionId: "session-20",
          cwd: "/Users/demo/project",
          provider: "codex",
          status: "completed",
          title: "Completed session",
          workspaceId: "workspace-1"
        }
      ],
      sessionMessagesById: {
        "session-20": [
          {
            agentSessionId: "session-20",
            kind: "tool_call",
            messageId: "message-1",
            payload: {
              toolName: "Edit",
              input: {
                file_path: "assets/styles.css",
                changes: [
                  {
                    path: "slides/02-why-now.html",
                    kind: { type: "add" },
                    diff: "<section>Why now</section>\n"
                  },
                  {
                    path: "/Users/demo/project/slides/01-cover.html",
                    kind: { type: "update" },
                    diff: "@@ -1 +1 @@\n-Old\n+New\n"
                  }
                ]
              }
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-1",
            occurredAtUnixMs: 1,
            version: 1
          }
        ]
      }
    };

    const files = collectWorkspaceAgentGeneratedFiles(
      canonicalSource(snapshot),
      {
        workspaceRoot: "/Users/demo/project"
      }
    );

    expect(files).toEqual([
      {
        path: "/Users/demo/project/slides/02-why-now.html",
        label: "02-why-now.html"
      },
      {
        path: "/Users/demo/project/slides/01-cover.html",
        label: "01-cover.html"
      },
      {
        path: "/Users/demo/project/assets/styles.css",
        label: "styles.css"
      }
    ]);
  });

  it("collects canonical and historical Codex image generation paths", () => {
    const canonicalPath =
      "/Users/demo/.tutti/agent/runs/session-20/codex-home/generated_images/thread/ig_canonical.webp";
    const historicalPath =
      "/Users/demo/.tutti/agent/runs/session-20/codex-home/generated_images/thread/ig_legacy.png";
    const snapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          agentSessionId: "session-20",
          cwd: "/Users/demo/project",
          provider: "codex",
          status: "completed",
          title: "Generate images",
          workspaceId: "workspace-1"
        }
      ],
      sessionMessagesById: {
        "session-20": [
          {
            agentSessionId: "session-20",
            kind: "tool_call",
            messageId: "message-canonical",
            payload: {
              toolName: "ImageGeneration",
              content: [
                {
                  type: "content",
                  content: {
                    type: "image",
                    uri: canonicalPath,
                    mimeType: "image/webp"
                  }
                }
              ]
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-canonical",
            occurredAtUnixMs: 1,
            version: 1
          },
          {
            agentSessionId: "session-20",
            kind: "tool_call",
            messageId: "message-historical",
            payload: {
              toolName: "ImageGeneration",
              name: "Generate image",
              output: {
                savedPath: historicalPath,
                result: "legacy-base64"
              }
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-historical",
            occurredAtUnixMs: 2,
            version: 2
          }
        ]
      }
    };

    expect(
      collectWorkspaceAgentGeneratedFiles(canonicalSource(snapshot), {
        workspaceRoot: "/Users/demo/project"
      })
    ).toEqual([
      {
        path: canonicalPath,
        label: "ig_canonical.webp"
      },
      {
        path: historicalPath,
        label: "ig_legacy.png"
      }
    ]);
  });

  it("collects agent-generated files from lightweight change maps", () => {
    const snapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          agentSessionId: "session-20",
          cwd: "/Users/demo/project",
          provider: "codex",
          status: "completed",
          title: "Completed session",
          workspaceId: "workspace-1"
        }
      ],
      sessionMessagesById: {
        "session-20": [
          {
            agentSessionId: "session-20",
            kind: "tool_call",
            messageId: "message-1",
            payload: {
              toolName: "apply_patch",
              output: {
                changes: {
                  "src/a.ts": "add",
                  "/Users/demo/project/src/b.ts": null
                }
              }
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-1",
            occurredAtUnixMs: 1,
            version: 1
          }
        ]
      }
    };

    const files = collectWorkspaceAgentGeneratedFiles(
      canonicalSource(snapshot),
      {
        workspaceRoot: "/Users/demo/project"
      }
    );

    expect(files).toEqual([
      {
        path: "/Users/demo/project/src/a.ts",
        label: "a.ts"
      },
      {
        path: "/Users/demo/project/src/b.ts",
        label: "b.ts"
      }
    ]);
  });

  it("filters agent-generated files to the selected session work directory", () => {
    const snapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          agentSessionId: "session-web",
          cwd: "/Users/demo/project/apps/web",
          provider: "codex",
          status: "completed",
          title: "Web session",
          workspaceId: "workspace-1"
        },
        {
          agentSessionId: "session-api",
          cwd: "/Users/demo/project/apps/api",
          provider: "codex",
          status: "completed",
          title: "API session",
          workspaceId: "workspace-1"
        }
      ],
      sessionMessagesById: {
        "session-web": [
          {
            agentSessionId: "session-web",
            kind: "tool_call",
            messageId: "message-web",
            payload: {
              toolName: "Write",
              status: "completed",
              fileChanges: {
                files: [{ path: "/Users/demo/project/apps/web/index.html" }]
              }
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-web",
            occurredAtUnixMs: 1,
            version: 1
          }
        ],
        "session-api": [
          {
            agentSessionId: "session-api",
            kind: "tool_call",
            messageId: "message-api",
            payload: {
              toolName: "Write",
              status: "completed",
              fileChanges: {
                files: [{ path: "/Users/demo/project/apps/api/server.go" }]
              }
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-api",
            occurredAtUnixMs: 1,
            version: 1
          }
        ]
      }
    };

    expect(
      collectWorkspaceAgentGeneratedFiles(canonicalSource(snapshot), {
        sessionCwd: "/Users/demo/project/apps/web"
      })
    ).toEqual([
      {
        path: "/Users/demo/project/apps/web/index.html",
        label: "index.html"
      }
    ]);
  });

  it("collects Codex edit tool file paths from structured tool payloads", () => {
    const snapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          agentSessionId: "session-22",
          cwd: "/Users/demo/project/apps",
          provider: "codex",
          status: "completed",
          title: "Create 11.md",
          workspaceId: "workspace-1"
        }
      ],
      sessionMessagesById: {
        "session-22": [
          {
            agentSessionId: "session-22",
            kind: "tool_call",
            messageId: "message-1",
            payload: {
              callType: "tool",
              content: [
                {
                  newText: "",
                  oldText: "222\n",
                  path: "/Users/demo/project/apps/11.md",
                  type: "diff"
                }
              ],
              input: {
                changes: {
                  "/Users/demo/project/apps/11.md": {
                    type: "update",
                    unified_diff: "@@ -1 +0,0 @@\n-222\n"
                  }
                },
                file_path: "/Users/demo/project/apps/11.md",
                toolCall: {
                  kind: "edit",
                  title: "Edit /Users/demo/project/apps/11.md"
                }
              },
              name: "Edit /Users/demo/project/apps/11.md",
              output: {
                changes: {
                  "/Users/demo/project/apps/11.md": {
                    type: "update",
                    unified_diff: "@@ -1 +0,0 @@\n-222\n"
                  }
                },
                filePath: "/Users/demo/project/apps/11.md",
                status: "completed",
                success: true
              },
              status: "completed",
              title: "Edit /Users/demo/project/apps/11.md",
              toolName: "Edit /Users/demo/project/apps/11.md"
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-1",
            occurredAtUnixMs: 1,
            version: 1
          },
          {
            agentSessionId: "session-22",
            kind: "text",
            messageId: "message-2",
            payload: {
              summary:
                "已创建并确认是空文件: `/Users/demo/project/apps/11.md`。`wc -c` 显示大小为 `0` 字节。"
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-2",
            occurredAtUnixMs: 2,
            version: 2
          }
        ]
      }
    };

    expect(
      collectWorkspaceAgentGeneratedFiles(canonicalSource(snapshot), {
        workspaceRoot: "/Users/demo/project"
      })
    ).toEqual([
      {
        path: "/Users/demo/project/apps/11.md",
        label: "11.md"
      }
    ]);
  });

  it("does not treat Bash read commands as agent-generated files", () => {
    const snapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          agentSessionId: "session-24",
          cwd: "/Users/demo/project/apps",
          provider: "codex",
          status: "completed",
          title: "Inspect 11.md",
          workspaceId: "workspace-1"
        }
      ],
      sessionMessagesById: {
        "session-24": [
          {
            agentSessionId: "session-24",
            kind: "tool_call",
            messageId: "message-1",
            payload: {
              callType: "tool",
              fileChanges: {
                files: [
                  { path: "/Users/demo/project/apps/read-filechanges.md" }
                ]
              },
              input: {
                command: "nl -ba 11.md",
                cwd: "/Users/demo/project/apps",
                changes: {
                  "/Users/demo/project/apps/read-input-changes.md": "read"
                },
                file_path: "/Users/demo/project/apps/11.md"
              },
              locations: [{ path: "/Users/demo/project/apps/11.md" }],
              name: "Bash",
              output: {
                aggregated_output: "     1\t222\n",
                status: "completed",
                success: true
              },
              status: "completed",
              toolName: "Bash"
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-1",
            occurredAtUnixMs: 1,
            version: 1
          }
        ]
      }
    };

    expect(
      collectWorkspaceAgentGeneratedFiles(canonicalSource(snapshot), {
        workspaceRoot: "/Users/demo/project"
      })
    ).toEqual([]);
  });

  it("does not collect failed file change tool payloads as agent-generated files", () => {
    const snapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          agentSessionId: "session-25",
          cwd: "/Users/demo/project",
          provider: "codex",
          status: "completed",
          title: "Failed writes",
          workspaceId: "workspace-1"
        }
      ],
      sessionMessagesById: {
        "session-25": [
          {
            agentSessionId: "session-25",
            kind: "tool_call",
            messageId: "message-failed-status",
            payload: {
              toolName: "Write",
              fileChanges: {
                files: [{ path: "failed-status.md" }]
              }
            },
            role: "assistant",
            status: "failed",
            turnId: "turn-message-1",
            occurredAtUnixMs: 1,
            version: 1
          },
          {
            agentSessionId: "session-25",
            kind: "tool_call",
            messageId: "message-failed-output",
            payload: {
              toolName: "Write",
              output: {
                filePath: "failed-output.md",
                status: "failed",
                success: false
              }
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-1",
            occurredAtUnixMs: 2,
            version: 2
          },
          {
            agentSessionId: "session-25",
            kind: "tool_call",
            messageId: "message-success",
            payload: {
              toolName: "Write",
              output: {
                filePath: "ok.md",
                status: "completed",
                success: true
              }
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-1",
            occurredAtUnixMs: 3,
            version: 3
          }
        ]
      }
    };

    expect(
      collectWorkspaceAgentGeneratedFiles(canonicalSource(snapshot), {
        workspaceRoot: "/Users/demo/project"
      })
    ).toEqual([
      {
        path: "/Users/demo/project/ok.md",
        label: "ok.md"
      }
    ]);
  });

  it("resolves relative agent-generated file paths against the session cwd", () => {
    const snapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          agentSessionId: "session-20",
          cwd: "/Users/demo/project",
          provider: "codex",
          status: "working",
          title: "Create 11.md",
          workspaceId: "workspace-1"
        }
      ],
      sessionMessagesById: {
        "session-20": [
          {
            agentSessionId: "session-20",
            kind: "tool_call",
            messageId: "message-1",
            payload: {
              toolName: "Write",
              status: "completed",
              input: {
                file_path: "11.md"
              }
            },
            role: "assistant",
            status: "completed",
            turnId: "turn-message-1",
            occurredAtUnixMs: 1,
            version: 1
          }
        ]
      }
    };

    expect(
      collectWorkspaceAgentGeneratedFiles(canonicalSource(snapshot))
    ).toEqual([
      {
        path: "/Users/demo/project/11.md",
        label: "11.md"
      }
    ]);
  });

  it("uses the shortest unique suffix for duplicate file names on left room status cards", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 20,
          agentSessionId: "session-20",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-20",
          cwd: "/repo",
          status: "completed",
          title: "Completed session"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-20": [
          callItem({
            id: 1,
            agentSessionId: "session-20",
            name: "apply_patch",
            itemType: "call.completed",
            status: "completed",
            payload: {
              toolName: "apply_patch",
              paths: [
                "/workspace/ws-1/reports/index.html",
                "/workspace/ws-1/todo/index.html",
                "/workspace/ws-1/notes/readme.md"
              ]
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.changedFiles).toEqual([
      {
        path: "/workspace/ws-1/reports/index.html",
        label: "reports/index.html"
      },
      { path: "/workspace/ws-1/todo/index.html", label: "todo/index.html" },
      { path: "/workspace/ws-1/notes/readme.md", label: "readme.md" }
    ]);
  });

  it("matches message file changes through the canonical session id", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 20,
          agentSessionId: "alias-session-20",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "runtime-session-20",
          cwd: "/repo",
          status: "working",
          title: "Implement protocol"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "alias-session-20": [
          callItem({
            id: 1,
            agentSessionId: "alias-session-20",
            name: "apply_patch",
            status: "completed",
            payload: {
              fileChanges: {
                files: [
                  {
                    path: "/workspace/provider-match.ts",
                    change: "modified"
                  },
                  { path: "/workspace/sync-match.ts", change: "modified" }
                ]
              }
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.changedFiles).toEqual([
      { path: "/workspace/provider-match.ts", label: "provider-match.ts" },
      { path: "/workspace/sync-match.ts", label: "sync-match.ts" }
    ]);
  });

  it("treats terminal lifecycle statuses as ended before effective working status", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 22,
          agentSessionId: "session-22",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-22",
          cwd: "/repo",
          status: "completed",
          createdAtUnixMs: 1_000,
          title: "Finished issue"
        },
        {
          id: 23,
          agentSessionId: "session-23",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-23",
          cwd: "/repo",
          status: "canceled",
          createdAtUnixMs: 2_000,
          title: "Canceled issue"
        },
        {
          id: 24,
          agentSessionId: "session-24",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-24",
          cwd: "/repo",
          status: "canceled",
          createdAtUnixMs: 3_000,
          title: "Canceled issue"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities.map((activity) => activity.status)).toEqual([
      "canceled",
      "canceled",
      "completed"
    ]);
  });

  it("uses session user data when presence is missing", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 31,
          agentSessionId: "session-31",
          presenceId: 0,
          userId: "member-2",
          provider: "codex",
          providerSessionId: "provider-31",
          cwd: "/repo",
          status: "working",
          title: "Run local Codex issue"
        }
      ]
    };
    const userProfilesById: Record<string, AgentHostUserInfo> = {
      "member-2": {
        userId: "member-2",
        name: "Mina",
        assetUrl:
          "https://assets.tutti.sh/v1/assets/member-2/account_avatar/mina.png"
      }
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      userProfilesById
    });

    expect(view.activities[0]).toMatchObject({
      userId: "member-2",
      userName: "Mina",
      userAvatarUrl:
        "https://assets.tutti.sh/v1/assets/member-2/account_avatar/mina.png?width=32&height=32&fit=cover&format=webp"
    });
  });

  it("falls back to status summary when only tool activity is available", () => {
    const snapshot = {
      presences: [
        {
          id: 3,
          workspaceId: "ws-1",
          userId: "user-c",
          provider: "codex",
          status: "working"
        }
      ],
      sessions: [
        {
          id: 40,
          agentSessionId: "session-40",
          presenceId: 3,
          provider: "codex",
          providerSessionId: "provider-40",
          cwd: "/repo",
          status: "working",
          title: "Summarize current turn"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-40": [
          callItem({
            id: 1,
            agentSessionId: "session-40",
            content: " \n\t ",
            payload: {
              summary: "正在整理当前 Issue 进度"
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.latestActivitySummary).toBe("运行中");
  });

  it("does not use the latest tool call as the activity summary", () => {
    const snapshot = {
      presences: [
        {
          id: 4,
          workspaceId: "ws-1",
          userId: "user-d",
          provider: "codex",
          status: "working"
        }
      ],
      sessions: [
        {
          id: 50,
          agentSessionId: "session-50",
          presenceId: 4,
          provider: "codex",
          providerSessionId: "provider-50",
          cwd: "/repo",
          status: "working",
          title: "Track reported conversation"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-50": [
          callItem({
            id: 1,
            agentSessionId: "session-50",
            name: "exec_command",
            status: "Working",
            content: "",
            payload: {
              metadata: {
                command: 'for i in 1 2 3; do echo "$i"; done'
              }
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.latestActivitySummary).toBe("运行中");
  });

  it("prefers the latest message over a newer tool call for the activity summary", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 55,
          agentSessionId: "session-55",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-55",
          cwd: "/repo",
          effectiveStatus: "working",
          title: "Inspect files"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-55": [
          callItem({
            id: 1,
            agentSessionId: "session-55",
            name: "read_file",
            status: "completed",
            content: ""
          }),
          callItem({
            id: 2,
            agentSessionId: "session-55",
            name: "exec_command",
            status: "running",
            content: ""
          }),
          messageItem({
            id: 2,
            agentSessionId: "session-55",
            role: "assistant",
            actorType: "agent",
            content: "我正在确认关键文件。"
          }),
          callItem({
            id: 3,
            agentSessionId: "session-55",
            name: "read_file",
            status: "completed",
            content: "",
            payload: {
              metadata: {
                paths: ["README.md"]
              }
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.latestActivitySummary).toBe(
      "我正在确认关键文件。"
    );
  });

  it("uses the latest user message as the activity summary when it is newest", () => {
    const snapshot = {
      presences: [
        {
          id: 5,
          workspaceId: "ws-1",
          userId: "user-e",
          provider: "codex",
          status: "working"
        }
      ],
      sessions: [
        {
          id: 60,
          agentSessionId: "session-60",
          presenceId: 5,
          provider: "codex",
          providerSessionId: "provider-60",
          cwd: "/repo",
          effectiveStatus: "working",
          title: "Track status panel summary"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-60": [
          messageItem({
            id: 1,
            agentSessionId: "session-60",
            role: "assistant",
            actorType: "agent",
            content: "我正在检查房间状态面板的 session 列表。"
          }),
          messageItem({
            id: 2,
            agentSessionId: "session-60",
            role: "user",
            actorType: "user",
            content: "请继续看工具调用状态。"
          })
        ]
      }
    });

    expect(view.activities[0]?.latestActivitySummary).toBe(
      "请继续看工具调用状态。"
    );
    expect(view.activities[0]?.latestActivityActorName).toBe("user-e");
  });

  it("uses the localized empty-session label when the title is blank", () => {
    const snapshot = {
      presences: [
        {
          id: 5,
          workspaceId: "ws-1",
          userId: "user-e",
          provider: "codex",
          status: "working"
        }
      ],
      sessions: [
        {
          id: 60,
          agentSessionId: "session-60",
          presenceId: 5,
          provider: "codex",
          providerSessionId: "provider-60",
          cwd: "/repo",
          effectiveStatus: "working",
          title: ""
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-60": [
          messageItem({
            id: 1,
            agentSessionId: "session-60",
            content: "第一轮 Issue"
          }),
          messageItem({
            id: 2,
            agentSessionId: "session-60",
            content: "把左侧状态面板标题对上对应 session title"
          }),
          callItem({
            id: 3,
            agentSessionId: "session-60",
            name: "CurrentTask",
            status: "Working"
          })
        ]
      }
    });

    expect(view.activities[0]?.title).toBe("未命名对话");
  });

  it("does not replace a session title from user messages", () => {
    const snapshot = {
      presences: [
        {
          id: 6,
          workspaceId: "ws-1",
          userId: "user-e",
          provider: "claude-code",
          status: "idle"
        }
      ],
      sessions: [
        {
          id: 61,
          agentSessionId: "session-61",
          presenceId: 6,
          provider: "claude-code",
          providerSessionId: "provider-61",
          cwd: "/repo",
          effectiveStatus: "idle",
          title: "Claude Code"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "session-61": [
          messageItem({
            id: 1,
            agentSessionId: "session-61",
            itemType: "message.user",
            payload: {
              text: "AAA"
            }
          })
        ]
      }
    });

    expect(view.activities[0]?.title).toBe("Claude Code");
  });

  it("uses session sort time for ordering before timeline items are loaded", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 200,
          agentSessionId: "older-working",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-older",
          cwd: "/repo",
          effectiveStatus: "working",
          updatedAtUnixMs: 1000,
          createdAtUnixMs: 1000,
          title: "Older working session"
        },
        {
          id: 10,
          agentSessionId: "new-working",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-new",
          cwd: "/repo",
          effectiveStatus: "working",
          updatedAtUnixMs: 2000,
          createdAtUnixMs: 2000,
          title: "New working session"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities.map((activity) => activity.sessionId)).toEqual([
      "new-working",
      "older-working"
    ]);
  });

  it("orders activities by session start instead of ordinary activity messages", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 10,
          agentSessionId: "older-start",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-older-start",
          cwd: "/repo",
          effectiveStatus: "working",
          updatedAtUnixMs: 5000,
          createdAtUnixMs: 1000,
          title: "Older started session"
        },
        {
          id: 11,
          agentSessionId: "newer-start",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-newer-start",
          cwd: "/repo",
          effectiveStatus: "working",
          updatedAtUnixMs: 2500,
          createdAtUnixMs: 2000,
          title: "Newer started session"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "older-start": [
          messageItem({
            id: 1,
            agentSessionId: "older-start",
            role: "assistant",
            content: "This message is newer than the other card.",
            occurredAtUnixMs: 5000
          })
        ],
        "newer-start": [
          messageItem({
            id: 2,
            agentSessionId: "newer-start",
            role: "assistant",
            content: "This session started later.",
            occurredAtUnixMs: 2500
          })
        ]
      }
    });

    expect(view.activities.map((activity) => activity.sessionId)).toEqual([
      "newer-start",
      "older-start"
    ]);
    expect(view.activities[1]?.latestActivitySummary).toBe(
      "This message is newer than the other card."
    );
  });

  it("moves an older session up when a newer turn starts from a user message", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 10,
          agentSessionId: "older-session-new-turn",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-older-session-new-turn",
          cwd: "/repo",
          effectiveStatus: "working",
          latestTurn: {
            agentSessionId: "older-session-new-turn",
            phase: "running",
            startedAtUnixMs: 9000,
            turnId: "turn-new",
            updatedAtUnixMs: 9000
          },
          updatedAtUnixMs: 9000,
          createdAtUnixMs: 1000,
          title: "Older session new turn"
        },
        {
          id: 11,
          agentSessionId: "newer-session-old-turn",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-newer-session-old-turn",
          cwd: "/repo",
          effectiveStatus: "working",
          latestTurn: {
            agentSessionId: "newer-session-old-turn",
            phase: "running",
            startedAtUnixMs: 3000,
            turnId: "turn-old",
            updatedAtUnixMs: 3000
          },
          updatedAtUnixMs: 8000,
          createdAtUnixMs: 2000,
          title: "Newer session old turn"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot, {
      sessionMessagesById: {
        "older-session-new-turn": [
          messageItem({
            id: 1,
            agentSessionId: "older-session-new-turn",
            turnId: "turn-new",
            role: "user",
            content: "Start a new turn.",
            occurredAtUnixMs: 9000
          })
        ],
        "newer-session-old-turn": [
          messageItem({
            id: 2,
            agentSessionId: "newer-session-old-turn",
            turnId: "turn-old",
            role: "user",
            content: "Earlier turn.",
            occurredAtUnixMs: 3000
          })
        ]
      }
    });

    expect(view.activities.map((activity) => activity.sessionId)).toEqual([
      "older-session-new-turn",
      "newer-session-old-turn"
    ]);
  });

  it("falls back to session creation time when messages have not been loaded", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 10,
          agentSessionId: "created-earlier-updated-later",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-created-earlier-updated-later",
          cwd: "/repo",
          effectiveStatus: "idle",
          updatedAtUnixMs: 9000,
          createdAtUnixMs: 1000,
          title: "Created earlier updated later"
        },
        {
          id: 11,
          agentSessionId: "created-later-updated-earlier",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-created-later-updated-earlier",
          cwd: "/repo",
          effectiveStatus: "idle",
          updatedAtUnixMs: 3000,
          createdAtUnixMs: 2000,
          title: "Created later updated earlier"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities.map((activity) => activity.sessionId)).toEqual([
      "created-later-updated-earlier",
      "created-earlier-updated-later"
    ]);
  });

  it("orders activities by session sort time regardless of status", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 10,
          agentSessionId: "older-failed",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-older-failed",
          cwd: "/repo",
          lifecycleStatus: "failed",
          effectiveStatus: "failed",
          updatedAtUnixMs: 1000,
          createdAtUnixMs: 1000,
          title: "Older failed session"
        },
        {
          id: 11,
          agentSessionId: "newer-idle",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-newer-idle",
          cwd: "/repo",
          effectiveStatus: "idle",
          updatedAtUnixMs: 3000,
          createdAtUnixMs: 3000,
          title: "Newer idle session"
        },
        {
          id: 12,
          agentSessionId: "middle-ended",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-middle-ended",
          cwd: "/repo",
          lifecycleStatus: "ended",
          effectiveStatus: "completed",
          updatedAtUnixMs: 2000,
          createdAtUnixMs: 2000,
          title: "Middle ended session"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities.map((activity) => activity.sessionId)).toEqual([
      "newer-idle",
      "middle-ended",
      "older-failed"
    ]);
  });

  it("keeps canonical mention titles unchanged", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 10,
          agentSessionId: "mention-title",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-mention",
          cwd: "/repo",
          effectiveStatus: "working",
          title: "@wang jomes & Codex hi"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities[0]?.title).toBe("@wang jomes & Codex hi");
  });

  it("keeps canonical workspace link labels unchanged", () => {
    const snapshot = {
      presences: [],
      sessions: [
        {
          id: 11,
          agentSessionId: "file-title",
          presenceId: 0,
          provider: "codex",
          providerSessionId: "provider-file",
          cwd: "/repo",
          effectiveStatus: "working",
          title: "@aa.md 这是什么内容"
        }
      ]
    };

    const view = buildWorkspaceAgentActivityListViewModel(snapshot);

    expect(view.activities[0]?.title).toBe("@aa.md 这是什么内容");
  });
});
