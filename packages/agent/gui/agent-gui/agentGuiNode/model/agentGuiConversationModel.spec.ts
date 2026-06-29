import { describe, expect, it } from "vitest";
import type {
  AgentHostWorkspaceAgentMessage,
  AgentHostWorkspaceAgentSession,
  AgentHostWorkspaceAgentSnapshot,
  AgentHostWorkspaceAgentTimelineItem
} from "../../../shared/contracts/dto";
import type { WorkspaceAgentActivitySnapshot } from "../../../shared/workspaceAgentActivityTypes";
import {
  AGENT_GUI_RUNTIME_SESSION_ORIGIN,
  buildAgentGUIConversationDetail,
  buildAgentGUITimelineItems,
  buildAgentGUIConversationVM,
  buildAgentGUIConversationSummaries,
  conversationSummaryFromAgentSession,
  applyAgentGUIConversationProjects,
  mergeAgentGUITimelineItems,
  resolveAgentGUIConversationTitleFromTimelineItems,
  buildAgentGUITimelineRows,
  mergeAgentGUITimelineRows,
  selectAgentGUIConversationId,
  selectPendingApproval,
  selectPendingApprovalFromTimelineItems,
  selectPendingInteractivePromptFromTimelineItems,
  resolveAgentGUIConversationProject,
  type AgentGUIConversationUserProject
} from "./agentGuiConversationModel";

describe("agentGuiConversationModel", () => {
  it("resolves a project for an exact cwd match", () => {
    expect(
      resolveAgentGUIConversationProject("/workspace/app", [
        userProject("app", "/workspace/app", "App")
      ])
    ).toEqual({
      id: "app",
      path: "/workspace/app",
      label: "App"
    });
  });

  it("resolves a project when cwd is inside a project directory", () => {
    expect(
      resolveAgentGUIConversationProject("/workspace/app/packages/web", [
        userProject("app", "/workspace/app", "App")
      ])
    ).toEqual({
      id: "app",
      path: "/workspace/app",
      label: "App"
    });
  });

  it("chooses the longest project path when multiple projects match cwd", () => {
    expect(
      resolveAgentGUIConversationProject("/workspace/app/packages/web", [
        userProject("workspace", "/workspace", "Workspace"),
        userProject("app", "/workspace/app", "App"),
        userProject("web", "/workspace/app/packages/web", "Web")
      ])
    ).toEqual({
      id: "web",
      path: "/workspace/app/packages/web",
      label: "Web"
    });
  });

  it("returns null when cwd does not match any project path", () => {
    expect(
      resolveAgentGUIConversationProject("/workspace/app-archive", [
        userProject("app", "/workspace/app", "App")
      ])
    ).toBeNull();
  });

  it("does not treat a root project path as a parent project", () => {
    expect(
      resolveAgentGUIConversationProject("/workspace/app", [
        userProject("root", "/", "Root")
      ])
    ).toBeNull();
    expect(
      resolveAgentGUIConversationProject("/", [
        userProject("root", "/", "Root")
      ])
    ).toEqual({
      id: "root",
      path: "/",
      label: "Root"
    });
  });

  it("returns null for a no-project cwd before matching parent projects", () => {
    const noProjectPath =
      "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444";

    expect(
      resolveAgentGUIConversationProject(
        noProjectPath,
        [userProject("home", "/Users/local", "Home")],
        {
          isNoProjectPath: ({ path }) => path === noProjectPath
        }
      )
    ).toBeNull();
  });

  it("keeps generated-looking cwd values grouped under real parent projects without host no-project context", () => {
    expect(
      resolveAgentGUIConversationProject(
        "/repo/Documents/tutti/session-44444444-4444-4444-8444-444444444444",
        [userProject("repo", "/repo", "Repo")]
      )
    ).toEqual({
      id: "repo",
      path: "/repo",
      label: "Repo"
    });
  });

  it("keeps an explicit project whose path looks like a generated no-project cwd", () => {
    expect(
      resolveAgentGUIConversationProject(
        "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444",
        [
          userProject("home", "/Users/local", "Home"),
          userProject(
            "odd",
            "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444",
            "Odd project"
          )
        ]
      )
    ).toEqual({
      id: "odd",
      path: "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444",
      label: "Odd project"
    });
  });

  it("builds no-project runtime sessions without parent project assignment", () => {
    const noProjectPath =
      "/Users/local/Documents/tutti/session-44444444-4444-4444-8444-444444444444";
    const snapshot: AgentHostWorkspaceAgentSnapshot = {
      presences: [],
      sessions: [
        workspaceAgentSession({
          agentSessionId: "no-project-session",
          cwd: noProjectPath,
          provider: "codex",
          title: "No project",
          updatedAtUnixMs: 10
        })
      ]
    };

    expect(
      buildAgentGUIConversationSummaries({
        isNoProjectPath: ({ path }) => path === noProjectPath,
        snapshot,
        provider: "codex",
        userProjects: [userProject("home", "/Users/local", "Home")]
      })
    ).toEqual([
      expect.objectContaining({
        id: "no-project-session",
        cwd: noProjectPath,
        project: null
      })
    ]);
  });

  it("keeps imported home-cwd sessions unassigned when external import marks no project", () => {
    const snapshot: WorkspaceAgentActivitySnapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          workspaceId: "workspace-1",
          agentSessionId: "imported-home-session",
          provider: "codex",
          providerSessionId: "imported-home-session",
          cwd: "/Users/local",
          title: "Imported scratch",
          status: "completed",
          runtimeContext: {
            imported: true,
            externalImportNoProject: true
          },
          createdAtUnixMs: 1,
          updatedAtUnixMs: 30
        }
      ],
      sessionMessagesById: {}
    };

    const summaries = buildAgentGUIConversationSummaries({
      snapshot,
      provider: "codex",
      userProjects: [userProject("home", "/Users/local", "Home")]
    });

    expect(summaries).toEqual([
      expect.objectContaining({
        id: "imported-home-session",
        isImported: true,
        project: null,
        projectMode: "none"
      })
    ]);
    expect(
      applyAgentGUIConversationProjects(summaries, [
        userProject("home", "/Users/local", "Home")
      ])
    ).toEqual([
      expect.objectContaining({
        id: "imported-home-session",
        project: null,
        projectMode: "none"
      })
    ]);
  });

  it("builds conversations only from runtime Codex sessions", () => {
    const snapshot: AgentHostWorkspaceAgentSnapshot = {
      presences: [],
      sessions: [
        workspaceAgentSession({
          agentSessionId: "runtime-codex",
          provider: "codex",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "Runtime Codex",
          updatedAtUnixMs: 30
        }),
        workspaceAgentSession({
          agentSessionId: "unknown-origin-codex",
          provider: "codex",
          sessionOrigin: "WORKSPACE_AGENT_SESSION_ORIGIN_UNKNOWN",
          title: "Unknown Origin Codex",
          updatedAtUnixMs: 40
        }),
        workspaceAgentSession({
          agentSessionId: "runtime-claude",
          provider: "claude-code",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "Claude",
          updatedAtUnixMs: 50
        })
      ]
    };

    expect(
      buildAgentGUIConversationSummaries({ snapshot, provider: "codex" })
    ).toEqual([
      expect.objectContaining({
        id: "runtime-codex",
        title: "Runtime Codex"
      })
    ]);
  });

  it("treats core-native sessions without legacy sessionOrigin as runtime sessions", () => {
    const snapshot: WorkspaceAgentActivitySnapshot = {
      workspaceId: "workspace-1",
      presences: [],
      sessions: [
        {
          workspaceId: "workspace-1",
          agentSessionId: "core-runtime-codex",
          provider: "codex",
          providerSessionId: "core-runtime-codex",
          cwd: "/workspace",
          title: "Core Runtime Codex",
          status: "completed",
          lastEventUnixMs: 30,
          createdAtUnixMs: 1,
          updatedAtUnixMs: 30
        }
      ],
      sessionMessagesById: {}
    };

    expect(
      buildAgentGUIConversationSummaries({ snapshot, provider: "codex" })
    ).toEqual([
      expect.objectContaining({
        id: "core-runtime-codex",
        title: "Core Runtime Codex"
      })
    ]);
  });

  it("orders runtime conversations by session sort time instead of message update time", () => {
    const snapshot: AgentHostWorkspaceAgentSnapshot = {
      presences: [],
      sessions: [
        workspaceAgentSession({
          agentSessionId: "older-start",
          provider: "codex",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "Older Start",
          createdAtUnixMs: 1_000,
          startedAtUnixMs: 1_000,
          updatedAtUnixMs: 9_000
        }),
        workspaceAgentSession({
          agentSessionId: "newer-start",
          provider: "codex",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "Newer Start",
          createdAtUnixMs: 2_000,
          startedAtUnixMs: 2_000,
          updatedAtUnixMs: 2_000
        })
      ]
    };

    const conversations = buildAgentGUIConversationSummaries({
      snapshot,
      provider: "codex",
      sessionMessagesById: {
        "older-start": [
          workspaceAgentMessage({
            id: 1,
            agentSessionId: "older-start",
            eventId: "late-message",
            role: "assistant",
            occurredAtUnixMs: 8_000
          })
        ]
      }
    });

    expect(conversations.map((conversation) => conversation.id)).toEqual([
      "newer-start",
      "older-start"
    ]);
    expect(conversations[1]).toMatchObject({
      id: "older-start",
      sortTimeUnixMs: 1_000,
      updatedAtUnixMs: 9_000
    });
  });

  it("indexes user project paths once when building conversation batches", () => {
    const snapshot: AgentHostWorkspaceAgentSnapshot = {
      presences: [],
      sessions: [
        workspaceAgentSession({
          agentSessionId: "one",
          cwd: "/workspace/app/packages/one",
          provider: "codex",
          title: "One",
          updatedAtUnixMs: 10
        }),
        workspaceAgentSession({
          agentSessionId: "two",
          cwd: "/workspace/app/packages/two",
          provider: "codex",
          title: "Two",
          updatedAtUnixMs: 20
        })
      ]
    };
    let archivePathReads = 0;
    const archiveProject: AgentGUIConversationUserProject = {
      id: "archive",
      get path() {
        archivePathReads += 1;
        return "/workspace/archive";
      },
      label: "Archive"
    };

    expect(
      buildAgentGUIConversationSummaries({
        snapshot,
        provider: "codex",
        userProjects: [
          userProject("app", "/workspace/app", "App"),
          archiveProject
        ]
      }).map((conversation) => conversation.project)
    ).toEqual([
      expect.objectContaining({ id: "app" }),
      expect.objectContaining({ id: "app" })
    ]);
    expect(archivePathReads).toBe(1);
  });

  it("applies conversation projects without mutating existing conversations", () => {
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Session",
      status: "ready" as const,
      cwd: "/workspace/app",
      project: null,
      updatedAtUnixMs: 1
    };
    const conversations = [conversation];

    const applied = applyAgentGUIConversationProjects(conversations, [
      userProject("app", "/workspace/app", "App")
    ]);

    expect(applied).toEqual([
      expect.objectContaining({
        id: "session-1",
        project: {
          id: "app",
          path: "/workspace/app",
          label: "App"
        }
      })
    ]);
    expect(conversation.project).toBeNull();
    expect(applied[0]).not.toBe(conversation);
  });

  it("selects the stored active conversation when it still exists", () => {
    const conversations = [
      {
        id: "newer",
        title: "Newer",
        titleFallback: null,
        provider: "codex" as const,
        status: "ready" as const,
        cwd: "",
        updatedAtUnixMs: 2
      },
      {
        id: "stored",
        title: "Stored",
        titleFallback: null,
        provider: "codex" as const,
        status: "ready" as const,
        cwd: "",
        updatedAtUnixMs: 1
      }
    ];

    expect(selectAgentGUIConversationId(conversations, "stored")).toBe(
      "stored"
    );
    expect(selectAgentGUIConversationId(conversations, "missing")).toBe(
      "newer"
    );
  });

  it("keeps provider-specific runtime sessions separated for Nexight, Hermes, and OpenClaw Agent GUI", () => {
    const snapshot: AgentHostWorkspaceAgentSnapshot = {
      presences: [],
      sessions: [
        workspaceAgentSession({
          agentSessionId: "nexight-session",
          provider: "nexight",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "Nexight Session",
          updatedAtUnixMs: 10
        }),
        workspaceAgentSession({
          agentSessionId: "hermes-session",
          provider: "hermes",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "Hermes Session",
          updatedAtUnixMs: 20
        }),
        workspaceAgentSession({
          agentSessionId: "openclaw-session",
          provider: "openclaw",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "OpenClaw Session",
          updatedAtUnixMs: 30
        })
      ]
    };

    expect(
      buildAgentGUIConversationSummaries({ snapshot, provider: "nexight" })
    ).toEqual([
      expect.objectContaining({
        id: "nexight-session",
        provider: "nexight"
      })
    ]);
    expect(
      buildAgentGUIConversationSummaries({ snapshot, provider: "hermes" })
    ).toEqual([
      expect.objectContaining({
        id: "hermes-session",
        provider: "hermes"
      })
    ]);
    expect(
      buildAgentGUIConversationSummaries({ snapshot, provider: "openclaw" })
    ).toEqual([
      expect.objectContaining({
        id: "openclaw-session",
        provider: "openclaw"
      })
    ]);
  });

  it("keeps runtime sessions whose provider can only be inferred from presence data", () => {
    const snapshot: AgentHostWorkspaceAgentSnapshot = {
      presences: [
        {
          id: 11,
          workspaceId: "room-1",
          userId: "user-1",
          provider: "claude-code",
          status: "active"
        }
      ],
      sessions: [
        workspaceAgentSession({
          agentSessionId: "presence-only-provider",
          presenceId: 11,
          provider: undefined,
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "Recovered from presence",
          updatedAtUnixMs: 10
        })
      ]
    };

    expect(
      buildAgentGUIConversationSummaries({ snapshot, provider: "claude-code" })
    ).toEqual([
      expect.objectContaining({
        id: "presence-only-provider",
        provider: "claude-code",
        title: "Recovered from presence"
      })
    ]);
  });

  it("builds restored conversation titles from cached runtime timelines", () => {
    const snapshot: AgentHostWorkspaceAgentSnapshot = {
      presences: [],
      sessions: [
        workspaceAgentSession({
          agentSessionId: "nexight-session",
          provider: "nexight",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "Nexight",
          updatedAtUnixMs: 30
        })
      ]
    };

    expect(
      buildAgentGUIConversationSummaries({
        snapshot,
        provider: "nexight",
        sessionMessagesById: {
          "nexight-session": [
            workspaceAgentMessage({
              id: 1,
              eventId: "user-1",
              actorType: "user",
              actorId: "user-1",
              itemType: "message.user",
              role: "user",
              payload: { content: "AAA" },
              occurredAtUnixMs: 10
            })
          ]
        }
      })
    ).toEqual([
      expect.objectContaining({
        id: "nexight-session",
        title: "AAA"
      })
    ]);
  });

  it("keeps explicit runtime session titles when cached messages are loaded", () => {
    const snapshot: AgentHostWorkspaceAgentSnapshot = {
      presences: [],
      sessions: [
        workspaceAgentSession({
          agentSessionId: "app-factory-session",
          provider: "codex",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "Create App: System Monitor",
          updatedAtUnixMs: 30
        })
      ]
    };

    expect(
      buildAgentGUIConversationSummaries({
        snapshot,
        provider: "codex",
        sessionMessagesById: {
          "app-factory-session": [
            workspaceAgentMessage({
              id: 1,
              eventId: "user-1",
              actorType: "user",
              actorId: "user-1",
              itemType: "message.user",
              role: "user",
              payload: {
                content:
                  "Create a local system dashboard inspired by btop. <tutti_app_factory_context>..."
              },
              occurredAtUnixMs: 10
            })
          ]
        }
      })
    ).toEqual([
      expect.objectContaining({
        id: "app-factory-session",
        title: "Create App: System Monitor"
      })
    ]);
  });

  it("keeps unknown-provider runtime sessions visible instead of dropping them", () => {
    const snapshot: AgentHostWorkspaceAgentSnapshot = {
      presences: [],
      sessions: [
        workspaceAgentSession({
          agentSessionId: "unknown-runtime-session",
          provider: undefined,
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          title: "123213",
          updatedAtUnixMs: 10
        })
      ]
    };

    expect(
      buildAgentGUIConversationSummaries({ snapshot, provider: "claude-code" })
    ).toEqual([
      expect.objectContaining({
        id: "unknown-runtime-session",
        provider: "unknown",
        title: "123213"
      })
    ]);
  });

  it("hides empty runtime placeholder sessions from Agent GUI conversation summaries", () => {
    const snapshot: AgentHostWorkspaceAgentSnapshot = {
      presences: [],
      sessions: [
        workspaceAgentSession({
          agentSessionId: "empty-runtime-session",
          provider: "claude-code",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          lifecycleStatus: "active",
          turnPhase: "idle",
          effectiveStatus: "idle",
          title: "Claude Code",
          updatedAtUnixMs: 20
        }),
        workspaceAgentSession({
          agentSessionId: "real-runtime-session",
          provider: "claude-code",
          sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
          lifecycleStatus: "completed",
          effectiveStatus: "completed",
          title: "Inspect project structure",
          updatedAtUnixMs: 10
        })
      ]
    };

    expect(
      buildAgentGUIConversationSummaries({
        snapshot,
        provider: "claude-code",
        sessionMessagesById: {
          "empty-runtime-session": []
        }
      })
    ).toEqual([
      expect.objectContaining({
        id: "real-runtime-session",
        title: "Inspect project structure"
      })
    ]);
  });

  it("preserves the session provider when a session has no explicit title", () => {
    expect(
      conversationSummaryFromAgentSession({
        workspaceId: "room-1",

        agentSessionId: "session-hermes",
        provider: "hermes",
        providerSessionId: "provider-session-hermes",
        cwd: "/workspace",
        status: "ready",
        createdAtUnixMs: 10,
        updatedAtUnixMs: 20
      })
    ).toEqual(
      expect.objectContaining({
        provider: "hermes",
        title: "Current task",
        titleFallback: null,
        updatedAtUnixMs: 20
      })
    );
  });

  it("derives a restored conversation title from the first user timeline message", () => {
    expect(
      resolveAgentGUIConversationTitleFromTimelineItems({
        conversation: {
          id: "session-1",
          provider: "nexight",
          title: "Nexight",
          titleFallback: null,
          status: "completed",
          cwd: "/workspace",
          updatedAtUnixMs: 30
        },
        timelineItems: [
          timelineItem({
            id: 2,
            eventId: "assistant-1",
            actorType: "agent",
            actorId: "nexight",
            itemType: "message.assistant",
            role: "assistant",
            content: "Done",
            occurredAtUnixMs: 20
          }),
          timelineItem({
            id: 1,
            eventId: "user-1",
            actorType: "user",
            actorId: "user-1",
            itemType: "message.user",
            role: "user",
            payload: {
              displayPrompt: "Run Automation",
              text: "long automation prompt",
              content: "long automation prompt"
            },
            occurredAtUnixMs: 10
          })
        ]
      })
    ).toEqual({
      title: "Run Automation",
      titleFallback: null
    });
  });

  it("keeps an explicit conversation title when timeline messages load", () => {
    expect(
      resolveAgentGUIConversationTitleFromTimelineItems({
        conversation: {
          id: "session-1",
          provider: "codex",
          title: "Create App: System Monitor",
          titleFallback: null,
          status: "completed",
          cwd: "/workspace",
          updatedAtUnixMs: 30
        },
        timelineItems: [
          timelineItem({
            id: 1,
            eventId: "user-1",
            actorType: "user",
            actorId: "user-1",
            itemType: "message.user",
            role: "user",
            payload: {
              text: "Create a local system dashboard inspired by btop. <tutti_app_factory_context>..."
            },
            occurredAtUnixMs: 10
          })
        ]
      })
    ).toBeNull();
  });

  it("keeps explicit conversation titles in detail and conversation projections", () => {
    const conversation = {
      id: "session-1",
      provider: "codex" as const,
      title: "Create App: System Monitor",
      titleFallback: null,
      status: "completed" as const,
      cwd: "/workspace",
      updatedAtUnixMs: 30
    };
    const timelineItems = [
      timelineItem({
        id: 1,
        eventId: "user-1",
        actorType: "user",
        actorId: "user-1",
        itemType: "message.user",
        role: "user",
        payload: {
          text: "Create a local system dashboard inspired by btop. <tutti_app_factory_context>..."
        },
        occurredAtUnixMs: 10
      }),
      timelineItem({
        id: 2,
        eventId: "assistant-1",
        actorType: "agent",
        actorId: "codex",
        itemType: "message.assistant",
        role: "assistant",
        payload: { text: "Done." },
        occurredAtUnixMs: 20
      })
    ];

    const detail = buildAgentGUIConversationDetail({
      timelineItems,
      conversation,
      workspaceRoot: "/workspace"
    });
    const projected = buildAgentGUIConversationVM({
      timelineItems,
      conversation,
      workspaceRoot: "/workspace"
    });

    expect(detail?.activity.title).toBe("Create App: System Monitor");
    expect(projected?.activity.title).toBe("Create App: System Monitor");
  });

  it("builds timeline rows from ordered timeline items", () => {
    const rows = buildAgentGUITimelineRows([
      timelineItem({
        id: 2,
        eventId: "assistant-1",
        actorType: "agent",
        actorId: "codex",
        itemType: "message",
        role: "assistant",
        content: "Done",
        occurredAtUnixMs: 20
      }),
      timelineItem({
        id: 1,
        eventId: "user-1",
        actorType: "user",
        actorId: "user-1",
        itemType: "message",
        role: "user",
        payload: { content: "Please fix it" },
        occurredAtUnixMs: 10
      })
    ]);

    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ["user", "Please fix it"],
      ["assistant", "Done"]
    ]);
  });

  it("filters placeholder assistant thinking rows rendered as ellipsis", () => {
    const rows = buildAgentGUITimelineRows([
      timelineItem({
        id: 1,
        eventId: "user-1",
        turnId: "turn-1",
        actorType: "user",
        actorId: "user-1",
        itemType: "message.user",
        role: "user",
        content: "Please inspect the other session.",
        occurredAtUnixMs: 10
      }),
      timelineItem({
        id: 2,
        eventId: "thinking-1",
        turnId: "turn-1",
        actorType: "agent",
        actorId: "claude-code",
        itemType: "message.assistant_thinking",
        role: "assistant_thinking",
        content: "...",
        occurredAtUnixMs: 20
      }),
      timelineItem({
        id: 3,
        eventId: "assistant-1",
        turnId: "turn-1",
        actorType: "agent",
        actorId: "claude-code",
        itemType: "message.assistant",
        role: "assistant",
        content: "I checked it and summarized the result.",
        occurredAtUnixMs: 30
      })
    ]);

    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ["user", "Please inspect the other session."],
      ["assistant", "I checked it and summarized the result."]
    ]);
  });

  it("derives pending approval from ACP call.started approval timeline items", () => {
    const conversation = buildAgentGUIConversationVM({
      conversation: {
        id: "session-1",
        provider: "codex",
        title: "Codex",
        titleFallback: null,
        status: "waiting",
        cwd: "/workspace",
        updatedAtUnixMs: 2
      },
      workspaceRoot: "/workspace",
      timelineItems: [
        timelineItem({
          id: 10,
          eventId: "user-1",
          actorType: "user",
          actorId: "codex",
          itemType: "message.user",
          role: "user",
          payload: { text: "看看项目有什么文件" },
          occurredAtUnixMs: 10
        }),
        timelineItem({
          id: 11,
          eventId: "approval-1",
          actorType: "agent",
          actorId: "codex",
          itemType: "call.started",
          role: "assistant",
          callType: "approval",
          callId: "call_ySuHUYSLqzwC2DXTSZk2hNbk",
          name: "tutti-cli --help",
          status: "waiting_approval",
          payload: {
            callId: "call_ySuHUYSLqzwC2DXTSZk2hNbk",
            callType: "approval",
            input: {
              requestId: "4a3caced-db7a-4a15-9e7a-4ebbf5d61616",
              options: [
                {
                  label: "Legacy allow label",
                  kind: "allow_once",
                  name: "Yes, proceed",
                  optionId: "approved"
                },
                {
                  label: "Legacy abort label",
                  kind: "reject_once",
                  name: "No, and tell Codex what to do differently",
                  optionId: "abort"
                }
              ]
            },
            status: "waiting_approval"
          },
          occurredAtUnixMs: 11
        })
      ]
    });

    expect(conversation?.pendingApproval).toEqual(
      expect.objectContaining({
        requestId: "4a3caced-db7a-4a15-9e7a-4ebbf5d61616",
        callId: "call_ySuHUYSLqzwC2DXTSZk2hNbk",
        status: "waiting_approval",
        options: [
          expect.objectContaining({ id: "approved", label: "Yes, proceed" }),
          expect.objectContaining({
            id: "abort",
            label: "No, and tell Codex what to do differently"
          })
        ]
      })
    );
  });

  it("merges local and remote timeline rows without duplicating rows", () => {
    expect(
      mergeAgentGUITimelineRows(
        [
          {
            id: "event:1",
            turnId: "",
            role: "agent",
            content: "session.started",
            eventType: "session.started",
            status: "ready",
            occurredAtUnixMs: 1
          }
        ],
        [
          {
            id: "event:1",
            turnId: "",
            role: "agent",
            content: "session.started",
            eventType: "session.started",
            status: "ready",
            occurredAtUnixMs: 1
          }
        ]
      )
    ).toHaveLength(1);
  });

  it("merges live and remote user message rows by event id when server id changes", () => {
    const liveRows = buildAgentGUITimelineRows([
      timelineItem({
        id: 0,
        eventId: "user-message-1",
        turnId: "turn-1",
        actorType: "user",
        actorId: "user-1",
        itemType: "message",
        role: "user",
        content: "Please fix it",
        occurredAtUnixMs: 10
      })
    ]);
    const remoteRows = buildAgentGUITimelineRows([
      timelineItem({
        id: 42,
        eventId: "user-message-1",
        turnId: "turn-1",
        actorType: "user",
        actorId: "user-1",
        itemType: "message",
        role: "user",
        content: "Please fix it",
        occurredAtUnixMs: 10
      })
    ]);

    expect(mergeAgentGUITimelineRows(liveRows, remoteRows)).toEqual([
      expect.objectContaining({
        id: "event:user-message-1",
        role: "user",
        content: "Please fix it"
      })
    ]);
  });

  it("drops an optimistic local prompt once the durable user timeline item arrives", () => {
    expect(
      mergeAgentGUITimelineItems(
        [
          {
            id: -1,
            workspaceId: "room-1",
            agentSessionId: "session-1",
            turnId: "turn-2",
            seq: 0,
            eventId: "optimistic:user:turn-2",
            actorType: "user",
            actorId: "user-1",
            itemType: "message.user",
            role: "user",
            content: "New ask",
            payload: {
              __agentGuiOptimisticPrompt: true
            },
            occurredAtUnixMs: 20,
            createdAtUnixMs: 20
          }
        ],
        [
          {
            id: 22,
            workspaceId: "room-1",
            agentSessionId: "session-1",
            turnId: "turn-2",
            seq: 3,
            eventId: "user-message-2",
            actorType: "user",
            actorId: "user-1",
            itemType: "message.user",
            role: "user",
            content: "New ask",
            occurredAtUnixMs: 21,
            createdAtUnixMs: 21
          }
        ]
      )
    ).toEqual([
      expect.objectContaining({
        eventId: "user-message-2",
        turnId: "turn-2",
        content: "New ask"
      })
    ]);
  });

  it("keeps distinct user prompts from different turns when event ids are missing but seq matches", () => {
    expect(
      mergeAgentGUITimelineItems(
        [
          {
            id: 101,
            workspaceId: "room-1",
            agentSessionId: "session-1",
            turnId: "turn-1",
            seq: 1,
            eventId: "",
            actorType: "user",
            actorId: "user-1",
            itemType: "message.user",
            role: "user",
            content: "你好？",
            occurredAtUnixMs: 100,
            createdAtUnixMs: 100
          }
        ],
        [
          {
            id: 102,
            workspaceId: "room-1",
            agentSessionId: "session-1",
            turnId: "turn-2",
            seq: 1,
            eventId: "",
            actorType: "user",
            actorId: "user-1",
            itemType: "message.user",
            role: "user",
            content: "继续后续变更",
            occurredAtUnixMs: 200,
            createdAtUnixMs: 200
          }
        ]
      )
    ).toEqual([
      expect.objectContaining({
        turnId: "turn-1",
        content: "你好？"
      }),
      expect.objectContaining({
        turnId: "turn-2",
        content: "继续后续变更"
      })
    ]);
  });

  it("does not overwrite rich tool output with shallow status updates", () => {
    const merged = mergeAgentGUITimelineItems(
      [
        timelineItem({
          id: 11,
          eventId: "call-event-1",
          turnId: "turn-1",
          itemType: "call",
          callType: "tool",
          callId: "tool-1",
          name: "Run command",
          status: "completed",
          payload: {
            output: {
              stdout: "README.md\n"
            }
          },
          occurredAtUnixMs: 20,
          createdAtUnixMs: 20
        })
      ],
      [
        timelineItem({
          id: 0,
          eventId: "call-event-1",
          turnId: "turn-1",
          itemType: "call",
          callType: "tool",
          callId: "tool-1",
          name: "Run command",
          status: "completed",
          payload: {
            output: {
              sessionUpdate: "tool_call_update",
              status: "completed",
              toolCallId: "tool-1"
            }
          },
          occurredAtUnixMs: 21,
          createdAtUnixMs: 21
        })
      ]
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]!.payload?.output).toEqual({
      stdout: "README.md\n",
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolCallId: "tool-1"
    });
  });

  it("moves streaming assistant messages to their latest upsert timestamp", () => {
    const merged = mergeAgentGUITimelineItems(
      [
        timelineItem({
          id: 0,
          eventId: "assistant-message-1",
          turnId: "turn-1",
          itemType: "message.assistant",
          role: "assistant",
          content: "I will check it.",
          occurredAtUnixMs: 100,
          createdAtUnixMs: 100
        }),
        timelineItem({
          id: 0,
          eventId: "tool-call-1",
          turnId: "turn-1",
          itemType: "call.errored",
          callType: "tool",
          callId: "call-1",
          name: "Read",
          status: "errored",
          occurredAtUnixMs: 200,
          createdAtUnixMs: 200
        })
      ],
      [
        timelineItem({
          id: 0,
          eventId: "assistant-message-1",
          turnId: "turn-1",
          itemType: "message.assistant",
          role: "assistant",
          content: "I will check it. Done.",
          occurredAtUnixMs: 300,
          createdAtUnixMs: 300
        })
      ]
    );

    expect(merged.map((item) => item.itemType)).toEqual([
      "call.errored",
      "message.assistant"
    ]);
    expect(merged[1]).toEqual(
      expect.objectContaining({
        eventId: "assistant-message-1",
        content: "I will check it. Done.",
        occurredAtUnixMs: 300
      })
    );
  });

  it("builds an empty detail shell for conversations without transcript items yet", () => {
    const detail = buildAgentGUIConversationDetail({
      timelineItems: [],
      conversation: {
        id: "claude-session-1",
        provider: "claude-code",
        title: "Claude Code",
        titleFallback: null,
        status: "working",
        cwd: "/workspace",
        updatedAtUnixMs: 10,
        syncState: {
          agentSessionId: "claude-session-1",
          status: "synced"
        }
      },
      workspaceRoot: "/workspace"
    });

    expect(detail).toEqual(
      expect.objectContaining({
        cwd: "/workspace",
        workspaceRoot: "/workspace",
        turns: []
      })
    );
    expect(detail?.activity.status).toBe("working");
    expect(detail?.session.effectiveStatus).toBe("working");
    expect(detail?.session.agentSessionId).toBe("claude-session-1");
    expect(detail?.session.providerSessionId).toBe("claude-session-1");
    expect(detail?.session.updatedAtUnixMs).toBe(10);
  });

  it("keeps the conversation provider when the timeline starts with a user message", () => {
    const detail = buildAgentGUIConversationDetail({
      timelineItems: [
        timelineItem({
          id: 1,
          eventId: "user-1",
          actorType: "user",
          actorId: "user-1",
          itemType: "message.user",
          role: "user",
          content: "Please fix it",
          occurredAtUnixMs: 10
        })
      ],
      conversation: {
        id: "session-1",
        provider: "claude-code",
        title: "Claude Code",
        titleFallback: null,
        status: "working",
        cwd: "/workspace",
        updatedAtUnixMs: 10
      },
      workspaceRoot: "/workspace"
    });

    expect(detail?.session.provider).toBe("claude-code");
  });

  it("extracts ask-user interactive prompts from timeline items", () => {
    expect(
      selectPendingInteractivePromptFromTimelineItems([
        {
          id: 1,
          workspaceId: "room-1",
          agentSessionId: "session-1",
          seq: 1,
          eventId: "call-1",
          actorType: "agent",
          actorId: "codex",
          itemType: "call.started",
          role: "assistant",
          callType: "interactive",
          callId: "call-1",
          name: "AskUserQuestion",
          status: "waiting",
          payload: {
            requestId: "request-ask",
            input: {
              questions: [
                {
                  id: "scope",
                  header: "Scope",
                  question: "Which scope should we use?",
                  options: [{ label: "Small", description: "Minimal change" }]
                }
              ]
            }
          },
          occurredAtUnixMs: 10,
          createdAtUnixMs: 10
        }
      ])
    ).toEqual(
      expect.objectContaining({
        kind: "ask-user",
        requestId: "request-ask"
      })
    );
  });

  it("treats waiting_input interactive timeline items as pending prompts", () => {
    expect(
      selectPendingInteractivePromptFromTimelineItems([
        {
          id: 1,
          workspaceId: "room-1",
          agentSessionId: "session-1",
          seq: 1,
          eventId: "call-1",
          actorType: "agent",
          actorId: "codex",
          itemType: "call.started",
          role: "assistant",
          callType: "interactive",
          callId: "call-1",
          name: "ExitPlanMode",
          status: "waiting_input",
          payload: {
            requestId: "request-exit",
            input: {
              plan: "# Plan"
            }
          },
          occurredAtUnixMs: 10,
          createdAtUnixMs: 10
        }
      ])
    ).toEqual(
      expect.objectContaining({
        kind: "exit-plan",
        requestId: "request-exit"
      })
    );
  });

  it("treats switch-mode approval timeline items as exit-plan prompts", () => {
    const item: AgentHostWorkspaceAgentTimelineItem = {
      id: 1,
      workspaceId: "room-1",
      agentSessionId: "session-1",
      seq: 1,
      eventId: "call-1",
      actorType: "agent",
      actorId: "claude-code",
      itemType: "call.started",
      role: "assistant",
      callType: "approval",
      callId: "call-1",
      name: "Approval",
      status: "waiting_approval",
      payload: {
        input: {
          requestId: "0",
          toolCall: {
            kind: "switch_mode",
            title: "Ready to code?",
            toolCallId: "call-1"
          },
          options: [
            { kind: "allow_once", name: "Yes", optionId: "default" },
            {
              kind: "reject_once",
              name: "No, keep planning",
              optionId: "plan"
            }
          ]
        }
      },
      occurredAtUnixMs: 10,
      createdAtUnixMs: 10
    };

    expect(selectPendingApprovalFromTimelineItems([item])).toBeNull();
    expect(selectPendingInteractivePromptFromTimelineItems([item])).toEqual(
      expect.objectContaining({
        kind: "exit-plan",
        requestId: "0",
        title: "Ready to code?"
      })
    );
  });

  it("selects the newest waiting approval from timeline item ordering instead of request id sort order", () => {
    const approval = selectPendingApprovalFromTimelineItems([
      {
        id: 1,
        workspaceId: "room-1",
        agentSessionId: "session-1",
        turnId: "turn-1",
        seq: 10,
        eventId: "approval-old",
        actorType: "agent",
        actorId: "codex",
        itemType: "approval.requested",
        callType: "approval",
        callId: "approval-1",
        name: "First approval",
        status: "waiting_approval",
        payload: {
          input: {
            requestId: "request-z",
            options: [
              { id: "allow_once", label: "Allow once", kind: "allow_once" }
            ]
          }
        },
        occurredAtUnixMs: 100,
        createdAtUnixMs: 100
      },
      {
        id: 2,
        workspaceId: "room-1",
        agentSessionId: "session-1",
        turnId: "turn-2",
        seq: 11,
        eventId: "approval-new",
        actorType: "agent",
        actorId: "codex",
        itemType: "approval.requested",
        callType: "approval",
        callId: "approval-2",
        name: "Second approval",
        status: "waiting_approval",
        payload: {
          input: {
            requestId: "request-a",
            options: [{ id: "deny", label: "Deny", kind: "deny" }]
          }
        },
        occurredAtUnixMs: 200,
        createdAtUnixMs: 200
      }
    ]);

    expect(approval).toEqual(
      expect.objectContaining({
        requestId: "request-a",
        callId: "approval-2",
        title: "Second approval"
      })
    );
  });

  it("accepts durable awaiting_approval statuses when projecting pending approval chrome", () => {
    const approval = selectPendingApprovalFromTimelineItems([
      {
        id: 1,
        workspaceId: "room-1",
        agentSessionId: "session-1",
        turnId: "turn-1",
        seq: 10,
        eventId: "approval-durable",
        actorType: "agent",
        actorId: "codex",
        itemType: "approval.requested",
        callType: "approval",
        callId: "approval-1",
        name: "Run command",
        status: "awaiting_approval",
        payload: {
          input: {
            requestId: "request-1",
            options: [
              { id: "allow_once", label: "Allow once", kind: "allow_once" }
            ]
          }
        },
        occurredAtUnixMs: 100,
        createdAtUnixMs: 100
      }
    ]);

    expect(approval).toEqual(
      expect.objectContaining({
        requestId: "request-1",
        callId: "approval-1",
        title: "Run command"
      })
    );
  });

  it("replaces streaming message snapshots with the latest content for the same event id", () => {
    const rows = buildAgentGUITimelineRows([
      timelineItem({
        id: 1,
        eventId: "assistant-1",
        turnId: "turn-1",
        actorType: "agent",
        actorId: "codex",
        itemType: "message",
        role: "assistant",
        content: "Hel",
        status: "streaming",
        occurredAtUnixMs: 10
      }),
      timelineItem({
        id: 2,
        eventId: "assistant-1",
        turnId: "turn-1",
        actorType: "agent",
        actorId: "codex",
        itemType: "message",
        role: "assistant",
        content: "Hello",
        status: "completed",
        occurredAtUnixMs: 11
      })
    ]);

    expect(rows.map((row) => [row.content, row.status])).toEqual([
      ["Hello", "completed"]
    ]);
  });

  it("merges live tool call timeline items by call id", () => {
    const rows = buildAgentGUITimelineRows([
      timelineItem({
        id: 1,
        eventId: "tool-started",
        turnId: "turn-1",
        itemType: "call",
        callType: "tool",
        callId: "call-1",
        name: "tsh-agent-activity active-peers",
        content: "tsh-agent-activity active-peers",
        status: "streaming",
        occurredAtUnixMs: 12
      }),
      timelineItem({
        id: 2,
        eventId: "tool-completed",
        turnId: "turn-1",
        itemType: "call",
        callType: "tool",
        callId: "call-1",
        name: "tsh-agent-activity active-peers",
        content: "tsh-agent-activity active-peers",
        status: "completed",
        occurredAtUnixMs: 20
      })
    ]);

    expect(
      rows.map((row) => [row.id, row.role, row.content, row.status])
    ).toEqual([
      [
        "call:turn-1:call-1",
        "tool",
        "tsh-agent-activity active-peers",
        "completed"
      ]
    ]);
  });

  it("prefers the canonical tool label when tool summary is only an opaque Call Function title", () => {
    const rows = buildAgentGUITimelineRows([
      timelineItem({
        id: 1,
        eventId: "tool-completed",
        turnId: "turn-1",
        itemType: "call.completed",
        callType: "tool",
        callId: "call-opaque-tool",
        name: "Call Function Jmcg9irmt39q 2",
        status: "completed",
        payload: {
          acp: {
            sessionUpdate: "tool_call_update",
            kind: "execute"
          },
          kind: "execute",
          toolName: "Jmcg9irmt39q"
        },
        occurredAtUnixMs: 20
      })
    ]);

    expect(rows.map((row) => [row.role, row.content, row.status])).toEqual([
      ["tool", "Run command", "completed"]
    ]);
  });

  it("builds pending approval rows from live timeline items", () => {
    const rows = buildAgentGUITimelineRows([
      timelineItem({
        id: 1,
        eventId: "approval-started",
        turnId: "turn-1",
        itemType: "call",
        callType: "approval",
        callId: "approval-1",
        name: "Run command",
        content: "Run command",
        status: "waiting_approval",
        payload: {
          status: "waiting_approval",
          input: {
            requestId: "request-1",
            options: [
              {
                optionId: "allow_once",
                label: "Allow once",
                kind: "allow_once"
              }
            ]
          }
        },
        occurredAtUnixMs: 12
      })
    ]);

    expect(selectPendingApproval(rows)).toEqual(
      expect.objectContaining({
        kind: "approval",
        id: expect.any(String),
        turnId: "turn-1",
        requestId: "request-1",
        callId: "approval-1",
        title: "Run command",
        status: "waiting_approval",
        toolName: "Run command",
        input: {
          requestId: "request-1",
          options: [
            { optionId: "allow_once", label: "Allow once", kind: "allow_once" }
          ]
        },
        options: [
          { id: "allow_once", label: "Allow once", kind: "allow_once" }
        ],
        output: null,
        occurredAtUnixMs: 12
      })
    );
  });

  it("clears pending approval when a resolved call snapshot arrives", () => {
    const rows = buildAgentGUITimelineRows([
      timelineItem({
        id: 1,
        eventId: "approval-started",
        turnId: "turn-1",
        itemType: "call",
        callType: "approval",
        callId: "approval-1",
        name: "Run command",
        content: "Run command",
        status: "waiting_approval",
        payload: {
          status: "waiting_approval",
          input: {
            requestId: "request-1",
            options: [{ optionId: "allow_once", label: "Allow once" }]
          }
        },
        occurredAtUnixMs: 12
      }),
      timelineItem({
        id: 2,
        eventId: "approval-completed",
        turnId: "turn-1",
        itemType: "call",
        callType: "approval",
        callId: "approval-1",
        name: "Run command",
        content: "Run command",
        status: "completed",
        payload: {
          status: "completed",
          output: {
            requestId: "request-1",
            selectedId: "allow_once"
          }
        },
        occurredAtUnixMs: 14
      })
    ]);

    expect(selectPendingApproval(rows)).toBeNull();
  });

  it("does not assemble assistant chunks in the renderer", () => {
    const rows = buildAgentGUITimelineRows([
      timelineItem({
        id: 1,
        eventId: "chunk-1",
        turnId: "turn-1",
        itemType: "message",
        role: "assistant",
        content: "Hi",
        occurredAtUnixMs: 10
      }),
      timelineItem({
        id: 2,
        eventId: "chunk-2",
        turnId: "turn-1",
        itemType: "message",
        role: "assistant",
        content: " there.",
        occurredAtUnixMs: 11
      })
    ]);

    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ["assistant", "Hi"],
      ["assistant", "there."]
    ]);
  });

  it("drops transient agent.responding activity items from Agent GUI timeline state", () => {
    const items = buildAgentGUITimelineItems([
      timelineItem({
        id: 1,
        eventId: "responding-1",
        turnId: "turn-1",
        itemType: "activity.completed",
        role: "assistant",
        payload: {
          metadata: {
            activityKind: "responding"
          }
        },
        occurredAtUnixMs: 10
      })
    ]);

    expect(items).toEqual([]);
  });
});

function timelineItem(
  overrides: Partial<AgentHostWorkspaceAgentTimelineItem> & {
    id: number;
    eventId: string;
  }
): AgentHostWorkspaceAgentTimelineItem {
  return {
    workspaceId: "room-1",
    agentSessionId: "session-1",
    actorType: "agent",
    actorId: "codex",
    itemType: "event",
    occurredAtUnixMs: overrides.id,
    createdAtUnixMs: overrides.id,
    ...overrides
  };
}

function workspaceAgentMessage(
  overrides: Partial<AgentHostWorkspaceAgentMessage> & {
    id: number;
    eventId?: string;
    content?: string;
    actorType?: string;
    actorId?: string;
    itemType?: string;
  }
): AgentHostWorkspaceAgentMessage {
  const payload = overrides.payload ?? {};
  return {
    id: overrides.id,
    agentSessionId: overrides.agentSessionId ?? "session-1",
    messageId:
      overrides.messageId ?? overrides.eventId ?? `message-${overrides.id}`,
    version: overrides.version ?? overrides.id,
    turnId: overrides.turnId ?? `turn-${overrides.id}`,
    role: overrides.role ?? "user",
    kind: overrides.kind ?? "message",
    ...(overrides.status ? { status: overrides.status } : {}),
    payload: {
      ...payload,
      content: payload.content ?? overrides.content,
      text: payload.text ?? overrides.content
    },
    occurredAtUnixMs: overrides.occurredAtUnixMs ?? overrides.id,
    startedAtUnixMs: overrides.startedAtUnixMs,
    completedAtUnixMs: overrides.completedAtUnixMs
  };
}

function workspaceAgentSession(
  overrides: Partial<AgentHostWorkspaceAgentSession> & {
    sessionOrigin?: string;
    createdAtUnixMs?: number;
    updatedAtUnixMs?: number;
  }
): AgentHostWorkspaceAgentSession {
  return {
    id: 1,
    agentSessionId: "session-1",
    presenceId: 1,
    userId: "user-1",
    provider: "codex",
    providerSessionId: "provider-session-1",
    sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
    cwd: "/workspace",
    lifecycleStatus: "active",
    turnPhase: "idle",
    effectiveStatus: "ready",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
    ...overrides
  } as AgentHostWorkspaceAgentSession;
}

function userProject(id: string, path: string, label: string) {
  return {
    id,
    path,
    label
  };
}
