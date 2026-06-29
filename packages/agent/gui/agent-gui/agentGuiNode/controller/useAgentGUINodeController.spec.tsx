import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "@tutti-os/ui-system";
import type {
  AgentActivityComposerOptions,
  AgentActivityMessage,
  AgentActivityMessageOrder,
  AgentActivityMessagePage,
  AgentActivitySession,
  AgentActivitySnapshot
} from "@tutti-os/agent-activity-core";
import type {
  AgentHostAgentActivityStreamEvent,
  AgentHostAgentSession,
  AgentHostActivateAgentSessionInput,
  AgentHostActivateAgentSessionResult,
  AgentHostAgentSessionState,
  AgentHostEvent,
  AgentHostWorkspaceAgentMessage,
  AgentHostWorkspaceAgentSession,
  AgentHostWorkspaceAgentSnapshot,
  AgentHostWorkspaceAgentTimelineItem,
  AgentPromptContentBlock
} from "../../../shared/contracts/dto";
import type {
  AgentActivityRuntime,
  AgentActivityRuntimeRetainSessionEventsInput
} from "../../../agentActivityRuntime";
import { setAgentGuiI18nTestLocale } from "../../../i18n/testUtils";
import { useAccountStore } from "../../../host/agentHostAccountStore";
import {
  getAgentSessionView,
  resetAgentSessionViewStoreForTests
} from "../../../contexts/workspace/presentation/renderer/agentSessions/agentSessionViewStore";
import {
  getAgentGUIConversationListStoreSnapshot,
  resetAgentGUIConversationListStoreForTests
} from "../../../contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore";
import { createAppError } from "../../../shared/errors/appError";
import type { AgentGUINodeData } from "../../../types";
import { AGENT_GUI_RUNTIME_SESSION_ORIGIN } from "../model/agentGuiConversationModel";
import {
  resolveConversationStatusAfterTimelineUpdate,
  resolveConversationUpdatedAtUnixMsFromSessionState,
  syncStateRenderFieldsEqual,
  useAgentGUINodeController
} from "./useAgentGUINodeController";
vi.mock("@tutti-os/ui-system", () => ({
  toast: {
    error: vi.fn()
  }
}));

type CallableMock = (...args: any[]) => any;
let emitRuntimeSessionEventForTests:
  | ((event: AgentHostAgentActivityStreamEvent) => void)
  | undefined;

function promptBlocks(text: string) {
  return [{ type: "text" as const, text }];
}

function draftContent(text: string) {
  return { prompt: text, images: [] };
}

function queuedPromptTexts(
  queuedPrompts: readonly { content: AgentPromptContentBlock[] }[]
): string[] {
  return queuedPrompts.map((item) =>
    item.content
      .filter((block) => block.type === "text")
      .map((block) => block.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
  );
}

function conversationBodies(viewModel: {
  conversationDetail?: {
    turns: readonly {
      agentMessages: readonly { body?: string }[];
      userMessages: readonly { body?: string }[];
    }[];
  } | null;
}): string[] {
  return (
    viewModel.conversationDetail?.turns.flatMap((turn) => [
      ...turn.userMessages.map((message) => message.body ?? ""),
      ...turn.agentMessages.map((message) => message.body ?? "")
    ]) ?? []
  ).filter(Boolean);
}

function conversationMessageRows(viewModel: {
  conversation?: {
    rows: readonly {
      kind: string;
      speaker?: string;
      messages?: readonly { body?: string }[];
    }[];
  } | null;
}): Array<{ speaker: string; body: string }> {
  return (
    viewModel.conversation?.rows.flatMap((row) => {
      if (row.kind !== "message" || !row.speaker || !row.messages) {
        return [];
      }
      return row.messages
        .map((message) => message.body?.trim() ?? "")
        .filter(Boolean)
        .map((body) => ({ speaker: row.speaker!, body }));
    }) ?? []
  );
}

function promptContent(text: string): { content: AgentPromptContentBlock[] } {
  return { content: promptBlocks(text) };
}

function initialPromptContent(text: string): {
  initialContent: AgentPromptContentBlock[];
} {
  return { initialContent: promptBlocks(text) };
}

describe("useAgentGUINodeController", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    useAccountStore.getState().clear();
    resetAgentSessionViewStoreForTests();
    resetAgentGUIConversationListStoreForTests();
    vi.mocked(toast.error).mockClear();
    emitRuntimeSessionEventForTests = undefined;
    delete (window as { agentHostApi?: unknown }).agentHostApi;
    installNoopAgentActivityRuntimeForTests();
    void setAgentGuiI18nTestLocale("en");
  });

  it("does not reload conversations after persisting the active conversation hint", async () => {
    const list = vi.fn(async () => snapshotWithSession("session-1"));
    const listSessionTimeline = vi.fn(async () => ({ timelineItems: [] }));
    const subscribeEvents = vi.fn(() => vi.fn());
    installAgentHostApi({
      list,
      listSessionTimeline,
      subscribeEvents
    });

    const onDataChange = vi.fn();
    const { rerender } = renderHook(
      (props) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          ...props
        }),
      {
        initialProps: {
          data: agentGuiData(null),
          onDataChange
        }
      }
    );

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1);
    });
    expect(list).toHaveBeenCalledWith({
      workspaceId: "room-1",
      sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
      userId: "user-1"
    });
    rerender({
      data: agentGuiData("session-1"),
      onDataChange: vi.fn()
    });

    await Promise.resolve();

    expect(list).toHaveBeenCalledTimes(1);
  });

  it("loads user projects and reprojects conversations after project updates", async () => {
    let userProjectListener: (() => void) | null = null;
    let userProjects = [
      {
        id: "app",
        path: "/workspace/app",
        label: "App"
      }
    ];
    const listUserProjects = vi.fn(async () => ({
      projects: userProjects
    }));
    const subscribeUserProjects = vi.fn((listener: () => void) => {
      userProjectListener = listener;
      return vi.fn();
    });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            cwd: "/workspace/app/packages/web"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      userProjects: {
        list: listUserProjects,
        subscribe: subscribeUserProjects,
        use: vi.fn()
      }
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversations[0]?.project).toEqual({
        id: "app",
        path: "/workspace/app",
        label: "App"
      });
    });
    expect(listUserProjects).toHaveBeenCalled();
    expect(subscribeUserProjects).toHaveBeenCalled();

    // Storm guard: `project` is a per-window JOIN derived in the view-model
    // layer only. Writing it back into the shared conversation store caused
    // cross-window update storms, so the canonical store must stay project-free
    // even though the view model exposes a resolved project above.
    const storedConversation = Object.values(
      getAgentGUIConversationListStoreSnapshot().statesByQueryKey
    )
      .flatMap((state) => state.conversations)
      .find((candidate) => candidate.id === "session-1");
    expect(storedConversation).toBeDefined();
    // The store may carry null (loader) or undefined, but never a resolved
    // project object — that only lives in the view-model layer.
    expect(storedConversation?.project ?? null).toBeNull();

    userProjects = [
      ...userProjects,
      {
        id: "web",
        path: "/workspace/app/packages/web",
        label: "Web"
      }
    ];
    await act(async () => {
      userProjectListener?.();
    });

    await waitFor(() => {
      expect(result.current.viewModel.conversations[0]?.project).toEqual({
        id: "web",
        path: "/workspace/app/packages/web",
        label: "Web"
      });
    });
  });

  it("keeps the visible conversation list reference for equal project reloads", async () => {
    let userProjectListener: (() => void) | null = null;
    let userProjects = [
      {
        id: "app",
        path: "/workspace/app",
        label: "App"
      }
    ];
    const listUserProjects = vi.fn(async () => ({
      projects: userProjects
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            cwd: "/workspace/app"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      userProjects: {
        list: listUserProjects,
        subscribe: vi.fn((listener: () => void) => {
          userProjectListener = listener;
          return vi.fn();
        }),
        use: vi.fn()
      }
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversations[0]?.project).toEqual({
        id: "app",
        path: "/workspace/app",
        label: "App"
      });
    });
    const previousConversations = result.current.viewModel.conversations;

    userProjects = [{ id: "app", path: "/workspace/app", label: "App" }];
    await act(async () => {
      userProjectListener?.();
    });

    await waitFor(() => {
      expect(listUserProjects).toHaveBeenCalledTimes(2);
    });
    expect(result.current.viewModel.conversations).toBe(previousConversations);
  });

  it("keeps stable composer child references when only the selected project changes", async () => {
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: []
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions: vi.fn(async () => ({
        provider: "codex",
        effectiveSettings: {
          model: "gpt-5",
          reasoningEffort: "medium",
          speed: null,
          planMode: false,
          permissionModeId: "auto"
        },
        modelConfig: {
          configurable: true,
          options: [{ value: "gpt-5", name: "GPT-5" }]
        },
        reasoningConfig: {
          configurable: true,
          options: [{ value: "medium", name: "Medium" }]
        },
        permissionConfig: {
          configurable: true,
          defaultValue: "auto",
          modes: [{ id: "auto", label: "Auto", semantic: "auto" }]
        }
      }))
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.isSettingsLoading).toBe(
        false
      );
    });
    const initialSettings = result.current.viewModel.composerSettings;
    const initialDraftSettings = initialSettings.draftSettings;
    const initialAvailableModels = initialSettings.availableModels;
    const initialAvailableReasoningEfforts =
      initialSettings.availableReasoningEfforts;
    const initialAvailablePermissionModes =
      initialSettings.availablePermissionModes;

    act(() => {
      result.current.actions.updateSelectedProjectPath("/workspace/app");
    });

    expect(result.current.viewModel.composerSettings).not.toBe(initialSettings);
    expect(result.current.viewModel.composerSettings.selectedProjectPath).toBe(
      "/workspace/app"
    );
    expect(result.current.viewModel.composerSettings.draftSettings).toBe(
      initialDraftSettings
    );
    expect(result.current.viewModel.composerSettings.availableModels).toBe(
      initialAvailableModels
    );
    expect(
      result.current.viewModel.composerSettings.availableReasoningEfforts
    ).toBe(initialAvailableReasoningEfforts);
    expect(
      result.current.viewModel.composerSettings.availablePermissionModes
    ).toBe(initialAvailablePermissionModes);
  });

  it("keeps the composer settings reference for equal session setting reloads", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    const getState = vi.fn(async () =>
      agentSessionState("session-1", {
        settings: {
          model: "gpt-5",
          reasoningEffort: "medium",
          permissionModeId: "auto"
        }
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents,
      getState,
      getComposerOptions: vi.fn(async () => ({
        provider: "codex",
        modelConfig: {
          configurable: true,
          options: [{ value: "gpt-5", name: "GPT-5" }]
        },
        reasoningConfig: {
          configurable: true,
          options: [{ value: "medium", name: "Medium" }]
        },
        permissionConfig: {
          configurable: true,
          defaultValue: "auto",
          modes: [{ id: "auto", label: "Auto", semantic: "auto" }]
        }
      }))
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(activityListener).toBeDefined();
      expect(result.current.viewModel.composerSettings.isSettingsLoading).toBe(
        false
      );
    });
    const initialSettings = result.current.viewModel.composerSettings;

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          lifecycleStatus: "active",
          occurredAtUnixMs: 40
        }
      });
    });

    await waitFor(() => {
      expect(getState).toHaveBeenCalledTimes(2);
    });
    expect(result.current.viewModel.composerSettings).toBe(initialSettings);
  });

  it("loads a user project snapshot in preview mode without subscribing", async () => {
    const listUserProjects = vi.fn(async () => ({
      projects: [
        {
          id: "app",
          path: "/workspace/app",
          label: "App"
        }
      ]
    }));
    const subscribeUserProjects = vi.fn(() => vi.fn());
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            cwd: "/workspace/app/packages/web"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      autoLoadRuntime: true,
      userProjects: {
        list: listUserProjects,
        subscribe: subscribeUserProjects,
        use: vi.fn()
      }
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn(),
        previewMode: true
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.userProjects[0]).toEqual({
        id: "app",
        path: "/workspace/app",
        label: "App"
      });
    });
    expect(listUserProjects).toHaveBeenCalledTimes(1);
    expect(subscribeUserProjects).not.toHaveBeenCalled();
  });

  it("seeds preview projects from the host service before async loading settles", async () => {
    const listUserProjects = vi.fn(
      () =>
        new Promise<{
          projects: Array<{ id: string; path: string; label: string }>;
        }>(() => {})
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            cwd: "/workspace/app/packages/web"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      autoLoadRuntime: true,
      userProjects: {
        service: {
          getSnapshot: vi.fn(() => ({
            projects: [
              {
                id: "app",
                path: "/workspace/app",
                label: "App"
              }
            ]
          }))
        },
        list: listUserProjects,
        subscribe: vi.fn(),
        use: vi.fn()
      }
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn(),
        previewMode: true
      })
    );

    expect(result.current.viewModel.userProjects[0]).toEqual({
      id: "app",
      path: "/workspace/app",
      label: "App"
    });
    await waitFor(() => {
      expect(result.current.viewModel.userProjects[0]).toEqual({
        id: "app",
        path: "/workspace/app",
        label: "App"
      });
    });
    expect(listUserProjects).toHaveBeenCalledTimes(1);
  });

  it("removes user projects through the host api and reprojects conversations", async () => {
    const removeProject = vi.fn(async () => undefined);
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            cwd: "/workspace/app"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      userProjects: {
        list: vi.fn(async () => ({
          projects: [
            {
              id: "app",
              path: "/workspace/app",
              label: "App"
            }
          ]
        })),
        remove: removeProject,
        subscribe: vi.fn(() => vi.fn()),
        use: vi.fn()
      }
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversations[0]?.project).toEqual({
        id: "app",
        path: "/workspace/app",
        label: "App"
      });
    });

    await act(async () => {
      result.current.actions.removeProject("/workspace/app");
    });

    expect(removeProject).toHaveBeenCalledWith({ path: "/workspace/app" });
    await waitFor(() => {
      expect(result.current.viewModel.conversations[0]?.project).toBeNull();
    });
  });

  it("ignores stale user project list responses after a newer refresh completes", async () => {
    let userProjectListener: (() => void) | null = null;
    const pendingUserProjectLoads: Array<
      (value: {
        projects: Array<{
          id: string;
          path: string;
          label: string;
        }>;
      }) => void
    > = [];
    const listUserProjects = vi.fn(
      () =>
        new Promise<{
          projects: Array<{
            id: string;
            path: string;
            label: string;
          }>;
        }>((resolve) => {
          pendingUserProjectLoads.push(resolve);
        })
    );
    const subscribeUserProjects = vi.fn((listener: () => void) => {
      userProjectListener = listener;
      return vi.fn();
    });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            cwd: "/workspace/web"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      userProjects: {
        list: listUserProjects,
        subscribe: subscribeUserProjects,
        use: vi.fn()
      }
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(pendingUserProjectLoads).toHaveLength(1);
      expect(userProjectListener).not.toBeNull();
    });
    act(() => {
      userProjectListener?.();
    });
    await waitFor(() => {
      expect(pendingUserProjectLoads).toHaveLength(2);
    });

    await act(async () => {
      pendingUserProjectLoads[1]?.({
        projects: [
          {
            id: "web",
            path: "/workspace/web",
            label: "Web"
          }
        ]
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.viewModel.conversations[0]?.project).toEqual({
        id: "web",
        path: "/workspace/web",
        label: "Web"
      });
    });

    await act(async () => {
      pendingUserProjectLoads[0]?.({
        projects: [
          {
            id: "workspace",
            path: "/workspace",
            label: "Workspace"
          }
        ]
      });
      await Promise.resolve();
    });

    expect(result.current.viewModel.conversations[0]?.project).toEqual({
      id: "web",
      path: "/workspace/web",
      label: "Web"
    });
  });

  it("updates the selected project path for new agent conversations", async () => {
    const getComposerOptions = vi.fn(async () => ({
      provider: "codex",
      modelConfig: {
        options: [{ id: "gpt-5", label: "GPT-5", value: "gpt-5" }]
      }
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(getComposerOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/workspace",
          force: undefined,
          provider: "codex"
        })
      );
    });
    getComposerOptions.mockClear();

    act(() => {
      result.current.actions.updateSelectedProjectPath("/workspace/tutti");
    });

    expect(result.current.viewModel.composerSettings.selectedProjectPath).toBe(
      "/workspace/tutti"
    );
    await waitFor(() => {
      expect(getComposerOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/workspace/tutti",
          force: true,
          provider: "codex"
        })
      );
    });
  });

  it("keeps new conversation draft prompts while switching project folders", async () => {
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.updateSelectedProjectPath("/workspace/app");
      result.current.actions.updateDraftContent(draftContent("app draft"));
    });
    expect(result.current.viewModel.draftPrompt).toBe("app draft");

    act(() => {
      result.current.actions.updateSelectedProjectPath("/workspace/web");
    });
    expect(result.current.viewModel.draftPrompt).toBe("app draft");

    act(() => {
      result.current.actions.updateDraftContent(draftContent("web draft"));
    });
    expect(result.current.viewModel.draftPrompt).toBe("web draft");

    act(() => {
      result.current.actions.createConversation({
        projectPath: "/workspace/app/"
      });
    });

    expect(result.current.viewModel.composerSettings.selectedProjectPath).toBe(
      "/workspace/app"
    );
    expect(result.current.viewModel.draftPrompt).toBe("web draft");
  });

  it("keeps the selected project cwd when starting from a new conversation draft", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId, {
          cwd: input.cwd
        }),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    const exec = vi.fn(async () => ({
      accepted: true,
      agentSessionId: "session-created",
      sessionStatus: "working",
      status: "started"
    }));
    const listUserProjects = vi.fn(async () => ({ projects: [] }));
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec,
      userProjects: {
        list: listUserProjects,
        use: vi.fn()
      }
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(listUserProjects).toHaveBeenCalled();
    });

    act(() => {
      result.current.actions.updateSelectedProjectPath("/workspace/app", {
        action: "select_existing",
        project: {
          id: "app",
          path: "/workspace/app",
          label: "App"
        }
      });
      result.current.actions.createConversation();
      result.current.actions.submitPrompt(promptBlocks("start in app"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: "/workspace/app",
          initialContent: promptBlocks("start in app"),
          mode: "new"
        })
      );
    });
    await waitFor(() => {
      expect(result.current.viewModel.conversations[0]?.project).toEqual({
        id: "app",
        path: "/workspace/app",
        label: "App"
      });
    });
  });

  it("passes the selected provider target ref when starting a new conversation", async () => {
    const providerTargetRef = {
      kind: "shared-agent",
      provider: "codex" as const,
      sharedAgentId: "agent-1"
    };
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId, {
          provider: input.mode === "new" ? input.provider : "codex"
        }),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });
    const onDataChange = vi.fn();

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        providerTargets: [
          {
            targetId: "shared-agent:agent-1",
            provider: "codex",
            ref: providerTargetRef,
            label: "Alice's Codex"
          }
        ],
        defaultProviderTargetId: "shared-agent:agent-1",
        onDataChange
      })
    );

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("start shared codex"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          provider: "codex",
          providerTargetRef
        })
      );
    });
    expect(result.current.viewModel.selectedProviderTarget).toMatchObject({
      targetId: "shared-agent:agent-1",
      provider: "codex",
      label: "Alice's Codex"
    });
    expect(onDataChange).toHaveBeenCalled();
    const persistTargetUpdate = onDataChange.mock.calls.find(([updater]) => {
      const next = updater(agentGuiData(null));
      return next.providerTargetId === "shared-agent:agent-1";
    })?.[0];
    expect(persistTargetUpdate?.(agentGuiData(null))).toMatchObject({
      provider: "codex",
      providerTargetId: "shared-agent:agent-1",
      providerTargetRef
    });
  });

  it("does not send a fallback local provider target ref when provider targets are omitted", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId, {
          provider: input.mode === "new" ? input.provider : "codex"
        }),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });
    const onDataChange = vi.fn();
    const initialData = agentGuiData(null);

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: initialData,
        onDataChange
      })
    );

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("start local codex"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          provider: "codex",
          providerTargetRef: null
        })
      );
    });
    const providerTargetUpdates = onDataChange.mock.calls
      .map(([updater]) => updater(initialData))
      .filter(
        (next) =>
          next !== initialData &&
          ("providerTargetId" in next || "providerTargetRef" in next)
      );
    expect(providerTargetUpdates).toEqual([]);
  });

  it("does not send a fallback local provider target ref when no explicit target matches the provider", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId, {
          provider: input.mode === "new" ? input.provider : "claude-code"
        }),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });
    const onDataChange = vi.fn();
    const initialData = agentGuiData(null, "claude-code");

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: initialData,
        providerTargets: [
          {
            targetId: "shared-agent:codex-1",
            provider: "codex",
            ref: {
              kind: "shared-agent",
              provider: "codex",
              sharedAgentId: "codex-1"
            },
            label: "Alice's Codex"
          }
        ],
        onDataChange
      })
    );

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("start local claude"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          provider: "claude-code",
          providerTargetRef: null
        })
      );
    });
    const providerTargetUpdates = onDataChange.mock.calls
      .map(([updater]) => updater(initialData))
      .filter(
        (next) =>
          next !== initialData &&
          ("providerTargetId" in next || "providerTargetRef" in next)
      );
    expect(providerTargetUpdates).toEqual([]);
  });

  it("prefills draft prompts without activating or executing a session", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    const unactivate = vi.fn(async () => undefined);
    const exec = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      unactivate,
      exec
    });

    type PrefillPromptRequest = Parameters<
      typeof useAgentGUINodeController
    >[0]["prefillPromptRequest"];
    const { result, rerender } = renderHook(
      (props: { prefillPromptRequest?: PrefillPromptRequest }) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData("session-1"),
          onDataChange: vi.fn(),
          ...props
        }),
      {
        initialProps: {
          prefillPromptRequest: null as PrefillPromptRequest
        }
      }
    );

    expect(result.current.viewModel.activeConversationId).toBe("session-1");

    rerender({
      prefillPromptRequest: {
        draftPrompt: " Review this issue ",
        sequence: 1,
        userProjectPath: "/workspace/app/"
      }
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe(null);
      expect(result.current.viewModel.draftPrompt).toBe("Review this issue");
      expect(
        result.current.viewModel.composerSettings.selectedProjectPath
      ).toBe("/workspace/app");
    });
    expect(unactivate).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      workspaceId: "room-1"
    });
    expect(activate).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();

    act(() => {
      result.current.actions.updateDraftContent(draftContent("user edit"));
    });
    rerender({
      prefillPromptRequest: {
        draftPrompt: "Replay should be ignored",
        sequence: 1
      }
    });
    await Promise.resolve();
    expect(result.current.viewModel.draftPrompt).toBe("user edit");

    rerender({
      prefillPromptRequest: {
        draftPrompt: "Next issue",
        sequence: 2
      }
    });
    await waitFor(() => {
      expect(result.current.viewModel.draftPrompt).toBe("Next issue");
      expect(
        result.current.viewModel.composerSettings.selectedProjectPath
      ).toBe(null);
    });
    expect(activate).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it("tracks active conversation project setting changes through the host reporter", async () => {
    const trackSettingsProjectChange = vi.fn(async () => undefined);
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [workspaceAgentSession("session-1")]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      trackSettingsProjectChange
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.updateSelectedProjectPath("/workspace/tutti", {
        action: "select_existing"
      });
    });

    expect(trackSettingsProjectChange).toHaveBeenCalledWith({
      action: "select_existing",
      agentSessionId: "session-1",
      provider: "codex",
      workspaceId: "room-1"
    });
  });

  it("shares the new retained session stream and durable refreshes across controllers on the same session", async () => {
    const list = vi.fn(async () => ({
      presences: [],
      sessions: [
        workspaceAgentSession("session-1", { title: "Pinned conversation" })
      ]
    }));
    const listSessionTimeline = vi.fn(async () => ({ timelineItems: [] }));
    const getState = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) =>
        agentSessionState(agentSessionId)
    );
    const retainEventStream = vi.fn(async () => ({
      leaseId: "lease-1",
      retained: true
    }));
    const releaseEventStream = vi.fn(async () => ({ released: true }));
    installAgentHostApi({
      list,
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn()),
      getState,
      retainEventStream,
      releaseEventStream,
      onSessionEvent: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() => ({
      first: useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      }),
      second: useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    }));

    await waitFor(() => {
      expect(result.current.first.viewModel.activeConversationId).toBe(
        "session-1"
      );
      expect(result.current.second.viewModel.activeConversationId).toBe(
        "session-1"
      );
    });
    await waitFor(() => {
      expect(retainEventStream).toHaveBeenCalledTimes(1);
    });

    expect(listSessionTimeline).toHaveBeenCalled();
    expect(getState).toHaveBeenCalledTimes(1);
    expect(releaseEventStream).not.toHaveBeenCalled();
  });

  it("keeps the first created conversation on home before activation resolves", async () => {
    let resolveActivate:
      | ((result: AgentHostActivateAgentSessionResult) => void)
      | undefined;
    let capturedAgentSessionId = "";
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      capturedAgentSessionId = input.agentSessionId;
      return new Promise<AgentHostActivateAgentSessionResult>((resolve) => {
        resolveActivate = resolve;
      });
    });
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec: vi.fn(async () => ({
        accepted: true,
        agentSessionId: capturedAgentSessionId,
        sessionStatus: "working",
        status: "started"
      }))
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("start the first turn"));
    });

    await waitFor(() => {
      expect(capturedAgentSessionId).not.toBe("");
      expect(
        getAgentSessionView({
          workspaceId: "room-1",
          agentSessionId: capturedAgentSessionId
        })?.isLoadingMessages
      ).not.toBe(true);
    });
    expect(result.current.viewModel.activeConversationId).toBeNull();
    expect(result.current.viewModel.isCreatingConversation).toBe(true);

    await act(async () => {
      resolveActivate?.({
        session: agentSession(capturedAgentSessionId),
        activation: { mode: "new", status: "attached" }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe(
        capturedAgentSessionId
      );
    });
  });

  it("keeps background session timeline events in the activity snapshot", async () => {
    const retainEventStream = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) => ({
        leaseId: `lease-${agentSessionId}`,
        retained: true
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", { effectiveStatus: "ready" }),
          workspaceAgentSession("session-2", {
            effectiveStatus: "working",
            turnPhase: "running"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      retainEventStream,
      releaseEventStream: vi.fn(async () => ({ released: true }))
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
      expect(retainEventStream).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-2"
      });
    });
    expect(emitRuntimeSessionEventForTests).toBeDefined();

    vi.useFakeTimers();
    act(() => {
      emitRuntimeSessionEventForTests?.(
        streamToolCall({
          agentSessionId: "session-2",
          callId: "background-call",
          name: "shell",
          status: "in_progress",
          occurredAtUnixMs: 20
        })
      );
      vi.advanceTimersByTime(16);
    });

    expect(
      getAgentSessionView({
        workspaceId: "room-1",
        agentSessionId: "session-2"
      })?.overlayMessages
    ).toEqual([]);
    expect(
      (
        window as { agentActivityRuntime?: AgentActivityRuntime }
      ).agentActivityRuntime?.getSnapshot("room-1").sessionMessagesById[
        "session-2"
      ]
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ callId: "background-call" })
      })
    ]);
  });

  it("keeps each window selection independent when another window creates a new session", async () => {
    let resolveActivation:
      | ((value: AgentHostActivateAgentSessionResult) => void)
      | undefined;
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      if (input.mode === "existing") {
        return Promise.resolve({
          session: agentSession(input.agentSessionId),
          activation: { mode: input.mode, status: "attached" as const }
        });
      }
      return new Promise<AgentHostActivateAgentSessionResult>((resolve) => {
        resolveActivation = resolve;
      });
    });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });

    const { result } = renderHook(() => ({
      first: useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      }),
      second: useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-2"),
        onDataChange: vi.fn()
      })
    }));

    await waitFor(() => {
      expect(result.current.first.viewModel.activeConversationId).toBe(
        "session-1"
      );
      expect(result.current.second.viewModel.activeConversationId).toBe(
        "session-2"
      );
    });

    act(() => {
      result.current.first.actions.createConversation();
      result.current.first.actions.submitPrompt(
        promptBlocks("start a parallel chat")
      );
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          ...initialPromptContent("start a parallel chat")
        })
      );
    });

    const createdId = activate.mock.calls.find(
      (call) => call[0].mode === "new"
    )?.[0].agentSessionId;
    expect(createdId).toBeTruthy();

    act(() => {
      resolveActivation?.({
        session: agentSession(createdId!),
        activation: { mode: "new", status: "attached" }
      });
    });

    await waitFor(() => {
      expect(result.current.first.viewModel.activeConversationId).toBe(
        createdId
      );
    });
    expect(result.current.second.viewModel.activeConversationId).toBe(
      "session-2"
    );
    expect(result.current.second.viewModel.activeConversation?.id).toBe(
      "session-2"
    );
  });

  it("prepends a newly created conversation into the shared list without dropping the previous first item", async () => {
    let resolveActivation:
      | ((value: AgentHostActivateAgentSessionResult) => void)
      | undefined;
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      if (input.mode === "existing") {
        return Promise.resolve({
          session: agentSession(input.agentSessionId),
          activation: { mode: input.mode, status: "attached" as const }
        });
      }
      return new Promise<AgentHostActivateAgentSessionResult>((resolve) => {
        resolveActivation = resolve;
      });
    });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", { title: "2132" }),
          workspaceAgentSession("session-2", { title: "hi" }),
          workspaceAgentSession("session-3", { title: "这是什么?" })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });

    const { result } = renderHook(() => ({
      first: useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      }),
      second: useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-2"),
        onDataChange: vi.fn()
      })
    }));

    await waitFor(() => {
      expect(
        result.current.first.viewModel.conversations.map(
          (conversation) => conversation.id
        )
      ).toEqual(["session-1", "session-2", "session-3"]);
      expect(
        result.current.second.viewModel.conversations.map(
          (conversation) => conversation.id
        )
      ).toEqual(["session-1", "session-2", "session-3"]);
    });

    act(() => {
      result.current.first.actions.createConversation();
      result.current.first.actions.submitPrompt(promptBlocks("1232"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          initialContent: promptBlocks("1232")
        })
      );
    });
    const createdId = activate.mock.calls.find(
      (call) => call[0].mode === "new"
    )?.[0].agentSessionId;
    expect(createdId).toBeTruthy();

    act(() => {
      resolveActivation?.({
        session: agentSession(createdId!, { title: "1232" }),
        activation: { mode: "new", status: "attached" }
      });
    });

    await waitFor(() => {
      expect(
        result.current.second.viewModel.conversations.map(
          (conversation) => conversation.id
        )
      ).toEqual([createdId, "session-1", "session-2", "session-3"]);
    });
    expect(result.current.second.viewModel.conversations[1]?.title).toBe(
      "2132"
    );
  });

  it("moves an existing conversation up immediately when submitting a new turn", async () => {
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            createdAtUnixMs: 1000,
            updatedAtUnixMs: 1000
          }),
          workspaceAgentSession("session-2", {
            createdAtUnixMs: 2000,
            updatedAtUnixMs: 2000
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      exec: vi.fn(async ({ agentSessionId }: { agentSessionId: string }) =>
        agentSession(agentSessionId, {
          status: "working",
          updatedAtUnixMs: Date.now()
        })
      ),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.conversations.map(
          (conversation) => conversation.id
        )
      ).toEqual(["session-2", "session-1"]);
    });

    act(() => {
      result.current.actions.submitPrompt(
        promptBlocks("continue the old session")
      );
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.conversations.map(
          (conversation) => conversation.id
        )
      ).toEqual(["session-1", "session-2"]);
    });
  });

  it("selects an externally requested active conversation on an already-open panel", async () => {
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result, rerender } = renderHook(
      (props) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          ...props
        }),
      {
        initialProps: {
          data: agentGuiData("session-1"),
          onDataChange: vi.fn()
        }
      }
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    rerender({
      data: agentGuiData("session-2"),
      onDataChange: vi.fn()
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-2");
    });
  });

  it("keeps a locally selected conversation while the persisted node data is still stale", async () => {
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const onDataChange = vi.fn();
    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-2");
    });
    expect(result.current.viewModel.activeConversation?.id).toBe("session-2");
    expect(onDataChange).toHaveBeenCalled();
  });

  it("honors an explicit open-session request after a local conversation switch", async () => {
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result, rerender } = renderHook(
      (props) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          ...props
        }),
      {
        initialProps: {
          data: agentGuiData("session-1"),
          onDataChange: vi.fn(),
          openSessionRequest: null as {
            agentSessionId: string;
            sequence: number;
          } | null
        }
      }
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-2");
    });

    rerender({
      data: agentGuiData("session-1"),
      onDataChange: vi.fn(),
      openSessionRequest: {
        agentSessionId: "session-1",
        sequence: 1
      }
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
  });

  it("keeps a switched conversation loading while its timeline request is pending", async () => {
    const session2TimelineResolvers: Array<
      (value: { timelineItems: AgentHostWorkspaceAgentTimelineItem[] }) => void
    > = [];
    const listSessionTimeline = vi.fn(
      ({ agentSessionId }: { agentSessionId: string }) => {
        if (agentSessionId === "session-2") {
          return new Promise<{
            timelineItems: AgentHostWorkspaceAgentTimelineItem[];
          }>((resolve) => {
            session2TimelineResolvers.push(resolve);
          });
        }
        return Promise.resolve({ timelineItems: [] });
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      expect(session2TimelineResolvers.length).toBeGreaterThan(0);
    });
    expect(result.current.viewModel.activeConversationId).toBe("session-2");
    expect(result.current.viewModel.activeConversation?.id).toBe("session-2");
    expect(result.current.viewModel.isLoadingMessages).toBe(true);
    expect(
      getAgentSessionView({
        workspaceId: "room-1",
        agentSessionId: "session-2"
      })?.isLoadingMessages
    ).toBe(true);

    await act(async () => {
      for (const resolve of session2TimelineResolvers.splice(0)) {
        resolve({
          timelineItems: [
            timelineMessage({
              agentSessionId: "session-2",
              id: 2,
              eventId: "session-2-user",
              role: "user",
              content: "continue here",
              turnId: "turn-2"
            })
          ]
        });
      }
    });

    await waitFor(() => {
      expect(result.current.viewModel.isLoadingMessages).toBe(false);
      expect(result.current.viewModel.conversation?.rows).toHaveLength(1);
    });
  });

  it("loads the latest selected conversation message page first", async () => {
    const timelineRequests: Array<{
      afterVersion?: number;
      beforeVersion?: number;
      cache?: boolean;
      limit?: number;
      order?: string;
    }> = [];
    const listSessionTimeline = vi.fn(
      async ({
        afterVersion,
        beforeVersion,
        cache,
        agentSessionId,
        limit,
        order
      }: {
        afterVersion?: number;
        beforeVersion?: number;
        cache?: boolean;
        agentSessionId: string;
        limit?: number;
        order?: string;
      }) => {
        if (agentSessionId !== "session-2") {
          return { timelineItems: [], hasMore: false };
        }
        timelineRequests.push({
          afterVersion,
          beforeVersion,
          cache,
          limit,
          order
        });
        if (order === "desc" && beforeVersion === undefined) {
          return {
            timelineItems: [
              timelineMessage({
                agentSessionId: "session-2",
                id: 2,
                eventId: "assistant-1",
                role: "assistant",
                content: "latest answer",
                turnId: "turn-1"
              }),
              timelineMessage({
                agentSessionId: "session-2",
                id: 1,
                eventId: "user-1",
                role: "user",
                content: "latest ask",
                turnId: "turn-1"
              })
            ],
            hasMore: true
          };
        }
        return { timelineItems: [], hasMore: false };
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      expect(
        timelineRequests.some(
          (request) =>
            request.order === "desc" &&
            request.cache === false &&
            request.limit === 100 &&
            request.beforeVersion === undefined
        )
      ).toBe(true);
      expect(result.current.viewModel.hasOlderMessages).toBe(true);
      expect(
        result.current.viewModel.conversationDetail?.turns[0]?.userMessages
      ).toEqual([expect.objectContaining({ body: "latest ask" })]);
      expect(
        result.current.viewModel.conversationDetail?.turns[0]?.agentMessages
      ).toEqual([expect.objectContaining({ body: "latest answer" })]);
    });
  });

  it("backfills older selected conversation messages when the latest page has no user prompt", async () => {
    const timelineRequests: Array<{
      beforeVersion?: number;
      cache?: boolean;
      limit?: number;
      order?: string;
    }> = [];
    const listSessionTimeline = vi.fn(
      async ({
        beforeVersion,
        cache,
        agentSessionId,
        limit,
        order
      }: {
        beforeVersion?: number;
        cache?: boolean;
        agentSessionId: string;
        limit?: number;
        order?: string;
      }) => {
        if (agentSessionId !== "session-2") {
          return { timelineItems: [], hasMore: false };
        }
        timelineRequests.push({ beforeVersion, cache, limit, order });
        if (order === "desc" && beforeVersion === undefined) {
          return {
            timelineItems: Array.from({ length: 100 }, (_, index) => {
              const id = 102 - index;
              return timelineMessage({
                agentSessionId: "session-2",
                id,
                eventId: `assistant-${id}`,
                role: "assistant",
                content: id === 102 ? "latest answer" : `assistant ${id}`,
                turnId: "turn-1"
              });
            }),
            latestVersion: 102,
            hasMore: true
          };
        }
        if (order === "desc" && beforeVersion === 3) {
          return {
            timelineItems: [
              timelineMessage({
                agentSessionId: "session-2",
                id: 2,
                eventId: "assistant-2",
                role: "assistant",
                content: "early answer",
                turnId: "turn-1"
              }),
              timelineMessage({
                agentSessionId: "session-2",
                id: 1,
                eventId: "user-1",
                role: "user",
                content: "initial ask",
                turnId: "turn-1"
              })
            ],
            latestVersion: 102,
            hasMore: false
          };
        }
        return { timelineItems: [], latestVersion: 102, hasMore: false };
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      const bodies = conversationBodies(result.current.viewModel);
      expect(bodies).toContain("initial ask");
      expect(bodies).toContain("latest answer");
      expect(result.current.viewModel.hasOlderMessages).toBe(false);
    });
    expect(timelineRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beforeVersion: undefined,
          cache: false,
          limit: 100,
          order: "desc"
        }),
        expect.objectContaining({
          beforeVersion: 3,
          cache: false,
          limit: 100,
          order: "desc"
        })
      ])
    );
  });

  it("keeps streamed detail messages that arrive while the initial page is loading", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const resolveSession2Timelines: Array<
      (value: { timelineItems: unknown[]; hasMore: boolean }) => void
    > = [];
    const listSessionTimeline = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) => {
        if (agentSessionId !== "session-2") {
          return { timelineItems: [], hasMore: false };
        }
        return new Promise<{ timelineItems: unknown[]; hasMore: boolean }>(
          (resolve) => {
            resolveSession2Timelines.push(resolve);
          }
        );
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn((_payload, listener) => {
        activityListener = listener;
        return vi.fn();
      })
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    act(() => {
      result.current.actions.selectConversation("session-2");
    });
    await waitFor(() => {
      expect(resolveSession2Timelines.length).toBeGreaterThan(0);
      expect(activityListener).toBeDefined();
    });

    act(() => {
      activityListener?.(
        streamMessage({
          agentSessionId: "session-2",
          id: 3,
          eventId: "assistant-streamed",
          role: "assistant",
          content: "streamed while loading",
          turnId: "turn-2"
        })
      );
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.conversationDetail?.turns.at(-1)?.agentMessages
      ).toEqual([expect.objectContaining({ body: "streamed while loading" })]);
    });

    await act(async () => {
      for (const resolveSession2Timeline of resolveSession2Timelines.splice(
        0
      )) {
        resolveSession2Timeline({
          timelineItems: [
            timelineMessage({
              agentSessionId: "session-2",
              id: 2,
              eventId: "assistant-1",
              role: "assistant",
              content: "latest answer",
              turnId: "turn-1"
            }),
            timelineMessage({
              agentSessionId: "session-2",
              id: 1,
              eventId: "user-1",
              role: "user",
              content: "latest ask",
              turnId: "turn-1"
            })
          ],
          hasMore: true
        });
      }
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.conversationDetail?.turns
          .flatMap((turn) => [
            ...turn.userMessages.map((message) => message.body),
            ...turn.agentMessages.map((message) => message.body)
          ])
          .filter(Boolean)
      ).toEqual(["latest ask", "latest answer", "streamed while loading"]);
    });
  });

  it("does not let durable history stream expand the selected detail window", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const allTimelineItems = Array.from({ length: 260 }, (_, index) => {
      const id = index + 1;
      return timelineMessage({
        agentSessionId: "session-2",
        id,
        eventId: `message-${id}`,
        role: id % 2 === 0 ? "assistant" : "user",
        content: `message ${id}`,
        turnId: `turn-${Math.ceil(id / 2)}`
      });
    });
    const listSessionTimeline = vi.fn(
      async ({
        agentSessionId,
        afterVersion,
        beforeVersion,
        order
      }: {
        agentSessionId: string;
        afterVersion?: number;
        beforeVersion?: number;
        order?: string;
      }) => {
        if (agentSessionId !== "session-2") {
          return { timelineItems: [], hasMore: false };
        }
        if (order === "desc" && beforeVersion === undefined) {
          return {
            timelineItems: allTimelineItems.slice(160).reverse(),
            latestVersion: 260,
            hasMore: true
          };
        }
        if (afterVersion === 260) {
          return {
            timelineItems: [
              timelineMessage({
                agentSessionId: "session-2",
                id: 261,
                eventId: "message-261",
                role: "user",
                content: "message 261",
                turnId: "turn-131"
              })
            ],
            latestVersion: 261,
            hasMore: false
          };
        }
        return { timelineItems: [], latestVersion: 260, hasMore: false };
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [workspaceAgentSession("session-2")],
        sessionMessagesById: {
          "session-2": allTimelineItems.map(timelineItemToMessage)
        }
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn((_payload, listener) => {
        activityListener = listener;
        return vi.fn();
      })
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-2"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-2");
      expect(conversationBodies(result.current.viewModel)).toContain(
        "message 260"
      );
    });

    act(() => {
      for (let id = 1; id <= 160; id += 1) {
        activityListener?.(
          streamMessage({
            agentSessionId: "session-2",
            id,
            eventId: `message-${id}`,
            role: id % 2 === 0 ? "assistant" : "user",
            content: `message ${id}`,
            turnId: `turn-${Math.ceil(id / 2)}`
          })
        );
      }
    });

    await waitFor(() => {
      const bodies = conversationBodies(result.current.viewModel);
      expect(bodies).toContain("message 161");
      expect(bodies).toContain("message 260");
      expect(bodies).not.toContain("message 1");
      expect(bodies).not.toContain("message 160");
    });

    await act(async () => {
      await (
        window as { agentActivityRuntime?: AgentActivityRuntime }
      ).agentActivityRuntime?.listSessionMessages({
        workspaceId: "room-1",
        agentSessionId: "session-2",
        afterVersion: 260
      });
    });
    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      const bodies = conversationBodies(result.current.viewModel);
      expect(bodies).toContain("message 161");
      expect(bodies).toContain("message 261");
      expect(bodies).not.toContain("message 1");
      expect(bodies).not.toContain("message 160");
    });
  });

  it("loads older selected conversation messages before the current oldest version", async () => {
    const timelineRequests: Array<{
      beforeVersion?: number;
      cache?: boolean;
      order?: string;
    }> = [];
    const listSessionTimeline = vi.fn(
      async ({
        beforeVersion,
        cache,
        agentSessionId,
        order
      }: {
        beforeVersion?: number;
        cache?: boolean;
        agentSessionId: string;
        order?: string;
      }) => {
        if (agentSessionId !== "session-2") {
          return { timelineItems: [], hasMore: false };
        }
        timelineRequests.push({ beforeVersion, cache, order });
        if (order === "desc" && beforeVersion === undefined) {
          return {
            timelineItems: [
              timelineMessage({
                agentSessionId: "session-2",
                id: 2,
                eventId: "assistant-1",
                role: "assistant",
                content: "latest answer",
                turnId: "turn-1"
              }),
              timelineMessage({
                agentSessionId: "session-2",
                id: 1,
                eventId: "user-1",
                role: "user",
                content: "latest ask",
                turnId: "turn-1"
              })
            ],
            hasMore: true
          };
        }
        if (order === "desc" && beforeVersion === 1) {
          return {
            timelineItems: [
              timelineMessage({
                agentSessionId: "session-2",
                id: 0,
                eventId: "older-user",
                role: "user",
                content: "older ask",
                turnId: "turn-0"
              })
            ],
            hasMore: false
          };
        }
        return { timelineItems: [], hasMore: false };
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      expect(result.current.viewModel.hasOlderMessages).toBe(true);
    });
    await act(async () => {
      result.current.actions.loadOlderConversationMessages();
    });

    await waitFor(() => {
      expect(
        timelineRequests.some(
          (request) =>
            request.order === "desc" &&
            request.cache === false &&
            request.beforeVersion === 1
        )
      ).toBe(true);
      expect(
        result.current.viewModel.conversationDetail?.turns[0]?.userMessages
      ).toEqual([expect.objectContaining({ body: "older ask" })]);
      expect(
        result.current.viewModel.conversationDetail?.turns.at(-1)?.agentMessages
      ).toEqual([expect.objectContaining({ body: "latest answer" })]);
    });
  });

  it("suppresses repeated older message loads for the same failed cursor", async () => {
    const timelineRequests: Array<{
      beforeVersion?: number;
      agentSessionId: string;
      order?: string;
    }> = [];
    const listSessionTimeline = vi.fn(
      async ({
        beforeVersion,
        agentSessionId,
        order
      }: {
        beforeVersion?: number;
        agentSessionId: string;
        order?: string;
      }) => {
        timelineRequests.push({ agentSessionId, beforeVersion, order });
        if (agentSessionId !== "session-2") {
          return { timelineItems: [], hasMore: false };
        }
        if (order === "desc" && beforeVersion === undefined) {
          return {
            timelineItems: [
              timelineMessage({
                agentSessionId: "session-2",
                id: 1,
                eventId: "user-1",
                role: "user",
                content: "latest ask",
                turnId: "turn-1"
              })
            ],
            hasMore: true
          };
        }
        throw new Error("older page failed");
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      expect(result.current.viewModel.hasOlderMessages).toBe(true);
    });
    await act(async () => {
      await result.current.actions.loadOlderConversationMessages();
    });
    await waitFor(() => {
      expect(result.current.viewModel.isLoadingOlderMessages).toBe(false);
    });
    const failedOlderRequestCount = timelineRequests.filter(
      (request) =>
        request.agentSessionId === "session-2" &&
        request.order === "desc" &&
        request.beforeVersion === 1
    ).length;

    await act(async () => {
      await result.current.actions.loadOlderConversationMessages();
    });

    expect(
      timelineRequests.filter(
        (request) =>
          request.agentSessionId === "session-2" &&
          request.order === "desc" &&
          request.beforeVersion === 1
      )
    ).toHaveLength(failedOlderRequestCount);
  });

  it("clears older message loading when a stale older request resolves", async () => {
    let resolveOlder:
      | ((value: { timelineItems: unknown[]; hasMore: boolean }) => void)
      | undefined;
    const listSessionTimeline = vi.fn(
      async ({
        beforeVersion,
        agentSessionId,
        order
      }: {
        beforeVersion?: number;
        agentSessionId: string;
        order?: string;
      }) => {
        if (agentSessionId !== "session-2") {
          return { timelineItems: [], hasMore: false };
        }
        if (order === "desc" && beforeVersion === undefined) {
          return {
            timelineItems: [
              timelineMessage({
                agentSessionId: "session-2",
                id: 1,
                eventId: "user-1",
                role: "user",
                content: "latest ask",
                turnId: "turn-1"
              })
            ],
            hasMore: true
          };
        }
        return new Promise<{ timelineItems: unknown[]; hasMore: boolean }>(
          (resolve) => {
            resolveOlder = resolve;
          }
        );
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    act(() => {
      result.current.actions.selectConversation("session-2");
    });
    await waitFor(() => {
      expect(result.current.viewModel.hasOlderMessages).toBe(true);
    });
    await act(async () => {
      result.current.actions.loadOlderConversationMessages();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.viewModel.isLoadingOlderMessages).toBe(true);
    });

    act(() => {
      result.current.actions.selectConversation("session-1");
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    await act(async () => {
      resolveOlder?.({ timelineItems: [], hasMore: false });
      await Promise.resolve();
    });
    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-2");
      expect(result.current.viewModel.isLoadingOlderMessages).toBe(false);
    });
  });

  it("keeps a switched conversation while its first state load reports not found", async () => {
    let session2StateLoads = 0;
    const getState = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) => {
        if (agentSessionId === "session-2") {
          session2StateLoads += 1;
          if (session2StateLoads === 1) {
            throw {
              code: "session.not_found",
              message: "Session not found.",
              debugMessage: "agent session not found"
            };
          }
        }
        return agentSessionState(agentSessionId);
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      expect(session2StateLoads).toBe(1);
    });
    expect(result.current.viewModel.activeConversationId).toBe("session-2");
    expect(result.current.viewModel.activeConversation?.id).toBe("session-2");
    expect(result.current.viewModel.detailError).toBeNull();

    await waitFor(() => {
      expect(session2StateLoads).toBe(2);
    });
    expect(result.current.viewModel.activeConversationId).toBe("session-2");
    expect(result.current.viewModel.detailError).toBeNull();
  });

  it("retries switched conversation messages when their first loads report not found", async () => {
    let allowSession2Timeline = false;
    let session2TimelineLoads = 0;
    const listSessionTimeline = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) => {
        if (agentSessionId === "session-2") {
          session2TimelineLoads += 1;
          if (!allowSession2Timeline) {
            throw {
              code: "session.not_found",
              message: "Session not found.",
              debugMessage: "agent session not found"
            };
          }
          return {
            timelineItems: [
              timelineMessage({
                agentSessionId: "session-2",
                id: 2,
                eventId: "session-2-user",
                role: "user",
                content: "continue here",
                turnId: "turn-2"
              })
            ]
          };
        }
        return { timelineItems: [] };
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.selectConversation("session-2");
    });

    await waitFor(() => {
      expect(session2TimelineLoads).toBeGreaterThanOrEqual(2);
    });
    expect(result.current.viewModel.activeConversationId).toBe("session-2");
    expect(result.current.viewModel.isLoadingMessages).toBe(true);

    allowSession2Timeline = true;

    await waitFor(() => {
      expect(session2TimelineLoads).toBeGreaterThanOrEqual(3);
      expect(result.current.viewModel.isLoadingMessages).toBe(false);
      expect(result.current.viewModel.conversation?.rows).toHaveLength(1);
    });
  });

  it("keeps the current conversation while an externally requested conversation is missing", async () => {
    const list = vi.fn(async () => ({
      presences: [],
      sessions: [workspaceAgentSession("session-1")]
    }));
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result, rerender } = renderHook(
      (props) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          ...props
        }),
      {
        initialProps: {
          data: agentGuiData("session-1"),
          onDataChange: vi.fn()
        }
      }
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    rerender({
      data: agentGuiData("missing-session"),
      onDataChange: vi.fn()
    });

    await loadAgentActivityRuntimeForTests();
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2);
    });
    expect(result.current.viewModel.activeConversationId).toBe("session-1");
    expect(result.current.viewModel.activeConversation?.id).toBe("session-1");
  });

  it("does not activate the fallback conversation until a prompt is submitted through the runtime", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const },
        events: []
      })
    );
    const exec = vi.fn(
      async (_input: {
        workspaceId: string;
        agentSessionId: string;
        content: AgentPromptContentBlock[];
      }) => ({
        turnId: "turn-1"
      })
    );
    const list = vi.fn(async () => snapshotWithSession("session-1"));
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec
    });
    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("missing-session"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    expect(activate).not.toHaveBeenCalled();

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("resume this one"));
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        ...promptContent("resume this one")
      });
    });
    expect(activate).not.toHaveBeenCalled();
  });

  it("submits an existing session without client-side activation preflight", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId, {
          status: "working"
        }),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    const exec = vi.fn(async () => ({
      sessionStatus: "working",
      turnId: "turn-1"
    }));
    const getState = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) =>
        agentSessionState(agentSessionId)
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec,
      getState
    });
    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );
    await waitFor(() => {
      expect(getState).toHaveBeenCalledTimes(1);
    });
    const controlStateLoadCount = getState.mock.calls.length;

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("hello"));
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "room-1",
          agentSessionId: "session-1",
          ...promptContent("hello")
        })
      );
    });
    expect(activate).not.toHaveBeenCalledWith(
      expect.objectContaining({ mode: "existing" })
    );
    await Promise.resolve();
    expect(getState).toHaveBeenCalledTimes(controlStateLoadCount);
  });

  it("returns to the composer homepage and prepares ACP options without selecting a session", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    const getComposerOptions = vi.fn(async () => ({
      provider: "codex",
      settings: {},
      runtimeContext: {
        configOptions: [
          {
            id: "model",
            currentValue: "gpt-5",
            options: [{ value: "gpt-5", name: "GPT-5" }]
          }
        ]
      }
    }));
    const list = vi.fn(async () => snapshotWithSession("session-1"));
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions,
      activate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.createConversation();
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBeNull();
    });
    expect(result.current.viewModel.conversationDetail).toBeNull();
    await waitFor(() => {
      expect(getComposerOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "room-1",
          provider: "codex"
        })
      );
    });
    expect(activate).not.toHaveBeenCalledWith(
      expect.objectContaining({ mode: "new" })
    );
    expect(activate).not.toHaveBeenCalledWith(
      expect.objectContaining({ mode: "existing" })
    );
    expect(result.current.viewModel.isCreatingConversation).toBe(false);
  });

  it("selects a new session created by submitting from the composer homepage", async () => {
    let resolveActivation:
      | ((value: AgentHostActivateAgentSessionResult) => void)
      | undefined;
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      if (input.mode === "existing") {
        return Promise.resolve({
          session: agentSession(input.agentSessionId),
          activation: { mode: input.mode, status: "attached" as const }
        });
      }
      return new Promise<AgentHostActivateAgentSessionResult>((resolve) => {
        resolveActivation = resolve;
      });
    });
    const exec = vi.fn(
      async (_input: {
        workspaceId: string;
        agentSessionId: string;
        content: AgentPromptContentBlock[];
      }) => ({
        turnId: "turn-1"
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.createConversation();
      result.current.actions.submitPrompt(promptBlocks("start a fresh chat"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          ...initialPromptContent("start a fresh chat")
        })
      );
    });
    const createdId = activate.mock.calls[0]![0].agentSessionId;

    act(() => {
      resolveActivation?.({
        session: agentSession(createdId),
        activation: { mode: "new", status: "attached" }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe(createdId);
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.id).toBe(createdId);
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("renders live assistant messages for a newly created session with only an optimistic prompt in detail", async () => {
    let resolveActivation:
      | ((value: AgentHostActivateAgentSessionResult) => void)
      | undefined;
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      if (input.mode === "existing") {
        return Promise.resolve({
          session: agentSession(input.agentSessionId),
          activation: { mode: input.mode, status: "attached" as const }
        });
      }
      return new Promise<AgentHostActivateAgentSessionResult>((resolve) => {
        resolveActivation = resolve;
      });
    });
    const subscribeEvents = vi.fn(() => vi.fn());
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents,
      activate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBeNull();
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("Start a fresh chat"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          ...initialPromptContent("Start a fresh chat")
        })
      );
    });
    const createdId = activate.mock.calls[0]![0].agentSessionId;

    act(() => {
      resolveActivation?.({
        session: agentSession(createdId, { status: "working" }),
        activation: { mode: "new", status: "attached" }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe(createdId);
      expect(conversationBodies(result.current.viewModel)).toContain(
        "Start a fresh chat"
      );
    });
    await waitFor(() => {
      expect(subscribeEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSessionId: createdId,
          workspaceId: "room-1"
        }),
        expect.any(Function)
      );
    });

    act(() => {
      emitRuntimeSessionEventForTests?.({
        eventType: "state_patch",
        data: {
          agentSessionId: createdId,
          lifecycleStatus: "active",
          currentPhase: "working",
          turn: {
            turnId: "turn-old",
            phase: "running"
          },
          occurredAtUnixMs: 1
        }
      });
    });

    act(() => {
      emitRuntimeSessionEventForTests?.(
        streamMessage({
          agentSessionId: createdId,
          eventId: "assistant-old-history",
          id: 1,
          role: "assistant",
          content: "Old retained answer",
          turnId: "turn-old",
          occurredAtUnixMs: 1
        })
      );
    });

    await waitFor(() => {
      expect(conversationMessageRows(result.current.viewModel)).toEqual([
        { speaker: "user", body: "Start a fresh chat" }
      ]);
      expect(conversationBodies(result.current.viewModel)).not.toContain(
        "Old retained answer"
      );
    });

    act(() => {
      emitRuntimeSessionEventForTests?.(
        streamMessage({
          agentSessionId: createdId,
          eventId: "assistant-first",
          id: 2,
          role: "assistant",
          content: "First answer",
          turnId: "turn-1",
          occurredAtUnixMs: Date.now() + 1_000
        })
      );
    });

    await waitFor(() => {
      expect(conversationBodies(result.current.viewModel)).toEqual(
        expect.arrayContaining(["Start a fresh chat", "First answer"])
      );
      expect(conversationMessageRows(result.current.viewModel)).toEqual([
        { speaker: "user", body: "Start a fresh chat" },
        { speaker: "assistant", body: "First answer" }
      ]);
    });
  });

  it("starts a new session after external data clears the active session", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    const exec = vi.fn(async () => ({ turnId: "turn-1" }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec
    });

    const baseProps = {
      workspaceId: "room-1",
      currentUserId: "user-1",
      workspacePath: "/workspace",
      avoidGroupingEdits: false,
      onDataChange: vi.fn()
    };
    const { result, rerender } = renderHook(
      (props: {
        data: AgentGUINodeData;
        onDataChange: (
          updater: (current: AgentGUINodeData) => AgentGUINodeData
        ) => void;
      }) =>
        useAgentGUINodeController({
          ...baseProps,
          data: props.data,
          onDataChange: props.onDataChange
        }),
      {
        initialProps: {
          data: agentGuiData("session-1"),
          onDataChange: baseProps.onDataChange
        }
      }
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    rerender({
      data: agentGuiData(null),
      onDataChange: baseProps.onDataChange
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBeNull();
    });

    act(() => {
      result.current.actions.submitPrompt(
        promptBlocks("start outside old chat")
      );
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          ...initialPromptContent("start outside old chat")
        })
      );
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("inherits the current same-provider model when creating a new conversation without a draft model", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    const getState = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) =>
        agentSessionState(agentSessionId, {
          settings: {
            model: "gpt-5.5",
            reasoningEffort: "high",
            permissionModeId: "auto"
          }
        })
    );
    installAgentHostApi({
      list: vi.fn(async () =>
        snapshotWithSession("session-1", {
          model: "gpt-5.5"
        } as Partial<AgentHostWorkspaceAgentSession>)
      ),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    await waitFor(() => {
      expect(getState).toHaveBeenCalled();
    });

    act(() => {
      result.current.actions.createConversation();
      result.current.actions.submitPrompt(promptBlocks("start on same model"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          settings: expect.objectContaining({
            model: "gpt-5.5"
          })
        })
      );
    });
  });

  it("ignores stale session list results while creating a new session from home", async () => {
    let resolveList:
      | ((value: AgentHostWorkspaceAgentSnapshot) => void)
      | undefined;
    let resolveActivation:
      | ((value: AgentHostActivateAgentSessionResult) => void)
      | undefined;
    const list = vi.fn(
      () =>
        new Promise<AgentHostWorkspaceAgentSnapshot>((resolve) => {
          resolveList = resolve;
        })
    );
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      if (input.mode === "existing") {
        return Promise.resolve({
          session: agentSession(input.agentSessionId),
          activation: { mode: input.mode, status: "attached" as const }
        });
      }
      return new Promise<AgentHostActivateAgentSessionResult>((resolve) => {
        resolveActivation = resolve;
      });
    });
    const exec = vi.fn(async () => ({ turnId: "turn-1" }));
    const unactivate = vi.fn();
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      unactivate,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    expect(result.current.viewModel.activeConversationId).toBe("session-1");

    act(() => {
      result.current.actions.createConversation();
      result.current.actions.submitPrompt(
        promptBlocks("start despite stale list")
      );
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          ...initialPromptContent("start despite stale list")
        })
      );
    });
    const createdId = activate.mock.calls[0]![0].agentSessionId;

    act(() => {
      resolveList?.(snapshotWithSession("session-1"));
    });
    await Promise.resolve();

    act(() => {
      resolveActivation?.({
        session: agentSession(createdId),
        activation: { mode: "new", status: "attached" }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe(createdId);
    });
    expect(unactivate).not.toHaveBeenCalledWith(createdId);
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps locally created conversations visible while later list snapshots are still stale", async () => {
    const list = vi.fn(async () => ({
      presences: [],
      sessions: []
    }));
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    const exec = vi.fn(
      async (_input: {
        workspaceId: string;
        agentSessionId: string;
        content: AgentPromptContentBlock[];
      }) => ({
        turnId: "turn-1"
      })
    );
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async ({ agentSessionId }: { agentSessionId: string }) =>
        agentSessionState(agentSessionId, { status: "ready" })
      ),
      activate,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("first local session"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledTimes(1);
    });
    expect(activate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining(initialPromptContent("first local session"))
    );
    const firstCreatedId = activate.mock.calls[0]?.[0].agentSessionId;
    await loadAgentActivityRuntimeForTests();
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2);
    });
    expect(result.current.viewModel.conversations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstCreatedId })])
    );
    expect(result.current.viewModel.activeConversation?.id).toBe(
      firstCreatedId
    );

    act(() => {
      result.current.actions.createConversation();
      result.current.actions.submitPrompt(promptBlocks("second local session"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledTimes(2);
    });
    expect(activate.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining(initialPromptContent("second local session"))
    );
    const secondCreatedId = activate.mock.calls[1]?.[0].agentSessionId;
    await loadAgentActivityRuntimeForTests();
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(3);
    });

    expect(result.current.viewModel.conversations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: secondCreatedId })])
    );
    expect(result.current.viewModel.activeConversation?.id).toBe(
      secondCreatedId
    );
    expect(result.current.viewModel.activeConversation?.status).toBe("ready");
    expect(exec).not.toHaveBeenCalled();
  });

  it("uses the submitted prompt as the new session title and preserves it across the first refresh", async () => {
    let createdSessionId = "";
    let createdTitle = "";
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        presences: [],
        sessions: []
      })
      .mockImplementation(async () => ({
        presences: [],
        sessions: createdSessionId
          ? [
              workspaceAgentSession(createdSessionId, {
                title: createdTitle,
                updatedAtUnixMs: 100,
                effectiveStatus: "working",
                turnPhase: "working"
              })
            ]
          : []
      }));
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => {
        createdSessionId = input.agentSessionId;
        createdTitle = input.title ?? "";
        return {
          session: agentSession(input.agentSessionId, {
            title: input.mode === "new" ? input.title : "Codex",
            updatedAtUnixMs: 50,
            status: "working"
          }),
          activation: { mode: input.mode, status: "attached" as const },
          events: []
        };
      }
    );
    const exec = vi.fn(async () => ({ turnId: "turn-1" }));
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "codex"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("start a fresh chat"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          title: "start a fresh chat",
          ...initialPromptContent("start a fresh chat")
        })
      );
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.title).toBe(
        "start a fresh chat"
      );
    });
    await loadAgentActivityRuntimeForTests();
    await waitFor(() => {
      expect(result.current.viewModel.conversations[0]).toEqual(
        expect.objectContaining({
          id: createdSessionId,
          title: "start a fresh chat"
        })
      );
    });
  });

  it("keeps home active while activation is pending and switches after activation succeeds", async () => {
    let resolveActivation:
      | ((value: AgentHostActivateAgentSessionResult) => void)
      | undefined;
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      if (input.mode === "new") {
        return new Promise<AgentHostActivateAgentSessionResult>((resolve) => {
          resolveActivation = resolve;
        });
      }
      return Promise.resolve({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      });
    });
    const exec = vi.fn(async () => ({ turnId: "turn-1" }));
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.updateDraftContent(draftContent("first prompt"));
      result.current.actions.submitPrompt(promptBlocks("first prompt"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "new" })
      );
    });

    const createdId = activate.mock.calls[0]![0].agentSessionId;
    expect(result.current.viewModel.activeConversationId).toBeNull();
    expect(result.current.viewModel.isCreatingConversation).toBe(true);
    expect(result.current.viewModel.draftPrompt).toBe("first prompt");
    expect(
      getAgentSessionView({
        workspaceId: "room-1",
        agentSessionId: createdId
      })?.overlayMessages
    ).toEqual([
      expect.objectContaining({
        agentSessionId: createdId,
        payload: expect.objectContaining({ text: "first prompt" }),
        role: "user"
      })
    ]);
    expect(
      result.current.viewModel.conversationDetail?.turns[0]?.userMessages
    ).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();

    act(() => {
      resolveActivation?.({
        session: agentSession(createdId),
        activation: { mode: "new", status: "attached" }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe(createdId);
    });
    expect(result.current.viewModel.draftPrompt).toBe("");
    expect(
      result.current.viewModel.conversationDetail?.turns[0]?.userMessages
    ).toEqual([expect.objectContaining({ body: "first prompt" })]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("preserves home draft edits made while first conversation activation is pending", async () => {
    let resolveActivation:
      | ((value: AgentHostActivateAgentSessionResult) => void)
      | undefined;
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      if (input.mode === "new") {
        return new Promise<AgentHostActivateAgentSessionResult>((resolve) => {
          resolveActivation = resolve;
        });
      }
      return Promise.resolve({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      });
    });
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.updateDraftContent(draftContent("first prompt"));
      result.current.actions.submitPrompt(promptBlocks("first prompt"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "new" })
      );
    });
    const createdId = activate.mock.calls[0]![0].agentSessionId;

    act(() => {
      result.current.actions.updateDraftContent(
        draftContent("keep this draft")
      );
      resolveActivation?.({
        session: agentSession(createdId),
        activation: { mode: "new", status: "attached" }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe(createdId);
    });

    act(() => {
      result.current.actions.createConversation();
    });

    expect(result.current.viewModel.activeConversationId).toBeNull();
    expect(result.current.viewModel.draftPrompt).toBe("keep this draft");
  });

  it("keeps first conversation creation busy after the controller remounts before activation resolves", async () => {
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      if (input.mode === "new") {
        return new Promise<AgentHostActivateAgentSessionResult>(() => {
          // Keep activation pending so a remount observes the in-flight create state.
        });
      }
      return Promise.resolve({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      });
    });
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });

    const first = renderHook(() =>
      useAgentGUINodeController({
        nodeId: "node-creation-remount",
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      first.result.current.actions.submitPrompt(promptBlocks("first prompt"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "new" })
      );
    });
    expect(first.result.current.viewModel.isCreatingConversation).toBe(true);

    first.unmount();

    const second = renderHook(() =>
      useAgentGUINodeController({
        nodeId: "node-creation-remount",
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(second.result.current.viewModel.isCreatingConversation).toBe(true);
    });
    expect(second.result.current.viewModel.activeConversationId).toBeNull();
  });

  it("keeps an active prompt submission busy after the controller remounts before exec resolves", async () => {
    const exec = vi.fn(
      (_input: {
        workspaceId: string;
        agentSessionId: string;
        content: AgentPromptContentBlock[];
      }) =>
        new Promise(() => {
          // Keep exec pending so a remount must read the in-flight submit from shared state.
        })
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      exec
    });

    const first = renderHook(() =>
      useAgentGUINodeController({
        nodeId: "node-submit-remount",
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(first.result.current.viewModel.activeConversationId).toBe(
        "session-1"
      );
    });

    act(() => {
      first.result.current.actions.submitPrompt(
        promptBlocks("continue working")
      );
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        ...promptContent("continue working")
      });
    });
    expect(first.result.current.viewModel.isSubmitting).toBe(true);

    first.unmount();

    const second = renderHook(() =>
      useAgentGUINodeController({
        nodeId: "node-submit-remount",
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(second.result.current.viewModel.isSubmitting).toBe(true);
    });
  });

  it("passes the submitted prompt as the activation title without showing a pending history entry", async () => {
    const activate = vi.fn(
      (_input: AgentHostActivateAgentSessionInput) =>
        new Promise<AgentHostActivateAgentSessionResult>(() => {
          // Keep the activate request pending so the test can observe the first-create state.
        })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "hermes"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("hello from hero"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledTimes(1);
    });

    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "hermes",
        title: "hello from hero"
      })
    );
    expect(result.current.viewModel.conversations).toEqual([]);
    expect(result.current.viewModel.activeConversation).toBeNull();
    expect(result.current.viewModel.activeConversationId).toBeNull();
    expect(result.current.viewModel.isCreatingConversation).toBe(true);
    expect(
      result.current.viewModel.conversationDetail?.turns[0]?.userMessages
    ).toBeUndefined();
  });

  it("blocks OpenClaw conversation creation until the gateway is ready", async () => {
    let resolveWarmup: (() => void) | undefined;
    const warmupOpenclawGateway = vi.fn(
      () =>
        new Promise<{ accepted: boolean; ready: boolean }>((resolve) => {
          resolveWarmup = () => resolve({ accepted: true, ready: true });
        })
    );
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      warmupOpenclawGateway
    });

    const { result, unmount } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "openclaw"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(warmupOpenclawGateway).toHaveBeenCalledTimes(1);
    });
    expect(result.current.viewModel.openclawGateway?.status).toBe("starting");

    act(() => {
      result.current.actions.submitPrompt(
        promptBlocks("start with loaded default")
      );
    });
    expect(activate).not.toHaveBeenCalled();

    act(() => {
      resolveWarmup?.();
    });
    await waitFor(() => {
      expect(result.current.viewModel.openclawGateway?.status).toBe("ready");
    });

    act(() => {
      result.current.actions.submitPrompt(
        promptBlocks("start openclaw session")
      );
    });
    await waitFor(() => {
      expect(activate).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).not.toBeNull();
    });
    expect(activate.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        mode: "new",
        provider: "openclaw",
        openclawGatewayReady: true
      })
    );
    unmount();
  });

  it("replaces the optimistic conversation with the started session result", async () => {
    let createdSessionId = "";
    const activate = vi.fn(async (input: { agentSessionId: string }) => {
      createdSessionId = input.agentSessionId;
      return {
        session: agentSession(input.agentSessionId, { status: "working" }),
        activation: { mode: "new" as const, status: "attached" as const }
      };
    });
    const exec = vi.fn(async () => ({ turnId: "turn-1" }));
    const list = vi.fn(async () => ({
      presences: [],
      sessions: createdSessionId
        ? [
            workspaceAgentSession(createdSessionId, {
              effectiveStatus: "working"
            })
          ]
        : []
    }));
    const listSessionTimeline = vi.fn(async () => ({
      timelineItems: createdSessionId
        ? [
            timelineMessage({
              agentSessionId: createdSessionId,
              id: 1,
              eventId: "initial-user",
              role: "user",
              content: "hello from hero",
              turnId: "turn-1"
            })
          ]
        : []
    }));
    const subscribeEvents = vi.fn(() => vi.fn());
    const onDataChange = vi.fn();
    installAgentHostApi({
      list,
      listSessionTimeline,
      subscribeEvents,
      getState: vi.fn(async ({ agentSessionId }: { agentSessionId: string }) =>
        agentSessionState(agentSessionId, { status: "working" })
      ),
      activate,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange
      })
    );

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("hello from hero"));
    });

    await waitFor(() => {
      expect(result.current.viewModel.isCreatingConversation).toBe(false);
    });

    const startedWith = activate.mock.calls.at(-1)?.[0] as
      | {
          agentSessionId?: string;
          initialContent?: AgentPromptContentBlock[];
        }
      | undefined;
    expect(startedWith).toEqual(
      expect.objectContaining(initialPromptContent("hello from hero"))
    );
    await waitFor(() => {
      expect(result.current.viewModel.conversations).toEqual([
        expect.objectContaining({
          id: startedWith?.agentSessionId
        })
      ]);
    });
    expect(result.current.viewModel.activeConversation?.id).toBe(
      startedWith?.agentSessionId
    );
    await waitFor(() => {
      expect(subscribeEvents).toHaveBeenCalledWith(
        { workspaceId: "room-1", agentSessionId: startedWith?.agentSessionId },
        expect.any(Function)
      );
    });
    const projectedData = onDataChange.mock.calls.reduce<AgentGUINodeData>(
      (current, [updater]) => updater(current),
      agentGuiData(null)
    );
    expect(projectedData).toMatchObject({
      lastActiveAgentSessionId: startedWith?.agentSessionId,
      conversationCount: 1
    });
  });

  it("does not auto-activate an existing conversation until a prompt is submitted", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId, {
          provider: "openclaw",
          status: "ready",
          title: "OpenClaw"
        }),
        activation: { mode: input.mode, status: "attached" as const },
        events: []
      })
    );
    const exec = vi.fn(async () => ({ turnId: "turn-1" }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          {
            ...workspaceAgentSession("session-openclaw"),
            provider: "openclaw",
            title: "OpenClaw",
            effectiveStatus: "ready",
            turnPhase: "idle"
          }
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-openclaw", "openclaw"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe(
        "session-openclaw"
      );
      expect(result.current.viewModel.activeLiveState).toBe("inactive");
      expect(result.current.viewModel.canSubmit).toBe(true);
    });

    expect(activate).not.toHaveBeenCalled();

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("keep going"));
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-openclaw",
        ...promptContent("keep going")
      });
    });
    expect(activate).not.toHaveBeenCalled();
  });

  it("keeps the existing submit target after controller lifecycle dependencies update", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId, {
          provider: "claude-code",
          status: "ready",
          title: "Claude Code"
        }),
        activation: { mode: input.mode, status: "attached" as const },
        events: []
      })
    );
    const exec = vi.fn(async () => ({ turnId: "turn-1" }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          {
            ...workspaceAgentSession("session-claude"),
            provider: "claude-code",
            title: "Claude Code",
            effectiveStatus: "ready",
            turnPhase: "idle"
          }
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec
    });

    const { result, rerender } = renderHook(
      (props: { currentUserId: string }) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: props.currentUserId,
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData("session-claude", "claude-code"),
          onDataChange: vi.fn()
        }),
      { initialProps: { currentUserId: "user-1" } }
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe(
        "session-claude"
      );
    });

    rerender({ currentUserId: "user-2" });
    await Promise.resolve();

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("keep going"));
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-claude",
        ...promptContent("keep going")
      });
    });
    expect(activate).not.toHaveBeenCalled();
  });

  it("records streamed timeline items and applies state patches without adding rows after an explicit attach", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    let listCalls = 0;
    const list = vi.fn(async () => {
      listCalls += 1;
      if (listCalls === 1) {
        return snapshotWithSession("session-1");
      }
      return new Promise<AgentHostWorkspaceAgentSnapshot>(() => {});
    });
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(activityListener).toBeDefined();
      expect(result.current.viewModel.activeConversation?.id).toBe("session-1");
    });

    act(() => {
      activityListener?.(
        streamMessage({
          agentSessionId: "session-1",
          id: 1,
          eventId: "assistant-1",
          role: "assistant",
          content: "Hello"
        })
      );
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.conversationDetail?.turns[0]?.agentMessages
      ).toEqual([expect.objectContaining({ body: "Hello" })]);
    });

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          currentPhase: "working",
          title: "Updated Codex",
          occurredAtUnixMs: 20
        }
      });
    });

    expect(result.current.viewModel.conversationDetail?.turns).toHaveLength(1);
    expect(result.current.viewModel.conversations).toEqual([
      expect.objectContaining({
        id: "session-1",
        title: "Updated Codex",
        status: "working"
      })
    ]);

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          lifecycleStatus: "failed",
          currentPhase: "failed",
          lastError: "API Error: 403 Key limit exceeded (total limit)",
          occurredAtUnixMs: 40
        }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.conversations).toEqual([
        expect.objectContaining({
          id: "session-1",
          status: "failed"
        })
      ]);
      expect(result.current.viewModel.detailError).toBe(
        "API Error: 403 Key limit exceeded (total limit)"
      );
    });

    act(() => {
      activityListener?.({
        eventType: "available_commands_update",
        data: {
          agentSessionId: "session-1",
          commands: [
            { name: "web", description: "Search the web", inputHint: "query" }
          ]
        }
      });
    });

    expect(result.current.viewModel.availableCommands).toEqual([
      { name: "web", description: "Search the web", inputHint: "query" }
    ]);
  });

  it("applies permission-only state patches to the active session control state", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const getState = vi.fn(async () =>
      agentSessionState("session-1", {
        provider: "claude-code",
        permissionModeId: "default",
        settings: {
          permissionModeId: "default"
        },
        runtimeContext: {
          cwd: "/workspace",
          permissionModeId: "default"
        }
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "claude-code",
            title: "Claude Code"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn((_payload, listener) => {
        activityListener = listener;
        return vi.fn();
      }),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "claude-code"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(activityListener).toBeDefined();
      expect(
        result.current.viewModel.composerSettings.sessionSettings
          ?.permissionModeId
      ).toBe("default");
    });

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          permissionModeId: "acceptEdits",
          settings: {
            permissionModeId: "acceptEdits"
          },
          runtimeContext: {
            permissionModeId: "acceptEdits"
          },
          occurredAtUnixMs: 20
        }
      });
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.sessionSettings
          ?.permissionModeId
      ).toBe("acceptEdits");
      expect(
        result.current.viewModel.composerSettings.draftSettings.permissionModeId
      ).toBe("acceptEdits");
    });
    expect(result.current.viewModel.activeConversation?.status).toBe("ready");

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          permissionModeId: "auto",
          settings: {
            permissionModeId: "auto"
          },
          runtimeContext: {
            permissionModeId: "auto"
          },
          occurredAtUnixMs: 30
        }
      });
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.sessionSettings
          ?.permissionModeId
      ).toBe("auto");
      expect(
        result.current.viewModel.composerSettings.draftSettings.permissionModeId
      ).toBe("auto");
    });
    expect(result.current.viewModel.activeConversation?.status).toBe("ready");
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it("does not expose Claude Code EnterPlanMode tool events as composer plan mode", async () => {
    const updateSettings = vi.fn(async () => ({
      settings: {
        planMode: false,
        permissionModeId: "default"
      }
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "claude-code",
            title: "Claude Code"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({
        timelineItems: [
          timelineToolCall({
            agentSessionId: "session-1",
            callId: "call-enter-plan",
            name: "EnterPlanMode",
            status: "completed",
            occurredAtUnixMs: 20
          })
        ]
      })),
      subscribeEvents: vi.fn(() => vi.fn()),
      updateSettings,
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "claude-code",
          settings: {
            planMode: false,
            permissionModeId: "default"
          },
          updatedAtUnixMs: 10
        })
      )
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "claude-code"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.supportsPlanMode).toBe(
        false
      );
    });
    expect(
      result.current.viewModel.composerSettings.draftSettings.planMode
    ).toBe(false);

    act(() => {
      result.current.actions.updateComposerSettings({ planMode: true });
    });

    // Pass-through contract: the GUI no longer swallows planMode updates —
    // a real change is sent and the daemon clamps per provider support.
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
    });
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ planMode: true })
      })
    );
  });

  describe("plan mode (draft-driven) contract", () => {
    // Contract: plan mode is driven by the local draft, seeded from the stored
    // session setting. It is NOT derived from runtimeContext.mode (which for
    // codex carries the permission mode, not plan) nor pinned to the session
    // snapshot once a conversation is active. These regression-guard the two
    // bugs: codex plan being clobbered by runtimeContext.mode, and draft plan
    // toggles being swallowed once a session exists.
    function renderPlanModeController({
      updateSettings,
      sessionPlanMode,
      runtimeMode
    }: {
      updateSettings?: ReturnType<typeof vi.fn>;
      sessionPlanMode: boolean;
      runtimeMode: string;
    }) {
      installAgentHostApi({
        list: vi.fn(async () => ({
          presences: [],
          sessions: [
            workspaceAgentSession("session-1", {
              provider: "codex",
              title: "Codex"
            })
          ]
        })),
        listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
        subscribeEvents: vi.fn(() => vi.fn()),
        ...(updateSettings ? { updateSettings } : {}),
        getComposerOptions: vi.fn(async () => ({
          provider: "codex",
          modelConfig: { configurable: true, options: [] },
          reasoningConfig: { configurable: true, options: [] },
          runtimeContext: { capabilities: ["planMode"] }
        })),
        getState: vi.fn(async () =>
          agentSessionState("session-1", {
            provider: "codex",
            settings: { planMode: sessionPlanMode, permissionModeId: "auto" },
            // codex reports the permission mode in runtimeContext.mode — this
            // must not be mistaken for plan state.
            runtimeContext: {
              capabilities: ["planMode"],
              mode: runtimeMode,
              planMode: sessionPlanMode
            },
            updatedAtUnixMs: 10
          })
        )
      });
      return renderHook(() =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData("session-1", "codex"),
          onDataChange: vi.fn()
        })
      );
    }

    it("keeps codex plan on when the session stores planMode while runtimeContext.mode is a permission mode", async () => {
      const { result } = renderPlanModeController({
        sessionPlanMode: true,
        runtimeMode: "auto"
      });

      await waitFor(() => {
        expect(result.current.viewModel.composerSettings.supportsPlanMode).toBe(
          true
        );
      });
      // Bug #1 regression: runtimeContext.mode="auto" no longer clobbers plan.
      expect(
        result.current.viewModel.composerSettings.draftSettings.planMode
      ).toBe(true);
    });

    it("applies a draft plan toggle once a session is active instead of swallowing it", async () => {
      const updateSettings = vi.fn(async () => ({
        settings: { planMode: true, permissionModeId: "auto" }
      }));
      const { result } = renderPlanModeController({
        updateSettings,
        sessionPlanMode: false,
        runtimeMode: "auto"
      });

      await waitFor(() => {
        expect(result.current.viewModel.composerSettings.supportsPlanMode).toBe(
          true
        );
      });
      expect(
        result.current.viewModel.composerSettings.draftSettings.planMode
      ).toBe(false);

      act(() => {
        result.current.actions.updateComposerSettings({ planMode: true });
      });

      // Bug #2 regression: the toggle reaches the draft and is sent to the
      // daemon rather than being overridden by the session snapshot.
      await waitFor(() => {
        expect(
          result.current.viewModel.composerSettings.draftSettings.planMode
        ).toBe(true);
      });
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ planMode: true })
        })
      );
    });
  });

  describe("browser use contract", () => {
    // Contract: browser use is a per-session toggle that defaults ON for
    // providers advertising the browserUse capability, is unsupported (hidden)
    // otherwise, reflects a stored opt-out, and sends the chosen value to the
    // daemon (which then injects or omits the browser MCP).
    function renderBrowserUseController({
      advertiseCapability,
      storedBrowserUse
    }: {
      advertiseCapability: boolean;
      storedBrowserUse?: boolean;
    }) {
      const capability = advertiseCapability
        ? { capabilities: ["browserUse"] }
        : {};
      installAgentHostApi({
        list: vi.fn(async () => ({
          presences: [],
          sessions: [
            workspaceAgentSession("session-1", {
              provider: "codex",
              title: "Codex"
            })
          ]
        })),
        listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
        subscribeEvents: vi.fn(() => vi.fn()),
        getComposerOptions: vi.fn(async () => ({
          provider: "codex",
          modelConfig: { configurable: true, options: [] },
          reasoningConfig: { configurable: true, options: [] },
          runtimeContext: { ...capability }
        })),
        getState: vi.fn(async () =>
          agentSessionState("session-1", {
            provider: "codex",
            settings: {
              permissionModeId: "auto",
              ...(storedBrowserUse === undefined
                ? {}
                : { browserUse: storedBrowserUse })
            },
            runtimeContext: { ...capability }
          })
        )
      });
      return renderHook(() =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData("session-1", "codex"),
          onDataChange: vi.fn()
        })
      );
    }

    it("exposes browser use as supported and on by default when the provider advertises the capability", async () => {
      const { result } = renderBrowserUseController({
        advertiseCapability: true
      });
      await waitFor(() => {
        expect(result.current.viewModel.composerSettings.supportsBrowser).toBe(
          true
        );
      });
      expect(
        result.current.viewModel.composerSettings.draftSettings.browserUse
      ).toBe(true);
    });

    it("marks browser use unsupported when the provider does not advertise the capability", async () => {
      const { result } = renderBrowserUseController({
        advertiseCapability: false
      });
      await waitFor(() => {
        expect(
          result.current.viewModel.composerSettings.isSettingsLoading
        ).toBe(false);
      });
      expect(
        result.current.viewModel.composerSettings.supportsBrowser ?? false
      ).toBe(false);
    });

    it("reflects a stored browser-use opt-out", async () => {
      const { result } = renderBrowserUseController({
        advertiseCapability: true,
        storedBrowserUse: false
      });
      await waitFor(() => {
        expect(result.current.viewModel.composerSettings.supportsBrowser).toBe(
          true
        );
      });
      expect(
        result.current.viewModel.composerSettings.draftSettings.browserUse
      ).toBe(false);
    });

    it("sends an explicit browser-use opt-out through to the daemon", async () => {
      const updateSettings = vi.fn(async () => ({
        settings: { browserUse: false, permissionModeId: "auto" }
      }));
      installAgentHostApi({
        list: vi.fn(async () => ({
          presences: [],
          sessions: [
            workspaceAgentSession("session-1", {
              provider: "codex",
              title: "Codex"
            })
          ]
        })),
        listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
        subscribeEvents: vi.fn(() => vi.fn()),
        updateSettings,
        getComposerOptions: vi.fn(async () => ({
          provider: "codex",
          modelConfig: { configurable: true, options: [] },
          reasoningConfig: { configurable: true, options: [] },
          runtimeContext: { capabilities: ["browserUse"] }
        })),
        getState: vi.fn(async () =>
          agentSessionState("session-1", {
            provider: "codex",
            settings: { permissionModeId: "auto" },
            runtimeContext: { capabilities: ["browserUse"] }
          })
        )
      });
      const { result } = renderHook(() =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData("session-1", "codex"),
          onDataChange: vi.fn()
        })
      );
      await waitFor(() => {
        expect(result.current.viewModel.composerSettings.supportsBrowser).toBe(
          true
        );
      });

      act(() => {
        result.current.actions.updateComposerSettings({ browserUse: false });
      });

      await waitFor(() => {
        expect(updateSettings).toHaveBeenCalledTimes(1);
      });
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ browserUse: false })
        })
      );
    });
  });

  it("maps waiting aliases from streamed state patches to waiting conversations", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(activityListener).toBeDefined();
    });

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          currentPhase: "waiting_input",
          occurredAtUnixMs: 20
        }
      });
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-2",
          currentPhase: "awaiting_approval",
          occurredAtUnixMs: 21
        }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.conversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "session-1",
            status: "waiting"
          }),
          expect.objectContaining({
            id: "session-2",
            status: "waiting"
          })
        ])
      );
    });
  });

  it("maps canceled lifecycle patches to canceled conversations", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(activityListener).toBeDefined();
    });

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          lifecycleStatus: "canceled",
          occurredAtUnixMs: 20
        }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.conversations).toEqual([
        expect.objectContaining({
          id: "session-1",
          status: "canceled"
        })
      ]);
    });
  });

  it("does not resubscribe or reload durable state for streamed timeline upserts", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const unsubscribe = vi.fn();
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return unsubscribe;
    });
    const list = vi.fn(async () => snapshotWithSession("session-1"));
    const getState = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) =>
        agentSessionState(agentSessionId)
    );
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents,
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(subscribeEvents).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(getState).toHaveBeenCalledTimes(1);
    });

    act(() => {
      activityListener?.(
        streamMessage({
          agentSessionId: "session-1",
          id: 1,
          eventId: "assistant-1",
          role: "assistant",
          content: "Hello"
        })
      );
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.conversationDetail?.turns[0]?.agentMessages
      ).toEqual([expect.objectContaining({ body: "Hello" })]);
    });

    expect(list).toHaveBeenCalledTimes(1);
    expect(getState).toHaveBeenCalledTimes(1);
    expect(subscribeEvents).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          currentPhase: "working",
          occurredAtUnixMs: 20
        }
      });
    });

    expect(getState).toHaveBeenCalledTimes(1);

    expect(subscribeEvents).toHaveBeenCalledTimes(1);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("refreshes timeline when a session state replay catches up a completed fast turn", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    const list = vi.fn(async () => ({
      presences: [],
      sessions: [
        workspaceAgentSession("session-1", {
          effectiveStatus: "working",
          turnPhase: "working"
        })
      ]
    }));
    const listSessionTimeline = vi.fn(async () => ({ timelineItems: [] }));
    installAgentHostApi({
      list,
      listSessionTimeline,
      subscribeEvents
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(activityListener).toBeDefined();
    });

    act(() => {
      activityListener?.(
        streamMessage({
          agentSessionId: "session-1",
          id: 1,
          eventId: "user-1",
          role: "user",
          content: "hello",
          turnId: "turn-1"
        })
      );
      activityListener?.(
        streamMessage({
          agentSessionId: "session-1",
          id: 2,
          eventId: "assistant-1",
          role: "assistant",
          content: "Hello back",
          turnId: "turn-1"
        })
      );
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          lifecycleStatus: "active",
          currentPhase: "idle",
          occurredAtUnixMs: 2
        }
      });
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.conversationDetail?.turns[0]?.agentMessages
      ).toEqual([expect.objectContaining({ body: "Hello back" })]);
    });
    expect(listSessionTimeline.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(
      result.current.viewModel.conversation?.rows.some(
        (row) => row.kind === "processing"
      )
    ).toBe(false);
  });

  it("does not reload durable state for streamed state patches", async () => {
    vi.useFakeTimers();
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    const getState = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) =>
        agentSessionState(agentSessionId)
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents,
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(activityListener).toBeDefined();
    expect(getState).toHaveBeenCalledTimes(1);

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          currentPhase: "working",
          occurredAtUnixMs: 20
        }
      });
      vi.advanceTimersByTime(149);
    });

    expect(getState).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    // state_patch events now trigger a debounced reload to pick up runtimeContext (e.g. usage)
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it("does not reload session list or timeline for streamed state patches", async () => {
    vi.useFakeTimers();
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    const list = vi.fn(async () => snapshotWithSession("session-1"));
    const listSessionTimeline = vi.fn(async () => ({ timelineItems: [] }));
    installAgentHostApi({
      list,
      listSessionTimeline,
      subscribeEvents
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await act(async () => {
      await Promise.resolve();
    });

    const initialListLoadCount = list.mock.calls.length;
    const initialTimelineLoadCount = listSessionTimeline.mock.calls.length;
    expect(initialTimelineLoadCount).toBeGreaterThanOrEqual(1);
    expect(activityListener).toBeDefined();

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          currentPhase: "working",
          occurredAtUnixMs: 20
        }
      });
      vi.advanceTimersByTime(149);
    });

    expect(list).toHaveBeenCalledTimes(initialListLoadCount);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(list).toHaveBeenCalledTimes(initialListLoadCount);
    expect(listSessionTimeline).toHaveBeenCalledTimes(initialTimelineLoadCount);
  });

  it("treats pending replay counter changes as meaningful sync-state updates", () => {
    expect(
      syncStateRenderFieldsEqual(
        {
          agentSessionId: "session-1",
          status: "synced",
          pendingTimelineItemCount: 2,
          pendingStatePatchCount: 1,
          updatedAtUnixMs: 40
        },
        {
          agentSessionId: "session-1",
          status: "synced",
          pendingTimelineItemCount: 0,
          pendingStatePatchCount: 0,
          updatedAtUnixMs: 60
        }
      )
    ).toBe(false);
  });

  it("keeps visible conversations stable when runtime session snapshots only change references", async () => {
    installAgentHostApi({
      autoLoadRuntime: true,
      list: vi.fn(async () =>
        snapshotWithSession("session-1", { updatedAtUnixMs: 2 })
      ),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversations).toHaveLength(1);
    });
    const previousConversations = result.current.viewModel.conversations;
    const previousConversation = previousConversations[0];

    act(() => {
      emitRuntimeSessionEventForTests?.({
        eventType: "state_patch",
        data: {
          workspaceId: "room-1",
          agentSessionId: "session-1",
          provider: "codex",
          cwd: "/workspace",
          title: previousConversation?.title,
          lifecycleStatus: "active",
          currentPhase: "idle",
          occurredAtUnixMs: 2
        }
      });
    });

    expect(result.current.viewModel.conversations).toBe(previousConversations);
    expect(result.current.viewModel.conversations[0]).toBe(
      previousConversation
    );
  });

  it("keeps projected timeline models stable when a state patch only refreshes summary metadata", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({
        timelineItems: [
          timelineMessage({
            agentSessionId: "session-1",
            id: 1,
            eventId: "user-1",
            role: "user",
            content: "hello",
            turnId: "turn-1"
          })
        ]
      })),
      subscribeEvents
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(activityListener).toBeDefined();
      expect(result.current.viewModel.conversation?.rows).toHaveLength(1);
      expect(result.current.viewModel.conversationDetail?.turns).toHaveLength(
        1
      );
    });
    const initialConversation = result.current.viewModel.conversation;
    const initialConversationDetail =
      result.current.viewModel.conversationDetail;
    const initialUpdatedAtUnixMs =
      result.current.viewModel.activeConversation?.updatedAtUnixMs;

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          lifecycleStatus: "active",
          occurredAtUnixMs: 40
        }
      });
    });

    expect(result.current.viewModel.activeConversation?.updatedAtUnixMs).toBe(
      initialUpdatedAtUnixMs
    );
    expect(result.current.viewModel.conversation).toBe(initialConversation);
    expect(result.current.viewModel.conversationDetail).toBe(
      initialConversationDetail
    );
  });

  it("shares the projected source detail and keeps unchanged session references", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({
        timelineItems: [
          timelineMessage({
            agentSessionId: "session-1",
            id: 1,
            eventId: "user-1",
            role: "user",
            content: "hello",
            turnId: "turn-1"
          }),
          timelineMessage({
            agentSessionId: "session-1",
            id: 100,
            eventId: "assistant-1",
            role: "assistant",
            content: "answer",
            turnId: "turn-1"
          })
        ]
      })),
      subscribeEvents
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(activityListener).toBeDefined();
      expect(result.current.viewModel.conversationDetail?.turns).toHaveLength(
        1
      );
      expect(result.current.viewModel.conversation?.sourceDetail).toBe(
        result.current.viewModel.conversationDetail
      );
      expect(result.current.viewModel.conversation?.activity).toBe(
        result.current.viewModel.conversationDetail?.activity
      );
    });
    const initialSession = result.current.viewModel.conversationDetail?.session;
    const initialActivity =
      result.current.viewModel.conversationDetail?.activity;

    act(() => {
      activityListener?.(
        streamMessage({
          agentSessionId: "session-1",
          id: 50,
          eventId: "assistant-older-than-latest",
          role: "assistant",
          content: "Older answer",
          turnId: "turn-2"
        })
      );
    });

    await waitFor(() => {
      expect(result.current.viewModel.conversationDetail?.turns).toHaveLength(
        2
      );
    });
    expect(result.current.viewModel.conversationDetail?.session).toBe(
      initialSession
    );
    expect(result.current.viewModel.conversationDetail?.activity).toBe(
      initialActivity
    );
    expect(result.current.viewModel.conversation?.sourceDetail).toBe(
      result.current.viewModel.conversationDetail
    );
    expect(result.current.viewModel.conversation?.activity).toBe(
      result.current.viewModel.conversationDetail?.activity
    );
  });

  it("keeps a prompt title when a reloaded session list only has the provider default title", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "nexight",
            title: "AAA",
            updatedAtUnixMs: 30
          })
        ]
      })
      .mockResolvedValue({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "nexight",
            title: "Nexight",
            updatedAtUnixMs: 40
          })
        ]
      });
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result, rerender } = renderHook(
      (props) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData("session-1", "nexight"),
          onDataChange: vi.fn(),
          ...props
        }),
      {
        initialProps: {
          currentUserId: "user-1"
        }
      }
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.title).toBe("AAA");
    });

    rerender({
      currentUserId: "user-2"
    });

    await loadAgentActivityRuntimeForTests();
    await waitFor(() => {
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.title).toBe("AAA");
    });
  });

  it("clears a pinned conversation when a refreshed session list reports null pin state", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            pinnedAtUnixMs: 1700000000000,
            updatedAtUnixMs: 30
          })
        ]
      })
      .mockResolvedValue({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            pinnedAtUnixMs: null,
            updatedAtUnixMs: 40
          })
        ]
      });
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result, rerender } = renderHook(
      (props) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData("session-1"),
          onDataChange: vi.fn(),
          ...props
        }),
      {
        initialProps: {
          currentUserId: "user-1"
        }
      }
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.pinnedAtUnixMs).toBe(
        1700000000000
      );
    });

    rerender({
      currentUserId: "user-2"
    });

    await loadAgentActivityRuntimeForTests();
    await waitFor(() => {
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(
        result.current.viewModel.activeConversation?.pinnedAtUnixMs
      ).toBeNull();
    });
  });

  it("keeps a prompt title when session state reports the provider default runtime title", async () => {
    let resolveState:
      | ((
          state:
            | AgentHostAgentSessionState
            | PromiseLike<AgentHostAgentSessionState>
        ) => void)
      | null = null;
    const getState = vi.fn(
      () =>
        new Promise<AgentHostAgentSessionState>((resolve) => {
          resolveState = resolve;
        })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "nexight",
            title: "哈哈哈哈",
            updatedAtUnixMs: 30
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "nexight"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.title).toBe(
        "哈哈哈哈"
      );
    });
    await act(async () => {
      resolveState?.(
        agentSessionState("session-1", {
          provider: "nexight",
          status: "ready",
          runtimeContext: {
            cwd: "/workspace",
            title: "Nexight"
          },
          updatedAtUnixMs: 40
        })
      );
      await Promise.resolve();
    });
    expect(result.current.viewModel.activeConversation?.title).toBe("哈哈哈哈");
  });

  it("keeps a prompt title when a state patch reports the provider default title", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | null = null;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "nexight",
            title: "哈哈哈哈",
            updatedAtUnixMs: 30
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "nexight"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.title).toBe(
        "哈哈哈哈"
      );
    });
    act(() => {
      result.current.actions.retryActivation();
    });
    await waitFor(() => {
      expect(activityListener).toBeDefined();
    });

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          title: "Nexight",
          occurredAtUnixMs: 40
        }
      });
    });

    expect(result.current.viewModel.activeConversation?.title).toBe("哈哈哈哈");
  });

  it("keeps a local conversation when a refreshed raw snapshot still contains it but summary projection omits it", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        presences: [],
        sessions: [
          workspaceAgentSession("session-2", {
            provider: "nexight",
            title: "New session",
            updatedAtUnixMs: 30
          }),
          workspaceAgentSession("session-1", {
            provider: "nexight",
            title: "Streaming conversation",
            effectiveStatus: "working",
            turnPhase: "working",
            updatedAtUnixMs: 20
          })
        ]
      })
      .mockResolvedValue({
        presences: [],
        sessions: [
          workspaceAgentSession("session-2", {
            provider: "nexight",
            title: "New session",
            updatedAtUnixMs: 30
          }),
          workspaceAgentSession("session-1", {
            provider: "codex",
            title: "Streaming conversation",
            effectiveStatus: "working",
            turnPhase: "working",
            updatedAtUnixMs: 20
          })
        ]
      });
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result, rerender } = renderHook(
      (props) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData("session-2", "nexight"),
          onDataChange: vi.fn(),
          ...props
        }),
      {
        initialProps: {
          currentUserId: "user-1"
        }
      }
    );

    await waitFor(() => {
      expect(
        new Set(
          result.current.viewModel.conversations.map(
            (conversation) => conversation.id
          )
        )
      ).toEqual(new Set(["session-2", "session-1"]));
    });

    rerender({
      currentUserId: "user-2"
    });

    await loadAgentActivityRuntimeForTests();
    await waitFor(() => {
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(
        new Set(
          result.current.viewModel.conversations.map(
            (conversation) => conversation.id
          )
        )
      ).toEqual(new Set(["session-2", "session-1"]));
    });
    expect(result.current.viewModel.activeConversationId).toBe("session-2");
  });

  it("backfills a provider default conversation title from the restored timeline prompt", async () => {
    const listSessionTimeline = vi.fn(async () => ({
      timelineItems: [
        timelineMessage({
          agentSessionId: "session-1",
          id: 1,
          eventId: "user-1",
          role: "user",
          content: "AAA",
          turnId: "turn-1"
        })
      ]
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "nexight",
            title: "Nexight",
            updatedAtUnixMs: 30
          })
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn())
    });
    await loadAgentActivityRuntimeForTests();
    await loadAgentActivitySessionMessagesForTests("session-1");
    await loadAgentActivitySessionMessagesForTests("session-2");

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "nexight"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(listSessionTimeline).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN
      });
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.title).toBe("AAA");
    });
  });

  it("restores prompt titles for the old room session list before a conversation is selected", async () => {
    const listSessionTimeline = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) => ({
        timelineItems: [
          timelineMessage({
            agentSessionId,
            id: agentSessionId === "session-1" ? 1 : 2,
            eventId: `${agentSessionId}-user`,
            role: "user",
            content: agentSessionId === "session-1" ? "AAA" : "BBB",
            turnId: `${agentSessionId}-turn`
          })
        ]
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "nexight",
            title: "Nexight",
            updatedAtUnixMs: 30
          }),
          workspaceAgentSession("session-2", {
            provider: "nexight",
            title: "Nexight",
            updatedAtUnixMs: 20
          })
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn())
    });
    await loadAgentActivityRuntimeForTests();
    await loadAgentActivitySessionMessagesForTests("session-1");
    await loadAgentActivitySessionMessagesForTests("session-2");

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "nexight"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(listSessionTimeline).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        Object.fromEntries(
          result.current.viewModel.conversations.map((conversation) => [
            conversation.id,
            conversation.title
          ])
        )
      ).toEqual({
        "session-1": "AAA",
        "session-2": "BBB"
      });
    });
  });

  it("does not mark a completed conversation unread when another controller has it active", async () => {
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() => ({
      first: useAgentGUINodeController({
        nodeId: "node-active-session-1",
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      }),
      second: useAgentGUINodeController({
        nodeId: "node-active-session-2",
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-2"),
        onDataChange: vi.fn()
      })
    }));

    await waitFor(() => {
      expect(result.current.first.viewModel.activeConversationId).toBe(
        "session-1"
      );
      expect(result.current.second.viewModel.activeConversationId).toBe(
        "session-2"
      );
      expect(
        result.current.first.viewModel.conversations.some(
          (conversation) => conversation.id === "session-2"
        )
      ).toBe(true);
    });

    act(() => {
      emitRuntimeSessionEventForTests?.({
        eventType: "state_patch",
        data: {
          workspaceId: "room-1",
          agentSessionId: "session-2",
          lifecycleStatus: "completed",
          occurredAtUnixMs: 20
        }
      });
    });

    await waitFor(() => {
      expect(result.current.first.viewModel.conversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "session-2",
            status: "completed",
            hasUnreadCompletion: false
          })
        ])
      );
    });
  });

  it("keeps a busy inactive conversation subscribed so its final state can settle in the list", async () => {
    const retainEventStream = vi
      .fn()
      .mockImplementation(
        async ({ agentSessionId }: { agentSessionId: string }) => ({
          leaseId: `lease:${agentSessionId}`,
          retained: true
        })
      );
    const releaseEventStream = vi.fn(async () => ({ released: true }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "ready",
            turnPhase: "idle"
          }),
          workspaceAgentSession("session-2", {
            effectiveStatus: "working",
            turnPhase: "working"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      retainEventStream,
      releaseEventStream
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(retainEventStream).toHaveBeenCalledTimes(2);
    });
    expect(retainEventStream).toHaveBeenCalledWith({
      workspaceId: "room-1",
      agentSessionId: "session-1"
    });
    expect(retainEventStream).toHaveBeenCalledWith({
      workspaceId: "room-1",
      agentSessionId: "session-2"
    });

    act(() => {
      emitRuntimeSessionEventForTests?.({
        eventType: "state_patch",
        data: {
          workspaceId: "room-1",
          agentSessionId: "session-2",
          lifecycleStatus: "completed",
          occurredAtUnixMs: 20
        }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.conversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "session-2",
            status: "completed",
            hasUnreadCompletion: true
          })
        ])
      );
    });
    expect(releaseEventStream).not.toHaveBeenCalled();
  });

  it("keeps a background session retained after an active idle patch so completion can still arrive", async () => {
    const retainEventStream = vi
      .fn()
      .mockImplementation(
        async ({ agentSessionId }: { agentSessionId: string }) => ({
          leaseId: `lease:${agentSessionId}`,
          retained: true
        })
      );
    const releaseEventStream = vi.fn(async () => ({ released: true }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "ready",
            turnPhase: "idle"
          }),
          workspaceAgentSession("session-2", {
            effectiveStatus: "working",
            turnPhase: "working"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      retainEventStream,
      releaseEventStream
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(retainEventStream).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-2"
      });
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    vi.useFakeTimers();

    act(() => {
      emitRuntimeSessionEventForTests?.({
        eventType: "state_patch",
        data: {
          workspaceId: "room-1",
          agentSessionId: "session-2",
          lifecycleStatus: "active",
          currentPhase: "idle",
          turn: {
            turnId: "turn-2",
            phase: "idle",
            outcome: "completed"
          },
          occurredAtUnixMs: 20
        }
      });
    });

    expect(result.current.viewModel.conversations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "session-2",
          status: "ready",
          hasUnreadCompletion: true,
          unreadCompletionKey: "turn:session-2:turn-2:completed"
        })
      ])
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(
      getAgentSessionView({
        workspaceId: "room-1",
        agentSessionId: "session-2"
      })
    ).toEqual(expect.objectContaining({ isLive: true, watcherCount: 1 }));
    expect(releaseEventStream).not.toHaveBeenCalledWith({
      leaseId: "lease:session-2"
    });
  });

  it("marks a background conversation unread when an assistant message completes", async () => {
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "ready",
            turnPhase: "idle"
          }),
          workspaceAgentSession("session-2", {
            effectiveStatus: "working",
            turnPhase: "working"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
      expect(
        result.current.viewModel.conversations.some(
          (conversation) => conversation.id === "session-2"
        )
      ).toBe(true);
    });

    act(() => {
      emitRuntimeSessionEventForTests?.({
        eventType: "message_update",
        data: {
          workspaceId: "room-1",
          agentSessionId: "session-2",
          messageId: "message-2",
          seq: 20,
          turnId: "turn-2",
          role: "assistant",
          kind: "message",
          status: "completed",
          payload: { text: "Done" },
          occurredAtUnixMs: 20,
          completedAtUnixMs: 20
        }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.conversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "session-2",
            status: "working",
            hasUnreadCompletion: true,
            unreadCompletionKey: "turn:session-2:turn-2:completed"
          })
        ])
      );
    });
  });

  it("keeps a locally completed conversation status when the refreshed snapshot is stale", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "working",
            turnPhase: "working",
            updatedAtUnixMs: 10
          })
        ]
      })
      .mockResolvedValueOnce({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "working",
            turnPhase: "working",
            updatedAtUnixMs: 10
          })
        ]
      });
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(activityListener).toBeDefined();
    });

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          lifecycleStatus: "completed",
          occurredAtUnixMs: 20
        }
      });
    });

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.viewModel.conversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "session-1",
            status: "completed"
          })
        ])
      );
    });
  });

  it("preserves a newer local working status over an older ready reload", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "working",
            turnPhase: "working",
            updatedAtUnixMs: 100
          })
        ]
      })
      .mockResolvedValue({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "idle",
            turnPhase: "idle",
            updatedAtUnixMs: 50
          })
        ]
      })
      .mockResolvedValue({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "idle",
            turnPhase: "idle",
            updatedAtUnixMs: 50
          })
        ]
      });
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result, rerender } = renderHook(
      (props) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData("session-1"),
          onDataChange: vi.fn(),
          ...props
        }),
      {
        initialProps: {
          currentUserId: "user-1"
        }
      }
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe(
        "working"
      );
    });

    rerender({
      currentUserId: "user-2"
    });

    await loadAgentActivityRuntimeForTests();
    await waitFor(() => {
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe(
        "working"
      );
    });
  });

  it("keeps a completed state patch when an older working session snapshot resolves later", async () => {
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    let resolveGetState:
      | ((value: AgentHostAgentSessionState) => void)
      | undefined;
    const getState = vi.fn(
      () =>
        new Promise<AgentHostAgentSessionState>((resolve) => {
          resolveGetState = resolve;
        })
    );
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "working",
            turnPhase: "working",
            updatedAtUnixMs: 100
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents,
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(activityListener).toBeDefined();
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe(
        "working"
      );
    });

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          lifecycleStatus: "active",
          currentPhase: "idle",
          turn: {
            turnId: "turn-1",
            phase: "idle",
            outcome: "completed"
          },
          occurredAtUnixMs: 200
        }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe("ready");
    });

    act(() => {
      resolveGetState?.(
        agentSessionState("session-1", {
          status: "working",
          updatedAtUnixMs: 150
        })
      );
    });

    await Promise.resolve();

    expect(result.current.viewModel.activeConversation?.status).toBe("ready");
  });

  it("accepts a newer ready reload over a stale local working status", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "working",
            turnPhase: "working",
            updatedAtUnixMs: 100
          })
        ]
      })
      .mockResolvedValue({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "idle",
            turnPhase: "idle",
            updatedAtUnixMs: 110
          })
        ]
      })
      .mockResolvedValue({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "idle",
            turnPhase: "idle",
            updatedAtUnixMs: 110
          })
        ]
      });
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result, rerender } = renderHook(
      (props) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData("session-1"),
          onDataChange: vi.fn(),
          ...props
        }),
      {
        initialProps: {
          currentUserId: "user-1"
        }
      }
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe(
        "working"
      );
    });

    rerender({
      currentUserId: "user-2"
    });

    await loadAgentActivityRuntimeForTests();
    await waitFor(() => {
      expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe("ready");
    });
  });

  it("reloads settled summaries when selecting a stale working conversation", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "working",
            turnPhase: "working",
            updatedAtUnixMs: 100
          }),
          workspaceAgentSession("session-2", {
            effectiveStatus: "ready",
            turnPhase: "idle",
            updatedAtUnixMs: 90
          })
        ]
      })
      .mockResolvedValueOnce({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "idle",
            turnPhase: "idle",
            updatedAtUnixMs: 110
          }),
          workspaceAgentSession("session-2", {
            effectiveStatus: "idle",
            turnPhase: "idle",
            updatedAtUnixMs: 90
          })
        ]
      });
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async ({ agentSessionId }: { agentSessionId: string }) =>
        agentSessionState(agentSessionId, {
          status: "ready",
          updatedAtUnixMs: 110
        })
      )
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-2"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "session-1", status: "working" }),
          expect.objectContaining({ id: "session-2", status: "ready" })
        ])
      );
    });

    act(() => {
      result.current.actions.selectConversation("session-1");
    });

    await loadAgentActivityRuntimeForTests();
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.viewModel.conversations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "session-1", status: "ready" }),
          expect.objectContaining({ id: "session-2", status: "ready" })
        ])
      );
    });
  });

  it("does not refresh a conversation timestamp when it is only selected for viewing", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T07:00:00.000Z"));

    expect(
      resolveConversationUpdatedAtUnixMsFromSessionState({
        currentUpdatedAtUnixMs: 100,
        snapshotUpdatedAtUnixMs: undefined,
        source: "conversation-selected"
      })
    ).toBe(100);

    expect(
      resolveConversationUpdatedAtUnixMsFromSessionState({
        currentUpdatedAtUnixMs: 100,
        snapshotUpdatedAtUnixMs: 120,
        source: "conversation-selected"
      })
    ).toBe(100);

    expect(
      resolveConversationUpdatedAtUnixMsFromSessionState({
        currentUpdatedAtUnixMs: 100,
        snapshotUpdatedAtUnixMs: undefined,
        source: "activity-stream"
      })
    ).toBe(new Date("2026-05-26T07:00:00.000Z").getTime());
  });

  it("accepts a settled session-state snapshot when local working has no pending live replay", async () => {
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "working",
            turnPhase: "working",
            updatedAtUnixMs: 100
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({
        timelineItems: [
          timelineMessage({
            agentSessionId: "session-1",
            id: 120,
            eventId: "assistant-1",
            role: "assistant",
            content: "done",
            turnId: "turn-1"
          })
        ]
      })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async ({ agentSessionId }: { agentSessionId: string }) =>
        agentSessionState(agentSessionId, {
          status: "ready",
          updatedAtUnixMs: 90
        })
      )
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe("ready");
    });
  });

  it("settles a working conversation once timeline evidence confirms a ready session snapshot", () => {
    const status = resolveConversationStatusAfterTimelineUpdate({
      currentStatus: "working",
      incomingTimelineStatus: null,
      sessionState: agentSessionState("session-1", {
        status: "ready",
        updatedAtUnixMs: 2
      }),
      timelineItems: [
        timelineMessage({
          agentSessionId: "session-1",
          id: 21,
          eventId: "assistant-turn-2",
          role: "assistant",
          content: "done",
          turnId: "turn-2"
        })
      ]
    });

    expect(status).toBe("ready");
  });

  it("keeps a working conversation busy when the ready session snapshot arrives before settled timeline evidence", () => {
    const status = resolveConversationStatusAfterTimelineUpdate({
      currentStatus: "working",
      incomingTimelineStatus: null,
      sessionState: agentSessionState("session-1", {
        status: "ready",
        updatedAtUnixMs: 2
      }),
      timelineItems: [
        timelineMessage({
          agentSessionId: "session-1",
          id: 20,
          eventId: "user-turn-2",
          role: "user",
          content: "follow-up prompt",
          turnId: "turn-2"
        })
      ]
    });

    expect(status).toBe("working");
  });

  it("projects waiting timeline updates over an existing working conversation", () => {
    const status = resolveConversationStatusAfterTimelineUpdate({
      currentStatus: "working",
      incomingTimelineStatus: "waiting",
      sessionState: agentSessionState("session-1", {
        status: "working",
        updatedAtUnixMs: 2
      }),
      timelineItems: [
        timelineToolCall({
          agentSessionId: "session-1",
          callId: "approval-1",
          name: "Approval",
          status: "waiting_approval",
          occurredAtUnixMs: 21
        })
      ]
    });

    expect(status).toBe("waiting");
  });

  it("keeps rejected approval decisions completed when the session snapshot is canceled", () => {
    const approval = timelineToolCall({
      agentSessionId: "session-1",
      callId: "approval-1",
      name: "Allow command",
      status: "completed",
      occurredAtUnixMs: 21
    });
    approval.itemType = "call.completed";
    approval.callType = "approval";
    approval.payload = {
      callType: "approval",
      toolName: "Approval",
      status: "completed",
      output: {
        requestId: "permission-1",
        selectedId: "reject"
      }
    };

    const status = resolveConversationStatusAfterTimelineUpdate({
      currentStatus: "working",
      incomingTimelineStatus: null,
      sessionState: agentSessionState("session-1", {
        status: "canceled",
        updatedAtUnixMs: 22
      }),
      timelineItems: [approval]
    });

    expect(status).toBe("completed");
  });

  it("keeps approved approval decisions canceled when the session snapshot is canceled", () => {
    const approval = timelineToolCall({
      agentSessionId: "session-1",
      callId: "approval-1",
      name: "Allow command",
      status: "completed",
      occurredAtUnixMs: 21
    });
    approval.itemType = "call.completed";
    approval.callType = "approval";
    approval.payload = {
      callType: "approval",
      toolName: "Approval",
      status: "completed",
      output: {
        requestId: "permission-1",
        selectedId: "allow_once"
      }
    };

    const status = resolveConversationStatusAfterTimelineUpdate({
      currentStatus: "working",
      incomingTimelineStatus: null,
      sessionState: agentSessionState("session-1", {
        status: "canceled",
        updatedAtUnixMs: 22
      }),
      timelineItems: [approval]
    });

    expect(status).toBe("canceled");
  });

  it("unactivates a new session when activation resolves after the user switches away", async () => {
    let resolveNewActivation:
      | ((value: AgentHostActivateAgentSessionResult) => void)
      | undefined;
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      if (input.mode === "new") {
        return new Promise<AgentHostActivateAgentSessionResult>((resolve) => {
          resolveNewActivation = resolve;
        });
      }
      return Promise.resolve({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      });
    });
    const unactivate = vi.fn(async (_input: { agentSessionId: string }) => ({
      agentSessionId: _input.agentSessionId,
      buffered: true
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      unactivate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("create one"));
    });
    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "new" })
      );
    });
    const createdId = activate.mock.calls[0]![0].agentSessionId;

    act(() => {
      result.current.actions.selectConversation("session-existing");
    });
    act(() => {
      resolveNewActivation?.({
        session: agentSession(createdId),
        activation: { mode: "new", status: "attached" }
      });
    });

    await waitFor(() => {
      const staleUnactivations = unactivate.mock.calls.filter(
        (call) => call[0]?.agentSessionId === createdId
      );
      expect(staleUnactivations.length).toBeGreaterThanOrEqual(2);
    });
    expect(result.current.viewModel.activeConversationId).toBe(
      "session-existing"
    );
  });

  it("only unactivates a late new session once after unmount", async () => {
    let resolveNewActivation:
      | ((value: AgentHostActivateAgentSessionResult) => void)
      | undefined;
    const activate = vi.fn((input: AgentHostActivateAgentSessionInput) => {
      if (input.mode === "new") {
        return new Promise<AgentHostActivateAgentSessionResult>((resolve) => {
          resolveNewActivation = resolve;
        });
      }
      return Promise.resolve({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      });
    });
    const unactivate = vi.fn(async (_input: { agentSessionId: string }) => ({
      agentSessionId: _input.agentSessionId,
      buffered: true
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      unactivate
    });

    const { result, unmount } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("create one"));
    });
    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "new" })
      );
    });
    const createdId = activate.mock.calls[0]![0].agentSessionId;

    unmount();
    act(() => {
      resolveNewActivation?.({
        session: agentSession(createdId),
        activation: { mode: "new", status: "attached" }
      });
    });

    await waitFor(() => {
      const staleUnactivations = unactivate.mock.calls.filter(
        (call) => call[0]?.agentSessionId === createdId
      );
      expect(staleUnactivations).toHaveLength(1);
    });
  });

  it("does not run unmount cleanup when activation state changes", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    const unactivate = vi.fn(async (_input: { agentSessionId: string }) => ({
      agentSessionId: _input.agentSessionId,
      buffered: true
    }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      unactivate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeLiveState).toBe("active");
    });

    expect(unactivate).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "session-1" })
    );
    expect(result.current.viewModel.activeConversationId).toBe("session-1");
  });

  it("keeps home visible and preserves draft when activation fails immediately", async () => {
    const activate = vi.fn(
      async (_input: AgentHostActivateAgentSessionInput) => {
        throw new Error("runtime not connected");
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.updateDraftContent(draftContent("create one"));
      result.current.actions.submitPrompt(promptBlocks("create one"));
    });

    await waitFor(() => {
      expect(result.current.viewModel.isCreatingConversation).toBe(false);
    });

    const startedWith = activate.mock.calls.at(-1)?.[0];
    expect(startedWith?.agentSessionId).toBeTruthy();
    expect(result.current.viewModel.activeConversationId).toBeNull();
    expect(result.current.viewModel.conversations).toEqual([]);
    expect(result.current.viewModel.activeConversation).toBeNull();
    expect(result.current.viewModel.draftPrompt).toBe("create one");
    expect(result.current.viewModel.detailError).toBe("runtime not connected");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("clears the per-session messages-loading flag when a new conversation activation fails", async () => {
    const activate = vi.fn(
      async (_input: AgentHostActivateAgentSessionInput) => {
        throw new Error("runtime not connected");
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("create one"));
    });

    await waitFor(() => {
      expect(result.current.viewModel.isCreatingConversation).toBe(false);
    });

    const failedId = activate.mock.calls.at(-1)?.[0]?.agentSessionId;
    expect(failedId).toBeTruthy();
    // The failure is surfaced and the global loading flag is cleared today.
    expect(result.current.viewModel.detailError).toBe("runtime not connected");
    expect(result.current.viewModel.isLoadingMessages).toBe(false);
    expect(
      getAgentSessionView({
        workspaceId: "room-1",
        agentSessionId: failedId as string
      })?.overlayMessages
    ).toEqual([]);
    expect(
      getAgentSessionView({
        workspaceId: "room-1",
        agentSessionId: failedId as string
      })?.detailMessages
    ).toEqual([]);
    // First-create failure should not leave a per-session messages-loading flag
    // behind; otherwise a later detail view for the id can spin forever.
    await waitFor(() => {
      expect(
        getAgentSessionView({
          workspaceId: "room-1",
          agentSessionId: failedId as string
        })?.isLoadingMessages
      ).not.toBe(true);
    });
  });

  it("keeps durable history visible and retries attach when explicitly requested again", async () => {
    const activate = vi.fn(
      async (_input: AgentHostActivateAgentSessionInput) => {
        throw new Error("resume failed");
      }
    );
    const listSessionTimeline = vi.fn(async () => ({
      timelineItems: [
        timelineMessage({
          agentSessionId: "session-1",
          id: 1,
          eventId: "user-1",
          role: "user",
          content: "你好"
        })
      ]
    }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.conversationDetail?.turns[0]?.userMessages
      ).toEqual([expect.objectContaining({ body: "你好" })]);
    });
    expect(result.current.viewModel.activationError).toBeNull();
    expect(result.current.viewModel.detailError).toBeNull();

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(result.current.viewModel.activationError).toBe("resume failed");
    });

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledTimes(2);
    });
    expect(listSessionTimeline.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(
      result.current.viewModel.conversationDetail?.turns[0]?.userMessages
    ).toEqual([expect.objectContaining({ body: "你好" })]);
    expect(result.current.viewModel.detailError).toBeNull();
  });

  it("keeps durable history visible and blocks retry when the provider session is gone", async () => {
    setAgentGuiI18nTestLocale("en");
    const activate = vi.fn(
      async (_input: AgentHostActivateAgentSessionInput) => {
        throw {
          code: "agent.provider_session_not_found",
          message: "The previous agent session can no longer be restored.",
          debugMessage: "provider_session_id=session-1 missing in codex ACP"
        };
      }
    );
    const exec = vi.fn(async () => ({
      agentSessionId: "session-1",
      turnId: "turn-1",
      accepted: true,
      sessionStatus: "working"
    }));
    const submitInteractive = vi.fn(async () => ({
      agentSessionId: "session-1",
      requestId: "request-1",
      accepted: true,
      events: []
    }));
    const cancel = vi.fn(async () => ({
      agentSessionId: "session-1",
      canceled: true,
      events: []
    }));
    const listSessionTimeline = vi.fn(async () => ({
      timelineItems: [
        timelineMessage({
          agentSessionId: "session-1",
          id: 1,
          eventId: "user-1",
          role: "user",
          content: "你好"
        })
      ]
    }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec,
      submitInteractive,
      cancel,
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          authState: "auth_required",
          runtimeContext: {
            authMessage: "Please sign in to continue this session."
          },
          pendingInteractive: {
            kind: "approval",
            requestId: "request-1",
            toolName: "Run command",
            status: "waiting",
            input: {
              callId: "call-1",
              options: [
                { id: "allow_once", label: "Allow once", kind: "allow_once" }
              ]
            }
          }
        })
      )
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.conversationDetail?.turns[0]?.userMessages
      ).toEqual([expect.objectContaining({ body: "你好" })]);
    });
    expect(result.current.viewModel.activationError).toBeNull();
    expect(result.current.viewModel.sessionChrome.recovery).toBeNull();

    act(() => {
      result.current.actions.retryActivation();
    });

    await waitFor(() => {
      expect(result.current.viewModel.activationError).toBe(
        "This session history is still available, but the underlying provider session can no longer be restored."
      );
    });
    expect(result.current.viewModel.sessionChrome.recovery).toEqual(
      expect.objectContaining({
        kind: "failed",
        canRetry: false
      })
    );
    expect(result.current.viewModel.sessionChrome.auth).toBeNull();
    expect(result.current.viewModel.pendingApproval).toBeNull();
    expect(result.current.viewModel.pendingInteractivePrompt).toBeNull();
    expect(result.current.viewModel.detailError).toBeNull();

    act(() => {
      result.current.actions.retryActivation();
      result.current.actions.selectConversation("session-1");
      result.current.actions.submitPrompt(promptBlocks("please continue"));
      result.current.actions.submitApprovalOption("request-1", "allow_once");
      result.current.actions.interruptCurrentTurn("No running response");
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledTimes(1);
    });
    expect(exec).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(listSessionTimeline.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(
        result.current.viewModel.conversationDetail?.turns[0]?.userMessages
      ).toEqual([expect.objectContaining({ body: "你好" })]);
    });
  });

  it("returns to the composer homepage when the selected session no longer exists", async () => {
    const getState = vi.fn(async () => {
      throw {
        code: "session.not_found",
        message: "Session not found.",
        debugMessage: "agent session not found"
      };
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({
        timelineItems: [
          timelineMessage({
            agentSessionId: "session-1",
            id: 1,
            eventId: "user-1",
            role: "user",
            content: "Hello"
          })
        ]
      })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(getState).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBeNull();
    });
    expect(result.current.viewModel.conversations).toEqual([]);
    expect(result.current.viewModel.conversationDetail).toBeNull();
    expect(result.current.viewModel.detailError).toBeNull();
  });

  it("uses the session state snapshot for approval and auth chrome", async () => {
    const getState = vi.fn(async () =>
      agentSessionState("session-1", {
        authState: "auth_required",
        status: "waiting",
        runtimeContext: {
          authMessage: "Please sign in to continue this session.",
          cwd: "/workspace",
          mode: "plan",
          commands: ["read_file", "exec_command"],
          config: {
            approval_policy: "on-request"
          }
        },
        pendingInteractive: {
          kind: "approval",
          requestId: "request-1",
          toolName: "Run command",
          status: "waiting",
          input: {
            callId: "call-1",
            options: [
              { id: "allow_once", label: "Allow once", kind: "allow_once" }
            ]
          }
        }
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(getState).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1"
      });
    });
    await waitFor(() => {
      expect(result.current.viewModel.sessionChrome.auth?.message).toBe(
        "Please sign in to continue this session."
      );
    });

    expect(result.current.viewModel.pendingApproval).toEqual(
      expect.objectContaining({
        requestId: "request-1",
        callId: "call-1",
        title: "Run command"
      })
    );
    expect(result.current.viewModel.canSubmit).toBe(false);
  });

  it("hides busy UI and reports diagnostics when cancel finds no active turn", async () => {
    let sessionStatus: "ready" | "waiting" = "waiting";
    const cancel = vi.fn(async () => {
      sessionStatus = "ready";
      return {
        agentSessionId: "session-1",
        canceled: false,
        reason: "no_active_turn",
        sessionStatus: "ready"
      };
    });
    const getState = vi.fn(async () =>
      sessionStatus === "waiting"
        ? agentSessionState("session-1", {
            status: "waiting",
            pendingInteractive: {
              kind: "approval",
              requestId: "request-1",
              toolName: "Run command",
              status: "waiting",
              input: {
                callId: "call-1",
                options: [
                  {
                    id: "allow_once",
                    label: "Allow once",
                    kind: "allow_once"
                  }
                ]
              }
            }
          })
        : agentSessionState("session-1", { status: "ready" })
    );
    const reportDiagnostic = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      cancel,
      getState
    });
    (
      window as unknown as { agentActivityRuntime: AgentActivityRuntime }
    ).agentActivityRuntime.reportDiagnostic = reportDiagnostic;

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingApproval?.requestId).toBe(
        "request-1"
      );
    });
    expect(result.current.viewModel.canQueueWhileBusy).toBe(false);

    act(() => {
      result.current.actions.interruptCurrentTurn("No running response");
    });

    expect(result.current.viewModel.pendingApproval).toBeNull();
    expect(result.current.viewModel.pendingInteractivePrompt).toBeNull();
    await waitFor(() => {
      expect(cancel).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        reason: "user_interrupt"
      });
    });
    await waitFor(() => {
      expect(result.current.viewModel.canQueueWhileBusy).toBe(false);
    });
    expect(result.current.viewModel.pendingApproval).toBeNull();
    expect(result.current.viewModel.detailError).toBeNull();
    const diagnosticPayload = reportDiagnostic.mock.calls.find(
      ([payload]) => payload?.event === "agent.gui.cancel.noop"
    )?.[0];
    expect(diagnosticPayload).toEqual({
      details: expect.objectContaining({
        agentSessionId: "session-1",
        busySource: "interactive_prompt",
        canceled: false,
        cancelReason: "no_active_turn",
        currentSessionStatus: "waiting",
        returnedSessionNonBusy: true,
        returnedSessionStatus: "ready"
      }),
      event: "agent.gui.cancel.noop",
      level: "info",
      source: "agent-gui",
      workspaceId: "room-1"
    });
  });

  describe.each(["codex", "claude-code"] as const)(
    "compact busy recovery (%s)",
    (provider) => {
      it("clears busy UI when cancel returns a raw core created status", async () => {
        let sessionStatus: "waiting" | "created" = "waiting";
        const cancel = vi.fn(async () => {
          sessionStatus = "created";
          return {
            agentSessionId: "session-1",
            canceled: false,
            reason: "no_active_turn",
            sessionStatus: "created"
          };
        });
        const getState = vi.fn(async () =>
          sessionStatus === "waiting"
            ? agentSessionState("session-1", {
                status: "waiting",
                pendingInteractive: {
                  kind: "approval",
                  requestId: "request-1",
                  toolName: "Run command",
                  status: "waiting",
                  input: {
                    callId: "call-1",
                    options: [
                      {
                        id: "allow_once",
                        label: "Allow once",
                        kind: "allow_once"
                      }
                    ]
                  }
                }
              })
            : agentSessionState("session-1", { status: "created" })
        );
        const reportDiagnostic = vi.fn();
        // Use a session with no turnPhase so result.session.currentPhase is null
        // after cancel. Only projectCoreSessionStatus("created") → "ready" can
        // then make cancelResultSessionStatusIsNonBusy return true; without the
        // projection "created" is unknown to the normalizer → returns null →
        // returnedSessionNonBusy: false, causing the assertion below to fail.
        installAgentHostApi({
          list: vi.fn(async () => ({
            presences: [],
            sessions: [
              workspaceAgentSession("session-1", { turnPhase: undefined })
            ]
          })),
          listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
          subscribeEvents: vi.fn(() => vi.fn()),
          cancel,
          getState
        });
        (
          window as unknown as { agentActivityRuntime: AgentActivityRuntime }
        ).agentActivityRuntime.reportDiagnostic = reportDiagnostic;

        const { result } = renderHook(() =>
          useAgentGUINodeController({
            workspaceId: "room-1",
            currentUserId: "user-1",
            workspacePath: "/workspace",
            avoidGroupingEdits: false,
            data: agentGuiData("session-1", provider),
            onDataChange: vi.fn()
          })
        );

        await waitFor(() => {
          expect(result.current.viewModel.pendingApproval?.requestId).toBe(
            "request-1"
          );
        });

        act(() => {
          result.current.actions.interruptCurrentTurn("No running response");
        });

        await waitFor(() => {
          expect(result.current.viewModel.canQueueWhileBusy).toBe(false);
        });
        const diagnosticPayload = reportDiagnostic.mock.calls.find(
          ([payload]) => payload?.event === "agent.gui.cancel.noop"
        )?.[0];
        expect(diagnosticPayload?.details).toEqual(
          expect.objectContaining({
            returnedSessionNonBusy: true,
            returnedSessionStatus: "created"
          })
        );
      });
    }
  );

  it("promotes provider-session-not-found from getState into the live recovery state", async () => {
    const getState = vi.fn(async () => {
      throw {
        code: "agent.provider_session_not_found",
        debugMessage: "provider_session_id=session-1 missing in codex ACP"
      };
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(getState).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1"
      });
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeLiveState).toBe("failed");
    });
    expect(result.current.viewModel.activationError).toBe(
      "This session history is still available, but the underlying provider session can no longer be restored."
    );
    expect(result.current.viewModel.canSubmit).toBe(false);
    expect(result.current.viewModel.sessionChrome.recovery).toEqual(
      expect.objectContaining({
        kind: "failed",
        canRetry: false
      })
    );
  });

  it("promotes non-local resume failures into a non-retryable live recovery state", async () => {
    const getState = vi.fn(async () => {
      throw {
        code: "agent.resume_session_not_local",
        debugMessage:
          "provider_session_id=session-1 missing locally on this machine"
      };
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(getState).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1"
      });
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeLiveState).toBe("failed");
    });
    expect(result.current.viewModel.activationError).toBe(
      "This session cannot be resumed on this device. Start a new session and @this session to keep going."
    );
    expect(result.current.viewModel.canSubmit).toBe(false);
    expect(result.current.viewModel.sessionChrome.recovery).toEqual(
      expect.objectContaining({
        kind: "failed",
        canRetry: false
      })
    );
  });

  it("promotes unstructured non-local resume messages from getState into a non-retryable live recovery state", async () => {
    const getState = vi.fn(async () => {
      throw new Error(
        "The previous agent session is not available on this machine."
      );
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(getState).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1"
      });
    });
    await waitFor(() => {
      expect(result.current.viewModel.activeLiveState).toBe("failed");
    });
    expect(result.current.viewModel.activationError).toBe(
      "This session cannot be resumed on this device. Start a new session and @this session to keep going."
    );
    expect(result.current.viewModel.canSubmit).toBe(false);
    expect(result.current.viewModel.sessionChrome.recovery).toEqual(
      expect.objectContaining({
        kind: "failed",
        canRetry: false,
        followupAction: "continue-in-new-conversation"
      })
    );
  });

  it("disables submission up front for sessions marked non-resumable", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => {
        if (input.mode !== "existing") {
          throw new Error("unexpected new activation");
        }
        return {
          session: agentSession(input.agentSessionId, { resumable: false }),
          activation: { mode: input.mode, status: "attached" as const }
        };
      }
    );
    const exec = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [workspaceAgentSession("session-1", { resumable: false })]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", { resumable: false })
      ),
      activate,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.canSubmit).toBe(false);
    });
    expect(result.current.viewModel.sessionChrome.recovery).toEqual(
      expect.objectContaining({
        kind: "failed",
        canRetry: false,
        followupAction: "continue-in-new-conversation"
      })
    );

    const activationCallCount = activate.mock.calls.length;
    act(() => {
      result.current.actions.retryActivation();
      result.current.actions.submitPrompt(promptBlocks("hi"));
    });

    expect(activate).toHaveBeenCalledTimes(activationCallCount);
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not keep reloading durable session state after a non-local resume failure", async () => {
    vi.useFakeTimers();
    let activityListener:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const subscribeEvents = vi.fn((_payload, listener) => {
      activityListener = listener;
      return vi.fn();
    });
    const getState = vi
      .fn()
      .mockImplementationOnce(
        async ({ agentSessionId }: { agentSessionId: string }) =>
          agentSessionState(agentSessionId)
      )
      .mockImplementation(async () => {
        throw {
          code: "agent.resume_session_not_local",
          debugMessage:
            "provider_session_id=session-1 missing locally on this machine"
        };
      });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents,
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.retryActivation();
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(getState).toHaveBeenCalledTimes(1);
    expect(activityListener).toBeDefined();

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          currentPhase: "working",
          occurredAtUnixMs: 20
        }
      });
      vi.advanceTimersByTime(150);
    });

    await act(async () => {
      await Promise.resolve();
    });

    // state_patch triggers a debounced reload; non-local error is discovered and blocks further reloads
    expect(getState).toHaveBeenCalledTimes(2);
    expect(result.current.viewModel.activeLiveState).toBe("failed");

    act(() => {
      activityListener?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          currentPhase: "working",
          occurredAtUnixMs: 40
        }
      });
      vi.advanceTimersByTime(500);
    });

    // session is blocked after non-local error — subsequent patches don't trigger more reloads
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it("does not auto-reload a blocked non-local session when it is selected again later", async () => {
    const list = vi.fn(async () => ({
      presences: [],
      sessions: [
        workspaceAgentSession("session-1"),
        workspaceAgentSession("session-2")
      ]
    }));
    const getState = vi.fn(
      async ({ agentSessionId }: { agentSessionId: string }) => {
        if (agentSessionId === "session-2") {
          return agentSessionState(agentSessionId);
        }
        throw {
          code: "agent.resume_session_not_local",
          debugMessage:
            "provider_session_id=session-1 missing locally on this machine"
        };
      }
    );
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result, rerender } = renderHook(
      (props) =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          onDataChange: vi.fn(),
          ...props
        }),
      {
        initialProps: {
          data: agentGuiData("session-1")
        }
      }
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
      expect(result.current.viewModel.activeLiveState).toBe("failed");
    });
    expect(getState).toHaveBeenCalledTimes(1);

    rerender({
      data: agentGuiData("session-2")
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-2");
    });
    expect(getState).toHaveBeenCalledTimes(2);

    rerender({
      data: agentGuiData("session-1")
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it("keeps the last successful model settings when a later getState reload fails", async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce(
        agentSessionState("session-1", {
          settings: {
            model: "gpt-5",
            reasoningEffort: "high",
            permissionModeId: "auto"
          }
        })
      )
      .mockRejectedValueOnce({
        code: "agent.provider_session_not_found",
        debugMessage: "provider_session_id=session-1 missing in codex ACP"
      });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.sessionSettings
      ).toMatchObject({
        model: "gpt-5",
        reasoningEffort: "high"
      });
    });

    act(() => {
      result.current.actions.selectConversation("session-1");
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeLiveState).toBe("failed");
    });
    expect(
      result.current.viewModel.composerSettings.sessionSettings
    ).toMatchObject({
      model: "gpt-5",
      reasoningEffort: "high"
    });
    expect(result.current.viewModel.composerSettings.modelUnavailable).toBe(
      false
    );
    expect(result.current.viewModel.composerSettings.draftSettings.model).toBe(
      "gpt-5"
    );
  });

  it("opens a new session draft with a session mention for non-local recovery failures", async () => {
    useAccountStore.getState().applySnapshot({
      authStatus: "authenticated",
      currentUserId: "user-1",
      currentUser: {
        userId: "user-1",
        name: "wang jomes"
      },
      profilesByUserId: {
        "user-1": {
          userId: "user-1",
          name: "wang jomes"
        }
      }
    });
    const getState = vi.fn(async () => {
      throw {
        code: "agent.resume_session_not_local",
        debugMessage:
          "provider_session_id=session-1 missing locally on this machine"
      };
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeLiveState).toBe("failed");
    });

    act(() => {
      result.current.actions.updateDraftContent(draftContent("hi"));
    });
    act(() => {
      result.current.actions.continueInNewConversation();
    });

    expect(result.current.viewModel.activeConversationId).toBeNull();
    expect(result.current.viewModel.draftPrompt).toContain(
      "[@wang jomes & Codex Current task]"
    );
    expect(result.current.viewModel.draftPrompt).not.toContain(
      "[@this session"
    );
    expect(result.current.viewModel.draftPrompt).toContain(
      "mention://agent-session/session-1?workspaceId=room-1"
    );
    expect(result.current.viewModel.draftPrompt).toContain("hi");
  });

  it("clears a latched provider-session-not-found failure after a later healthy session state load", async () => {
    const getState = vi
      .fn()
      .mockRejectedValueOnce({
        code: "agent.provider_session_not_found",
        debugMessage: "provider_session_id=session-1 missing in codex ACP"
      })
      .mockResolvedValue(agentSessionState("session-1"));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeLiveState).toBe("failed");
    });

    act(() => {
      result.current.actions.selectConversation("session-1");
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeLiveState).toBe("inactive");
    });
    expect(result.current.viewModel.activationError).toBeNull();
    expect(result.current.viewModel.sessionChrome.recovery).toBeNull();
    expect(result.current.viewModel.canSubmit).toBe(true);
  });

  it("falls back to node defaults for legacy sessions without stored settings", async () => {
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () => agentSessionState("session-1"))
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "codex", {
          composerOverrides: {
            model: "gpt-5",
            reasoningEffort: "high",
            speed: null,
            planMode: true,
            permissionModeId: "full-access"
          }
        }),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    expect(
      result.current.viewModel.composerSettings.sessionSettings
    ).toBeNull();
    expect(result.current.viewModel.composerSettings.modelUnavailable).toBe(
      false
    );
    expect(result.current.viewModel.composerSettings.reasoningUnavailable).toBe(
      false
    );
    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.draftSettings
      ).toMatchObject({
        model: "gpt-5",
        reasoningEffort: "high",
        // Stored planMode passes through unclamped — the daemon clamps it for
        // providers without the capability.
        planMode: true,
        permissionModeId: "auto"
      });
    });
  });

  it("includes permission mode when updating a legacy session without stored settings", async () => {
    const updateSettings = vi.fn(
      async ({
        settings
      }: {
        settings: {
          model?: string | null;
          reasoningEffort?: string | null;
          planMode?: boolean;
          permissionModeId?: string;
        };
      }) => ({
        settings: {
          model: settings.model ?? "gpt-5",
          reasoningEffort: settings.reasoningEffort ?? "high",
          speed: null,
          planMode: settings.planMode ?? true,
          permissionModeId: settings.permissionModeId ?? "full-access"
        }
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () => agentSessionState("session-1")),
      updateSettings
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "codex", {
          composerOverrides: {
            model: "gpt-5",
            reasoningEffort: "high",
            speed: null,
            planMode: true,
            permissionModeId: "full-access"
          }
        }),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    await waitFor(() => {
      expect(result.current.viewModel.sessionChrome.rawState).not.toBeNull();
    });

    act(() => {
      result.current.actions.updateComposerSettings({
        model: "gpt-5.4"
      });
    });

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        settings: {
          model: "gpt-5.4"
        }
      });
    });
  });

  it("supports editing defaults and creating the first conversation from the pre-launch composer state", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const },
        events: []
      })
    );
    const exec = vi.fn(async () => ({
      agentSessionId: "session-1",
      turnId: "turn-1",
      accepted: true,
      sessionStatus: "working"
    }));
    const onDataChange = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange
      })
    );

    act(() => {
      result.current.actions.updateComposerSettings({
        model: "gpt-5",
        reasoningEffort: "high",
        speed: null,
        planMode: true,
        permissionModeId: "full-access"
      });
      result.current.actions.updateDraftContent(draftContent("first prompt"));
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.draftSettings
      ).toMatchObject({
        model: "gpt-5",
        reasoningEffort: "high",
        // planMode passes through unclamped — the daemon clamps per provider.
        planMode: true,
        permissionModeId: "full-access"
      });
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("first prompt"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          workspaceId: "room-1",
          provider: "codex",
          ...initialPromptContent("first prompt"),
          settings: {
            model: "gpt-5",
            reasoningEffort: "high",
            speed: null,
            // Sent as-is; tuttid clamps planMode for codex at session create.
            planMode: true,
            // Browser use defaults to true for a new session (draftSettings
            // browserUse ?? true); the daemon clamps it to provider support.
            browserUse: true,
            permissionModeId: "full-access"
          }
        })
      );
    });
    expect(exec).not.toHaveBeenCalled();
    expect(onDataChange).toHaveBeenCalled();
  });

  it("keeps pre-launch model options loading until ACP config options are available", async () => {
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.draftSettings
      ).toMatchObject({
        model: null,
        reasoningEffort: "high",
        permissionModeId: null
      });
    });
    expect(result.current.viewModel.composerSettings.isSettingsLoading).toBe(
      true
    );
    expect(result.current.viewModel.composerSettings.availableModels).toEqual(
      []
    );
    expect(
      result.current.viewModel.composerSettings.availableReasoningEfforts
    ).toEqual([]);
  });

  it("updates the active session without syncing next-conversation defaults", async () => {
    let resolveUpdateSettings:
      | ((value: {
          settings: {
            model: string | null;
            reasoningEffort: string | null;
            speed?: string | null;
            planMode: boolean;
            permissionModeId: string;
          };
        }) => void)
      | null = null;
    const updateSettings = vi.fn(
      ({
        settings
      }: {
        settings: {
          model?: string | null;
          reasoningEffort?: string | null;
          planMode?: boolean;
          permissionModeId?: string;
        };
      }) =>
        new Promise<{
          settings: {
            model: string | null;
            reasoningEffort: string | null;
            speed?: string | null;
            planMode: boolean;
            permissionModeId: string;
          };
        }>((resolve) => {
          resolveUpdateSettings = resolve;
        }).then(() => ({
          settings: {
            model: settings.model ?? "gpt-5",
            reasoningEffort: settings.reasoningEffort ?? "medium",
            // Emulates the daemon clamping planMode for codex.
            planMode: false,
            permissionModeId: settings.permissionModeId ?? "auto"
          }
        }))
    );
    const onDataChange = vi.fn();
    const onRememberComposerDefaults = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          settings: {
            model: "gpt-5",
            reasoningEffort: "medium",
            speed: null,
            planMode: false,
            permissionModeId: "auto"
          },
          runtimeContext: {
            cwd: "/workspace",
            config: {
              model: "gpt-5",
              reasoning_effort: "medium"
            },
            configOptions: [
              {
                id: "model",
                name: "Model",
                currentValue: "gpt-5",
                options: [
                  { value: "gpt-5", name: "GPT-5" },
                  { value: "gpt-5.1", name: "GPT-5.1" }
                ]
              },
              {
                id: "reasoning_effort",
                name: "Reasoning Effort",
                currentValue: "medium",
                options: [
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" }
                ]
              }
            ]
          }
        })
      ),
      updateSettings
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange,
        onRememberComposerDefaults
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.sessionSettings
      ).toMatchObject({
        model: "gpt-5",
        reasoningEffort: "medium",
        speed: null,
        planMode: false,
        permissionModeId: "auto"
      });
    });
    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      "gpt-5"
    );
    expect(
      result.current.viewModel.composerSettings.selectedReasoningEffortValue
    ).toBe("medium");
    onDataChange.mockClear();

    act(() => {
      result.current.actions.updateComposerSettings({
        model: "gpt-5.1",
        reasoningEffort: "high",
        speed: null,
        planMode: true
      });
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.sessionSettings
      ).toMatchObject({
        model: "gpt-5.1",
        reasoningEffort: "high",
        // Optimistic patch carries planMode through; the daemon clamps it for
        // codex and the server echo below resets it to false.
        planMode: true,
        permissionModeId: "auto"
      });
    });
    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      "gpt-5.1"
    );
    expect(
      result.current.viewModel.composerSettings.selectedReasoningEffortValue
    ).toBe("high");

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        settings: {
          model: "gpt-5.1",
          reasoningEffort: "high",
          planMode: true
        }
      });
    });
    act(() => {
      resolveUpdateSettings?.({
        settings: {
          model: "gpt-5.1",
          reasoningEffort: "high",
          speed: null,
          planMode: false,
          permissionModeId: "auto"
        }
      });
    });
    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.sessionSettings
      ).toMatchObject({
        model: "gpt-5.1",
        reasoningEffort: "high",
        speed: null,
        planMode: false,
        permissionModeId: "auto"
      });
    });
    expect(onDataChange).not.toHaveBeenCalled();
    expect(onRememberComposerDefaults).not.toHaveBeenCalled();
  });

  it("queues later active session settings updates while an earlier request is still in flight", async () => {
    const updateResolvers: Array<
      (value: {
        settings: {
          model: string | null;
          reasoningEffort: string | null;
          speed?: string | null;
          planMode: boolean;
          permissionModeId: string;
        };
      }) => void
    > = [];
    const updateSettings = vi.fn(
      ({
        settings
      }: {
        settings: {
          model?: string | null;
          reasoningEffort?: string | null;
          planMode?: boolean;
          permissionModeId?: string;
        };
      }) =>
        new Promise<{
          settings: {
            model: string | null;
            reasoningEffort: string | null;
            speed?: string | null;
            planMode: boolean;
            permissionModeId: string;
          };
        }>((resolve) => {
          updateResolvers.push(resolve);
        }).then(() => ({
          settings: {
            model: settings.model ?? "gpt-5",
            reasoningEffort: settings.reasoningEffort ?? "medium",
            speed: null,
            planMode: settings.planMode ?? false,
            permissionModeId: settings.permissionModeId ?? "preset"
          }
        }))
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          settings: {
            model: "gpt-5",
            reasoningEffort: "medium",
            speed: null,
            planMode: false,
            permissionModeId: "auto"
          },
          runtimeContext: {
            cwd: "/workspace",
            config: {
              model: "gpt-5",
              reasoning_effort: "medium"
            },
            configOptions: [
              {
                id: "model",
                name: "Model",
                currentValue: "gpt-5",
                options: [
                  { value: "gpt-5", name: "GPT-5" },
                  { value: "gpt-5.1", name: "GPT-5.1" },
                  { value: "gpt-5.2", name: "GPT-5.2" }
                ]
              },
              {
                id: "reasoning_effort",
                name: "Reasoning Effort",
                currentValue: "medium",
                options: [
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" }
                ]
              }
            ]
          }
        })
      ),
      updateSettings
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
        "gpt-5"
      );
    });

    act(() => {
      result.current.actions.updateComposerSettings({ model: "gpt-5.1" });
    });

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(1);
      expect(updateSettings).toHaveBeenNthCalledWith(1, {
        workspaceId: "room-1",
        agentSessionId: "session-1",
        settings: {
          model: "gpt-5.1"
        }
      });
    });

    act(() => {
      result.current.actions.updateComposerSettings({ model: "gpt-5.2" });
    });

    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      "gpt-5.2"
    );
    expect(updateSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      updateResolvers[0]?.({
        settings: {
          model: "gpt-5.1",
          reasoningEffort: "medium",
          speed: null,
          planMode: false,
          permissionModeId: "preset"
        }
      });
    });

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledTimes(2);
      expect(updateSettings).toHaveBeenNthCalledWith(2, {
        workspaceId: "room-1",
        agentSessionId: "session-1",
        settings: {
          model: "gpt-5.2"
        }
      });
    });

    await act(async () => {
      updateResolvers[1]?.({
        settings: {
          model: "gpt-5.2",
          reasoningEffort: "medium",
          speed: null,
          planMode: false,
          permissionModeId: "preset"
        }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
        "gpt-5.2"
      );
      expect(
        result.current.viewModel.composerSettings.sessionSettings
      ).toMatchObject({
        model: "gpt-5.2",
        reasoningEffort: "medium",
        permissionModeId: "preset"
      });
    });
  });

  it("does not update node defaults when an active session settings update fails", async () => {
    const updateSettings = vi.fn(async () => {
      throw new Error("Claude Code custom models require a new session");
    });
    const onDataChange = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "claude-code",
            title: "Claude Code"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "claude-code",
          settings: {
            model: "sonnet",
            reasoningEffort: "medium",
            speed: null,
            planMode: false,
            permissionModeId: "default"
          }
        })
      ),
      updateSettings
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "claude-code", {
          composerOverrides: {
            model: "sonnet",
            reasoningEffort: "medium"
          }
        }),
        onDataChange
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    await waitFor(() => {
      expect(result.current.viewModel.sessionChrome.rawState).not.toBeNull();
    });

    onDataChange.mockClear();

    act(() => {
      result.current.actions.updateComposerSettings({
        model: "MiniMax-M2.7"
      });
    });

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        settings: {
          model: "MiniMax-M2.7"
        }
      });
    });
    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.sessionSettings
      ).toMatchObject({
        model: "sonnet",
        reasoningEffort: "medium",
        permissionModeId: "default"
      });
    });
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it("shows a warning tip when an active session settings update requires a new session", async () => {
    const updateSettings = vi.fn(async () => {
      throw createAppError("agent.settings_require_new_session");
    });
    const onShowMessage = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "codex",
            title: "Codex"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "codex",
          settings: {
            model: "gpt-5.4",
            reasoningEffort: "high",
            speed: null,
            planMode: false,
            permissionModeId: "full-access"
          }
        })
      ),
      updateSettings
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "codex", {
          composerOverrides: {
            model: "gpt-5.4",
            reasoningEffort: "high"
          }
        }),
        onDataChange: vi.fn(),
        onShowMessage
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    await waitFor(() => {
      expect(result.current.viewModel.sessionChrome.rawState).not.toBeNull();
    });

    act(() => {
      result.current.actions.updateComposerSettings({
        model: "gpt-5.3-codex-spark"
      });
    });

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        settings: {
          model: "gpt-5.3-codex-spark"
        }
      });
    });
    await waitFor(() => {
      expect(onShowMessage).toHaveBeenCalledWith(
        "This model can only be used in a new session to preserve context.",
        "warning"
      );
    });
    expect(result.current.viewModel.detailError).toBe(
      "This model can only be used in a new session to preserve context."
    );
    expect(
      result.current.viewModel.composerSettings.sessionSettings
    ).toMatchObject({
      model: "gpt-5.4",
      reasoningEffort: "high",
      permissionModeId: "full-access"
    });
  });

  it("uses active ACP model options for live sessions", async () => {
    const listModels = vi.fn();
    const getComposerOptions = vi.fn(async () => ({
      provider: "claude-code",
      effectiveSettings: {
        model: "haiku",
        reasoningEffort: "high",
        speed: null,
        planMode: false,
        permissionModeId: "preset"
      },
      runtimeContext: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            currentValue: "haiku",
            options: [
              {
                value: "default",
                name: "Default (recommended)",
                description: "Sonnet 4.6 · Best for everyday tasks"
              },
              {
                value: "opus",
                name: "Opus",
                description:
                  "Opus 4.7 · Most capable for complex work · ~2x usage vs Sonnet"
              },
              {
                value: "haiku",
                name: "Haiku",
                description: "Haiku 4.5 · Fastest for quick answers"
              }
            ]
          }
        ]
      }
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "claude-code",
            title: "Claude Code"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "claude-code",
          settings: {
            model: "haiku",
            reasoningEffort: "high",
            speed: null,
            planMode: false,
            permissionModeId: "default"
          },
          runtimeContext: {
            cwd: "/workspace",
            configOptions: [
              {
                id: "model",
                name: "Model",
                currentValue: "haiku",
                options: [{ value: "haiku", name: "Claude Haiku 4.5" }]
              }
            ]
          }
        })
      ),
      listModels,
      getComposerOptions
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "claude-code", {
          composerOverrides: {
            model: "sonnet",
            reasoningEffort: "high"
          }
        }),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.availableModels).toEqual(
        [
          {
            value: "default",
            label: "Default (recommended)",
            description: "Sonnet 4.6 · Best for everyday tasks"
          },
          {
            value: "opus",
            label: "Opus",
            description:
              "Opus 4.7 · Most capable for complex work · ~2x usage vs Sonnet"
          },
          {
            value: "haiku",
            label: "Haiku",
            description: "Haiku 4.5 · Fastest for quick answers"
          }
        ]
      );
    });
    expect(
      result.current.viewModel.composerSettings.availableReasoningEfforts
    ).toEqual([]);
    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      "haiku"
    );
    expect(result.current.viewModel.composerSettings.isSettingsLoading).toBe(
      false
    );
    expect(listModels).not.toHaveBeenCalled();
  });

  it("reloads active ACP options after switching the live model", async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce(
        agentSessionState("session-1", {
          provider: "claude-code",
          settings: {
            model: "haiku",
            reasoningEffort: "high",
            speed: null,
            planMode: false,
            permissionModeId: "default"
          },
          runtimeContext: {
            cwd: "/workspace",
            configOptions: [
              {
                id: "model",
                name: "Model",
                currentValue: "haiku",
                options: [
                  {
                    value: "default",
                    name: "Default (recommended)",
                    description: "Sonnet 4.6 · Best for everyday tasks"
                  },
                  {
                    value: "opus",
                    name: "Opus",
                    description:
                      "Opus 4.7 · Most capable for complex work · ~2x usage vs Sonnet"
                  },
                  {
                    value: "haiku",
                    name: "Haiku",
                    description: "Haiku 4.5 · Fastest for quick answers"
                  }
                ]
              }
            ]
          }
        })
      )
      .mockResolvedValueOnce(
        agentSessionState("session-1", {
          provider: "claude-code",
          settings: {
            model: "opus",
            reasoningEffort: "xhigh",
            speed: null,
            planMode: false,
            permissionModeId: "default"
          },
          runtimeContext: {
            cwd: "/workspace",
            configOptions: [
              {
                id: "model",
                name: "Model",
                currentValue: "opus",
                options: [
                  {
                    value: "default",
                    name: "Default (recommended)",
                    description: "Sonnet 4.6 · Best for everyday tasks"
                  },
                  {
                    value: "opus",
                    name: "Opus",
                    description:
                      "Opus 4.7 · Most capable for complex work · ~2x usage vs Sonnet"
                  },
                  {
                    value: "haiku",
                    name: "Haiku",
                    description: "Haiku 4.5 · Fastest for quick answers"
                  }
                ]
              },
              {
                id: "effort",
                name: "Effort",
                currentValue: "xhigh",
                options: [
                  { value: "high", name: "High" },
                  { value: "xhigh", name: "X High" }
                ]
              }
            ]
          }
        })
      );
    const updateSettings = vi.fn(async () => ({
      agentSessionId: "session-1",
      settings: {
        model: "opus",
        reasoningEffort: "high",
        speed: null,
        planMode: false,
        permissionModeId: "preset"
      }
    }));
    const getComposerOptions = vi.fn(async () => ({
      provider: "claude-code",
      runtimeContext: {
        configOptions: [
          {
            id: "model",
            options: [
              {
                value: "default",
                name: "Default (recommended)",
                description: "Sonnet 4.6 · Best for everyday tasks"
              },
              {
                value: "opus",
                name: "Opus",
                description:
                  "Opus 4.7 · Most capable for complex work · ~2x usage vs Sonnet"
              },
              {
                value: "haiku",
                name: "Haiku",
                description: "Haiku 4.5 · Fastest for quick answers"
              }
            ]
          },
          {
            id: "effort",
            options: [
              { value: "high", name: "High" },
              { value: "xhigh", name: "X High" }
            ]
          }
        ]
      }
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "claude-code",
            title: "Claude Code"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState,
      getComposerOptions,
      updateSettings
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "claude-code", {
          composerOverrides: {
            model: "haiku",
            reasoningEffort: "high"
          }
        }),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(getState).toHaveBeenCalledTimes(1);
      expect(result.current.viewModel.composerSettings.availableModels).toEqual(
        [
          {
            value: "default",
            label: "Default (recommended)",
            description: "Sonnet 4.6 · Best for everyday tasks"
          },
          {
            value: "opus",
            label: "Opus",
            description:
              "Opus 4.7 · Most capable for complex work · ~2x usage vs Sonnet"
          },
          {
            value: "haiku",
            label: "Haiku",
            description: "Haiku 4.5 · Fastest for quick answers"
          }
        ]
      );
      expect(
        result.current.viewModel.composerSettings.availableReasoningEfforts
      ).toEqual([
        { value: "high", label: "High" },
        { value: "xhigh", label: "X High" }
      ]);
    });

    act(() => {
      result.current.actions.updateComposerSettings({ model: "opus" });
    });

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        settings: {
          model: "opus"
        }
      });
      expect(getState).toHaveBeenCalledTimes(2);
      expect(
        result.current.viewModel.composerSettings.availableReasoningEfforts
      ).toEqual([
        { value: "high", label: "High" },
        { value: "xhigh", label: "X High" }
      ]);
    });
    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      "opus"
    );
    expect(
      result.current.viewModel.composerSettings.selectedReasoningEffortValue
    ).toBe("xhigh");
    expect(
      result.current.viewModel.composerSettings.draftSettings
    ).toMatchObject({
      model: "opus",
      reasoningEffort: "xhigh"
    });
  });

  it("loads fresh ACP options on the new session composer instead of reusing previous state", async () => {
    const listModels = vi.fn();
    const getComposerOptions = vi.fn(async () => ({
      provider: "claude-code",
      effectiveSettings: {
        model: "haiku",
        reasoningEffort: "high",
        speed: null,
        planMode: false,
        permissionModeId: "preset"
      },
      runtimeContext: {
        configOptions: [
          {
            id: "model",
            name: "Model",
            currentValue: "haiku",
            options: [
              {
                value: "default",
                name: "Default (recommended)",
                description: "Sonnet 4.6 · Best for everyday tasks"
              },
              {
                value: "opus",
                name: "Opus",
                description:
                  "Opus 4.7 · Most capable for complex work · ~2x usage vs Sonnet"
              },
              {
                value: "haiku",
                name: "Haiku",
                description: "Haiku 4.5 · Fastest for quick answers"
              }
            ]
          }
        ]
      }
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "claude-code",
            title: "Claude Code"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "claude-code",
          settings: {
            model: "haiku",
            reasoningEffort: "high",
            speed: null,
            planMode: false,
            permissionModeId: "default"
          },
          runtimeContext: {
            cwd: "/workspace",
            permissionModeId: "preset",
            configOptions: [
              {
                id: "model",
                name: "Model",
                currentValue: "haiku",
                options: [
                  {
                    value: "default",
                    name: "Default (recommended)",
                    description: "Sonnet 4.6 · Best for everyday tasks"
                  },
                  {
                    value: "opus",
                    name: "Opus",
                    description:
                      "Opus 4.7 · Most capable for complex work · ~2x usage vs Sonnet"
                  },
                  {
                    value: "haiku",
                    name: "Haiku",
                    description: "Haiku 4.5 · Fastest for quick answers"
                  }
                ]
              }
            ]
          }
        })
      ),
      listModels,
      getComposerOptions
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "claude-code", {
          composerOverrides: {
            model: "haiku",
            reasoningEffort: "high"
          }
        }),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.availableModels).toEqual(
        [
          {
            value: "default",
            label: "Default (recommended)",
            description: "Sonnet 4.6 · Best for everyday tasks"
          },
          {
            value: "opus",
            label: "Opus",
            description:
              "Opus 4.7 · Most capable for complex work · ~2x usage vs Sonnet"
          },
          {
            value: "haiku",
            label: "Haiku",
            description: "Haiku 4.5 · Fastest for quick answers"
          }
        ]
      );
    });
    expect(
      result.current.viewModel.composerSettings.availableReasoningEfforts
    ).toEqual([]);
    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      "haiku"
    );

    act(() => {
      result.current.actions.createConversation();
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBeNull();
    });
    await waitFor(() => {
      expect(getComposerOptions).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.isSettingsLoading).toBe(
        false
      );
    });
    expect(result.current.viewModel.composerSettings.availableModels).toEqual([
      {
        value: "default",
        label: "Default (recommended)",
        description: "Sonnet 4.6 · Best for everyday tasks"
      },
      {
        value: "opus",
        label: "Opus",
        description:
          "Opus 4.7 · Most capable for complex work · ~2x usage vs Sonnet"
      },
      {
        value: "haiku",
        label: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers"
      }
    ]);
    expect(
      result.current.viewModel.composerSettings.availableReasoningEfforts
    ).toEqual([]);
    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      "haiku"
    );
    expect(listModels).not.toHaveBeenCalled();
  });

  it("updates node defaults before any conversation exists", async () => {
    const onDataChange = vi.fn();
    const onRememberComposerDefaults = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange,
        onRememberComposerDefaults
      })
    );

    act(() => {
      result.current.actions.updateComposerSettings({
        model: "gpt-5",
        planMode: true,
        permissionModeId: "full-access"
      });
    });

    expect(
      result.current.viewModel.composerSettings.sessionSettings
    ).toBeNull();
    expect(
      result.current.viewModel.composerSettings.draftSettings
    ).toMatchObject({
      model: "gpt-5",
      // planMode passes through unclamped — the daemon clamps per provider.
      planMode: true,
      permissionModeId: "full-access"
    });
    expect(onDataChange).toHaveBeenCalled();
    expect(onRememberComposerDefaults).toHaveBeenCalledWith({
      provider: "codex",
      defaults: {
        model: "gpt-5",
        permissionModeId: "full-access",
        reasoningEffort: "high"
      }
    });
  });

  it("notifies the host when pre-launch composer settings change", async () => {
    const trackDraftComposerSettingsChange = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });
    installNoopAgentActivityRuntimeForTests();
    (
      window as unknown as { agentActivityRuntime: AgentActivityRuntime }
    ).agentActivityRuntime.trackDraftComposerSettingsChange =
      trackDraftComposerSettingsChange;

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.updateComposerSettings({
        reasoningEffort: "medium"
      });
    });

    expect(trackDraftComposerSettingsChange).toHaveBeenCalledWith({
      workspaceId: "room-1",
      provider: "codex",
      previousSettings: expect.objectContaining({
        reasoningEffort: "high"
      }),
      nextSettings: expect.objectContaining({
        reasoningEffort: "medium"
      })
    });
  });

  it("waits for ACP config options before showing model options on the new session composer", async () => {
    const listModels = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      listModels
    });

    await Promise.all(
      (["codex", "claude-code", "gemini"] as const).map(async (provider) => {
        const { result, unmount } = renderHook(() =>
          useAgentGUINodeController({
            workspaceId: "room-1",
            currentUserId: "user-1",
            workspacePath: "/workspace",
            avoidGroupingEdits: false,
            data: agentGuiData(null, provider),
            onDataChange: vi.fn()
          })
        );

        try {
          await waitFor(() => {
            expect(
              result.current.viewModel.composerSettings.isSettingsLoading
            ).toBe(true);
          });
          expect(
            result.current.viewModel.composerSettings.availableModels
          ).toEqual([]);
          expect(
            result.current.viewModel.composerSettings.availableReasoningEfforts
          ).toEqual([]);
        } finally {
          unmount();
        }
      })
    );

    expect(listModels).not.toHaveBeenCalled();
  });

  it("loads new session ACP options without creating a draft session", async () => {
    const activate = vi.fn();
    const subscribeEvents = vi.fn(() => vi.fn());
    const getComposerOptions = vi.fn(async () => ({
      provider: "claude-code",
      effectiveSettings: {},
      runtimeContext: {
        configOptions: [
          {
            id: "model",
            currentValue: "haiku",
            options: [{ value: "haiku", name: "Haiku" }]
          }
        ]
      }
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents,
      getComposerOptions,
      activate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "claude-code"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.availableModels).toEqual(
        [{ value: "haiku", label: "Haiku" }]
      );
    });
    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      null
    );
    expect(getComposerOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "room-1",
        provider: "claude-code"
      })
    );
    expect(activate).not.toHaveBeenCalled();
    expect(subscribeEvents).not.toHaveBeenCalled();
  });

  it("keeps new-session draft settings when loaded composer defaults differ", async () => {
    const getComposerOptions = vi.fn(async () => ({
      provider: "codex",
      effectiveSettings: {
        model: "gpt-5.5",
        reasoningEffort: "high",
        speed: null,
        planMode: false,
        permissionModeId: "full-access"
      },
      runtimeContext: {
        configOptions: [
          {
            id: "model",
            currentValue: "gpt-5.5",
            options: [{ value: "gpt-5.5", name: "GPT-5.5" }]
          }
        ]
      }
    }));
    const list = vi.fn(async () => ({ presences: [], sessions: [] }));
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions
    });

    const onDataChange = vi.fn();
    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "codex", {
          composerOverrides: {
            model: "gpt-5.4",
            reasoningEffort: "high"
          }
        }),
        onDataChange
      })
    );

    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1);
      expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
        "gpt-5.4"
      );
      expect(
        result.current.viewModel.composerSettings.draftSettings.model
      ).toBe("gpt-5.4");
    });
  });

  it("uses draft ACP model for a new session before control state arrives", async () => {
    const getComposerOptions = vi.fn(async () => ({
      provider: "codex",
      effectiveSettings: {
        model: "gpt-5.5",
        reasoningEffort: "high",
        speed: null,
        planMode: false,
        permissionModeId: "full-access"
      },
      runtimeContext: {
        configOptions: [
          {
            id: "model",
            currentValue: "gpt-5.5",
            options: [{ value: "gpt-5.5", name: "GPT-5.5" }]
          }
        ]
      }
    }));
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions,
      activate,
      getState: vi.fn(() => new Promise<never>(() => undefined))
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "codex", {
          composerOverrides: {
            model: "gpt-5.4",
            reasoningEffort: "high"
          }
        }),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
        "gpt-5.4"
      );
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("hello"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          settings: expect.objectContaining({ model: "gpt-5.4" })
        })
      );
      expect(result.current.viewModel.activeConversationId).not.toBeNull();
      expect(
        result.current.viewModel.composerSettings.draftSettings.model
      ).toBe("gpt-5.4");
    });
  });

  it("reloads new session ACP options after a model invalidation event", async () => {
    let emitDesktopEvent: ((event: AgentHostEvent) => void) | null = null;
    const onEvent = vi.fn((listener) => {
      emitDesktopEvent = listener;
      return vi.fn();
    });
    const getComposerOptions = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "claude-code",
        effectiveSettings: {},
        runtimeContext: {
          configOptions: [
            {
              id: "model",
              currentValue: "haiku",
              options: [{ value: "haiku", name: "Haiku" }]
            }
          ]
        }
      })
      .mockResolvedValue({
        provider: "claude-code",
        effectiveSettings: {},
        runtimeContext: {
          configOptions: [
            {
              id: "model",
              currentValue: "opus",
              options: [
                { value: "opus", name: "Opus" },
                { value: "haiku", name: "Haiku" }
              ]
            }
          ]
        }
      });
    const activate = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions,
      activate,
      onEvent
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "claude-code"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(getComposerOptions).toHaveBeenCalled();
    });
    const initialOptionsCallCount = getComposerOptions.mock.calls.length;

    act(() => {
      emitDesktopEvent?.({
        scope: "global",
        type: "agent-model-catalog-invalidated",
        providers: ["claude-code"],
        occurredAtUnixMs: 2
      });
    });

    await waitFor(() => {
      expect(getComposerOptions.mock.calls.length).toBeGreaterThan(
        initialOptionsCallCount
      );
      expect(result.current.viewModel.composerSettings.availableModels).toEqual(
        [
          { value: "opus", label: "Opus" },
          { value: "haiku", label: "Haiku" }
        ]
      );
    });
    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      null
    );
    expect(activate).not.toHaveBeenCalled();
  });

  it("reloads permission-only provider options after a model invalidation event", async () => {
    let emitDesktopEvent: ((event: AgentHostEvent) => void) | null = null;
    const onEvent = vi.fn((listener) => {
      emitDesktopEvent = listener;
      return vi.fn();
    });
    const getComposerOptions = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "nexight",
        permissionConfig: {
          configurable: true,
          defaultValue: "default",
          modes: [{ id: "default", label: "Default", semantic: "custom" }]
        }
      })
      .mockResolvedValue({
        provider: "nexight",
        permissionConfig: {
          configurable: true,
          defaultValue: "review-first",
          modes: [
            {
              id: "review-first",
              label: "Review first",
              semantic: "custom"
            }
          ]
        }
      });
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions,
      onEvent
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "nexight"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.selectedPermissionModeValue
      ).toBe("default");
    });
    const initialOptionsCallCount = getComposerOptions.mock.calls.length;

    act(() => {
      emitDesktopEvent?.({
        scope: "global",
        type: "agent-model-catalog-invalidated",
        providers: ["nexight"],
        occurredAtUnixMs: 2
      });
    });

    await waitFor(() => {
      expect(getComposerOptions.mock.calls.length).toBeGreaterThan(
        initialOptionsCallCount
      );
      expect(
        result.current.viewModel.composerSettings.selectedPermissionModeValue
      ).toBe("review-first");
    });
    expect(
      result.current.viewModel.composerSettings.availablePermissionModes
    ).toEqual([{ value: "review-first", label: "Review first" }]);
  });

  it("keeps persisted custom model as draft while waiting for ACP options", async () => {
    const listModels = vi.fn();
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      listModels
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "codex", {
          composerOverrides: { model: "custom-model" }
        }),
        onDataChange: vi.fn()
      })
    );

    expect(result.current.viewModel.composerSettings.isSettingsLoading).toBe(
      true
    );
    expect(result.current.viewModel.composerSettings.availableModels).toEqual(
      []
    );
    expect(result.current.viewModel.composerSettings.draftSettings.model).toBe(
      "custom-model"
    );
    expect(listModels).not.toHaveBeenCalled();
  });

  it("reloads active ACP options after a coalesced model invalidation event", async () => {
    let emitDesktopEvent: ((event: AgentHostEvent) => void) | null = null;
    const onEvent = vi.fn((listener) => {
      emitDesktopEvent = listener;
      return vi.fn();
    });
    const getState = vi
      .fn()
      .mockResolvedValueOnce(
        agentSessionState("session-1", {
          provider: "codex",
          settings: {
            model: "gpt-old",
            reasoningEffort: "low",
            speed: null,
            planMode: false,
            permissionModeId: "auto"
          },
          runtimeContext: {
            configOptions: [
              {
                id: "model",
                currentValue: "gpt-old",
                options: [{ value: "gpt-old", name: "GPT old" }]
              }
            ]
          }
        })
      )
      .mockResolvedValueOnce(
        agentSessionState("session-1", {
          provider: "codex",
          settings: {
            model: "gpt-new",
            reasoningEffort: "medium",
            speed: null,
            planMode: false,
            permissionModeId: "auto"
          },
          runtimeContext: {
            configOptions: [
              {
                id: "model",
                currentValue: "gpt-new",
                options: [{ value: "gpt-new", name: "GPT new" }]
              },
              {
                id: "reasoning_effort",
                currentValue: "medium",
                options: [{ value: "medium", name: "Medium" }]
              }
            ]
          }
        })
      );
    const getComposerOptions = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "codex",
        runtimeContext: {
          configOptions: [
            {
              id: "model",
              options: [{ value: "gpt-old", name: "GPT old" }]
            }
          ]
        }
      })
      .mockResolvedValue({
        provider: "codex",
        runtimeContext: {
          configOptions: [
            {
              id: "model",
              options: [{ value: "gpt-new", name: "GPT new" }]
            },
            {
              id: "reasoning_effort",
              options: [{ value: "medium", name: "Medium" }]
            }
          ]
        }
      });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            provider: "codex",
            title: "Codex"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState,
      getComposerOptions,
      onEvent
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "codex", {
          composerOverrides: { model: "manual-model" }
        }),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.availableModels).toEqual(
        [{ value: "gpt-old", label: "GPT old" }]
      );
    });

    act(() => {
      emitDesktopEvent?.({
        scope: "global",
        type: "agent-model-catalog-invalidated",
        providers: ["gemini"],
        occurredAtUnixMs: 1
      });
      emitDesktopEvent?.({
        scope: "global",
        type: "agent-model-catalog-invalidated",
        providers: ["codex"],
        occurredAtUnixMs: 2
      });
    });
    await waitFor(() => {
      expect(getState).toHaveBeenCalledTimes(2);
      expect(result.current.viewModel.composerSettings.availableModels).toEqual(
        [{ value: "gpt-new", label: "GPT new" }]
      );
      expect(
        result.current.viewModel.composerSettings.availableReasoningEfforts
      ).toEqual([{ value: "medium", label: "Medium" }]);
    });
    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      "gpt-new"
    );
    expect(
      result.current.viewModel.composerSettings.selectedReasoningEffortValue
    ).toBe("medium");
  });

  it("refreshes draft ACP options after a coalesced model invalidation event", async () => {
    let emitDesktopEvent: ((event: AgentHostEvent) => void) | null = null;
    const onEvent = vi.fn((listener) => {
      emitDesktopEvent = listener;
      return vi.fn();
    });
    const activate = vi.fn();
    const unactivate = vi.fn();
    const deleteSession = vi.fn(async () => ({ deleted: true }));
    const getComposerOptions = vi
      .fn()
      .mockResolvedValueOnce({
        provider: "claude-code",
        effectiveSettings: {},
        runtimeContext: {
          configOptions: [
            {
              id: "model",
              currentValue: "haiku",
              options: [{ value: "haiku", name: "Haiku" }]
            }
          ]
        }
      })
      .mockResolvedValue({
        provider: "claude-code",
        effectiveSettings: {},
        runtimeContext: {
          configOptions: [
            {
              id: "model",
              currentValue: "opus",
              options: [
                { value: "opus", name: "Opus" },
                { value: "haiku", name: "Haiku" }
              ]
            }
          ]
        }
      });
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions,
      activate,
      unactivate,
      deleteSession,
      onEvent
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "claude-code"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(getComposerOptions).toHaveBeenCalled();
    });
    const initialOptionsCallCount = getComposerOptions.mock.calls.length;

    act(() => {
      emitDesktopEvent?.({
        scope: "global",
        type: "agent-model-catalog-invalidated",
        providers: ["claude-code"],
        occurredAtUnixMs: 2
      });
    });

    await waitFor(() => {
      expect(getComposerOptions.mock.calls.length).toBeGreaterThan(
        initialOptionsCallCount
      );
      expect(result.current.viewModel.composerSettings.availableModels).toEqual(
        [
          { value: "opus", label: "Opus" },
          { value: "haiku", label: "Haiku" }
        ]
      );
    });
    expect(result.current.viewModel.composerSettings.selectedModelValue).toBe(
      null
    );
    expect(activate).not.toHaveBeenCalled();
    expect(unactivate).not.toHaveBeenCalled();
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("creates a new session without refreshing a provider model catalog", async () => {
    const listModels = vi.fn();
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId, {
          settings: input.mode === "new" ? input.settings : undefined
        }),
        activation: { mode: input.mode, status: "attached" as const }
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      listModels,
      activate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "codex", {
          composerOverrides: { model: "manual-model" }
        }),
        onDataChange: vi.fn()
      })
    );

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("hello"));
    });

    await waitFor(() => {
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "new",
          settings: expect.objectContaining({ model: "manual-model" })
        })
      );
    });
    expect(listModels).not.toHaveBeenCalled();
  });

  it("keeps the composer usable while ACP options are loading", async () => {
    const logRuntimeDiagnostics = vi.fn();
    const listModels = vi.fn(async () => {
      throw new Error("catalog unavailable");
    });
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      listModels,
      logRuntimeDiagnostics
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "gemini", {
          composerOverrides: { model: "default" }
        }),
        onDataChange: vi.fn()
      })
    );

    expect(result.current.viewModel.composerSettings.isSettingsLoading).toBe(
      true
    );
    expect(result.current.viewModel.composerSettings.availableModels).toEqual(
      []
    );
    expect(result.current.viewModel.composerSettings.draftSettings.model).toBe(
      "default"
    );
    expect(result.current.viewModel.canSubmit).toBe(true);
    expect(listModels).not.toHaveBeenCalled();
    expect(logRuntimeDiagnostics).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent_gui_model_catalog" })
    );
  });

  it.each([
    ["claude-code", true],
    ["codex", false],
    ["gemini", false]
  ] as const)(
    "shows composer model and reasoning controls for %s",
    async (provider, expectedPlanSupport) => {
      installAgentHostApi({
        list: vi.fn(async () => ({ presences: [], sessions: [] })),
        listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
        subscribeEvents: vi.fn(() => vi.fn()),
        getComposerOptions: vi.fn(async () => ({
          provider,
          modelConfig: {
            configurable: true,
            options: [{ id: "gpt-5", label: "GPT-5", value: "gpt-5" }]
          },
          reasoningConfig: {
            configurable: true,
            options: [{ id: "high", label: "High", value: "high" }]
          },
          runtimeContext:
            provider === "claude-code" ? { capabilities: ["planMode"] } : {}
        }))
      });

      const { result, unmount } = renderHook(() =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData(null, provider),
          onDataChange: vi.fn()
        })
      );

      await waitFor(() => {
        expect(result.current.viewModel.composerSettings.supportsModel).toBe(
          true
        );
      });

      expect(result.current.viewModel.composerSettings.supportsModel).toBe(
        true
      );
      expect(
        result.current.viewModel.composerSettings.supportsReasoningEffort
      ).toBe(true);
      expect(result.current.viewModel.composerSettings.supportsPlanMode).toBe(
        expectedPlanSupport
      );
      unmount();
    }
  );

  it.each([
    ["claude-code", true],
    ["codex", true],
    ["gemini", false]
  ] as const)(
    "sets composer permission mode support for %s",
    async (provider, expectedPermissionSupport) => {
      const getComposerOptions = vi.fn(async () => ({
        provider,
        settings:
          provider === "claude-code"
            ? { permissionModeId: "default" }
            : provider === "codex"
              ? { permissionModeId: "auto" }
              : {},
        permissionConfig:
          provider === "claude-code"
            ? {
                configurable: true,
                modes: [
                  { id: "default", semantic: "ask-before-write" },
                  { id: "acceptEdits", semantic: "accept-edits" }
                ]
              }
            : provider === "codex"
              ? {
                  configurable: true,
                  modes: [
                    { id: "read-only", semantic: "locked-down" },
                    { id: "auto", semantic: "auto" },
                    { id: "full-access", semantic: "full-access" }
                  ]
                }
              : undefined,
        runtimeContext: {
          configOptions: [
            {
              id: "model",
              currentValue: "default-model",
              options: [{ value: "default-model", name: "Default model" }]
            }
          ]
        }
      }));
      installAgentHostApi({
        list: vi.fn(async () => ({ presences: [], sessions: [] })),
        listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
        subscribeEvents: vi.fn(() => vi.fn()),
        getComposerOptions
      });

      const { result, unmount } = renderHook(() =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData(null, provider),
          onDataChange: vi.fn()
        })
      );

      await waitFor(() => {
        expect(result.current.viewModel.composerSettings.supportsModel).toBe(
          true
        );
        expect(
          result.current.viewModel.composerSettings.supportsPermissionMode
        ).toBe(expectedPermissionSupport);
      });
      unmount();
    }
  );

  it.each([
    ["claude-code", true, true],
    ["gemini", false, false],
    ["codex", null, true]
  ] as const)(
    "uses backend prompt image capability for %s",
    async (
      provider,
      backendPromptImagesSupported,
      expectedPromptImagesSupported
    ) => {
      installAgentHostApi({
        list: vi.fn(async () => ({ presences: [], sessions: [] })),
        listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
        subscribeEvents: vi.fn(() => vi.fn()),
        getComposerOptions: vi.fn(async () => ({
          provider,
          runtimeContext:
            backendPromptImagesSupported === null
              ? {}
              : {
                  capabilities: backendPromptImagesSupported
                    ? ["imageInput"]
                    : []
                }
        }))
      });

      const { result, unmount } = renderHook(() =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData(null, provider),
          onDataChange: vi.fn()
        })
      );

      await waitFor(() => {
        expect(result.current.viewModel.promptImagesSupported).toBe(
          expectedPromptImagesSupported
        );
      });
      unmount();
    }
  );

  it("localizes known composer-options permission labels before contract fallback", async () => {
    setAgentGuiI18nTestLocale("zh-CN");
    const getComposerOptions = vi.fn(async () => ({
      provider: "codex",
      settings: { permissionModeId: "read-only" },
      permissionConfig: {
        configurable: true,
        modes: [
          {
            id: "read-only",
            label: "Ask for approval",
            description: "API description",
            semantic: "ask-before-write"
          },
          {
            id: "auto",
            label: "Approve for me",
            semantic: "auto"
          },
          {
            id: "custom-safe",
            label: "Custom safe",
            description: "API custom description",
            semantic: "custom"
          }
        ]
      },
      modelConfig: {
        currentValue: "gpt-5",
        options: [{ id: "gpt-5", label: "GPT-5", value: "gpt-5" }]
      },
      reasoningConfig: {
        currentValue: "high",
        options: [{ id: "high", label: "High", value: "high" }]
      },
      runtimeContext: {
        configOptions: [
          {
            id: "model",
            currentValue: "legacy-model",
            options: [{ value: "legacy-model", name: "Legacy model" }]
          }
        ]
      }
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions
    });

    const { result, unmount } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "codex"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.availablePermissionModes
      ).toEqual([
        {
          value: "read-only",
          label: "请求批准",
          description: "编辑外部文件和使用互联网时始终询问"
        },
        {
          value: "auto",
          label: "替我审批",
          description: "仅对检测到的风险操作请求批准"
        },
        {
          value: "custom-safe",
          label: "Custom safe",
          description: "API custom description"
        }
      ]);
    });
    expect(result.current.viewModel.composerSettings.availableModels).toEqual([
      { value: "gpt-5", label: "GPT-5" }
    ]);
    unmount();
  });

  it("uses provider permission default only as the displayed selected value", async () => {
    const getComposerOptions = vi.fn(async () => ({
      provider: "codex",
      permissionConfig: {
        configurable: true,
        defaultValue: "auto",
        modes: [
          { id: "auto", label: "Approve for me", semantic: "auto" },
          {
            id: "full-access",
            label: "Full access",
            semantic: "full-access"
          }
        ]
      },
      modelConfig: {
        currentValue: "gpt-5",
        options: [{ id: "gpt-5", label: "GPT-5", value: "gpt-5" }]
      },
      reasoningConfig: {
        currentValue: "high",
        options: [{ id: "high", label: "High", value: "high" }]
      }
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions
    });

    const { result, unmount } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "codex"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.selectedPermissionModeValue
      ).toBe("auto");
    });
    expect(
      result.current.viewModel.composerSettings.draftSettings.permissionModeId
    ).toBeNull();
    unmount();
  });

  it("does not let provider permission default overwrite an explicit draft permission", async () => {
    const getComposerOptions = vi.fn(async () => ({
      provider: "codex",
      permissionConfig: {
        configurable: true,
        defaultValue: "auto",
        modes: [
          { id: "auto", label: "Approve for me", semantic: "auto" },
          {
            id: "full-access",
            label: "Full access",
            semantic: "full-access"
          }
        ]
      },
      modelConfig: {
        currentValue: "gpt-5",
        options: [{ id: "gpt-5", label: "GPT-5", value: "gpt-5" }]
      },
      reasoningConfig: {
        currentValue: "high",
        options: [{ id: "high", label: "High", value: "high" }]
      }
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions
    });

    const { result, unmount } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "codex", {
          composerOverrides: { permissionModeId: "full-access" }
        }),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.composerSettings.selectedPermissionModeValue
      ).toBe("full-access");
    });
    expect(
      result.current.viewModel.composerSettings.draftSettings.permissionModeId
    ).toBe("full-access");
    unmount();
  });

  it("treats permission-only provider options as settings loading until loaded", async () => {
    let resolveComposerOptions: ((value: any) => void) | undefined;
    const getComposerOptions = vi.fn(
      () =>
        new Promise<any>((resolve) => {
          resolveComposerOptions = resolve;
        })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({ presences: [], sessions: [] })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions
    });

    const { result, unmount } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData(null, "nexight"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(getComposerOptions).toHaveBeenCalled();
      expect(result.current.viewModel.composerSettings.isSettingsLoading).toBe(
        true
      );
    });

    resolveComposerOptions?.({
      provider: "nexight",
      permissionConfig: {
        configurable: true,
        defaultValue: "default",
        modes: [{ id: "default", label: "Default", semantic: "custom" }]
      }
    });

    await waitFor(() => {
      expect(result.current.viewModel.composerSettings.isSettingsLoading).toBe(
        false
      );
      expect(
        result.current.viewModel.composerSettings.supportsPermissionMode
      ).toBe(true);
    });
    expect(
      result.current.viewModel.composerSettings.availablePermissionModes
    ).toEqual([{ value: "default", label: "Default" }]);
    expect(
      result.current.viewModel.composerSettings.selectedPermissionModeValue
    ).toBe("default");
    unmount();
  });

  it.each(["hermes", "openclaw", "nexight"] as const)(
    "hides model and reasoning defaults for unsupported provider %s",
    async (provider) => {
      const listModels = vi.fn(async () => ({ models: [] }));
      installAgentHostApi({
        list: vi.fn(async () => ({ presences: [], sessions: [] })),
        listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
        subscribeEvents: vi.fn(() => vi.fn()),
        listModels
      });

      const { result, unmount } = renderHook(() =>
        useAgentGUINodeController({
          workspaceId: "room-1",
          currentUserId: "user-1",
          workspacePath: "/workspace",
          avoidGroupingEdits: false,
          data: agentGuiData(null, provider, {
            composerOverrides: {
              model: "gpt-5",
              reasoningEffort: "high"
            }
          }),
          onDataChange: vi.fn()
        })
      );

      await waitFor(() => {
        expect(result.current.viewModel.composerSettings.supportsModel).toBe(
          false
        );
      });

      expect(result.current.viewModel.composerSettings.supportsModel).toBe(
        false
      );
      expect(
        result.current.viewModel.composerSettings.supportsReasoningEffort
      ).toBe(false);
      // Stored overrides are no longer clamped GUI-side — the daemon owns
      // provider-level clamping; the composer simply hides the controls.
      expect(
        result.current.viewModel.composerSettings.draftSettings.model
      ).toBe("gpt-5");
      expect(
        result.current.viewModel.composerSettings.draftSettings.reasoningEffort
      ).toBe("high");
      expect(listModels).not.toHaveBeenCalled();
      unmount();
    }
  );

  it("submits approval responses through the interactive session endpoint when state exposes a pending prompt", async () => {
    const submitInteractive = vi.fn(async () => ({
      agentSessionId: "session-1",
      requestId: "request-1",
      accepted: true,
      events: []
    }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "approval",
            requestId: "request-1",
            toolName: "Run command",
            status: "waiting",
            input: {
              callId: "call-1",
              options: [
                {
                  id: "allow_once",
                  label: "Allow once",
                  kind: "allow_once",
                  description: "Run this tool a single time."
                }
              ]
            }
          }
        })
      ),
      submitInteractive
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingApproval?.requestId).toBe(
        "request-1"
      );
    });
    expect(result.current.viewModel.pendingApproval?.options).toEqual([
      expect.objectContaining({
        id: "allow_once",
        description: "Run this tool a single time."
      })
    ]);

    act(() => {
      result.current.actions.submitApprovalOption("request-1", "allow_once");
    });

    await waitFor(() => {
      expect(submitInteractive).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        requestId: "request-1",
        optionId: "allow_once"
      });
    });
  });

  function installExitPlanPromptHostApi(input: {
    submitInteractive: ReturnType<typeof vi.fn>;
    updateSettings: ReturnType<typeof vi.fn>;
  }): void {
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "claude-code",
          settings: {
            planMode: true,
            permissionModeId: "default"
          },
          pendingInteractive: {
            kind: "question",
            requestId: "request-plan",
            toolName: "ExitPlanMode",
            status: "waiting",
            input: {
              callId: "call-plan"
            }
          }
        })
      ),
      submitInteractive: input.submitInteractive,
      updateSettings: input.updateSettings
    });
  }

  it("clears plan mode after approving an exit-plan prompt", async () => {
    const submitInteractive = vi.fn(async () => ({
      agentSessionId: "session-1",
      requestId: "request-plan",
      accepted: true,
      events: []
    }));
    const updateSettings = vi.fn(async ({ settings }) => ({ settings }));
    installExitPlanPromptHostApi({ submitInteractive, updateSettings });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "claude-code"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.kind).toBe(
        "exit-plan"
      );
    });

    act(() => {
      result.current.actions.submitInteractivePrompt({
        requestId: "request-plan",
        action: "allow",
        optionId: "acceptEdits"
      });
    });

    await waitFor(() => {
      expect(submitInteractive).toHaveBeenCalled();
    });
    // Plan approved: the composer setting is cleared so the next turn
    // executes instead of replanning.
    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ planMode: false })
        })
      );
    });
  });

  it("submits plan feedback as a prompt while staying in plan mode", async () => {
    const exec = vi.fn(async () => ({ events: [] }));
    const updateSettings = vi.fn(async ({ settings }) => ({ settings }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "codex",
          settings: { planMode: true, permissionModeId: "auto" }
        })
      ),
      exec,
      updateSettings
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "codex"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.submitInteractivePrompt({
        requestId: "turn-plan",
        action: "feedback",
        payload: { text: "focus on failing tests" }
      });
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [{ type: "text", text: "focus on failing tests" }]
        })
      );
    });
    // Feedback never flips plan mode off.
    expect(updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ planMode: false })
      })
    );
  });

  it("ignores empty plan feedback without submitting a prompt", async () => {
    const exec = vi.fn(async () => ({ events: [] }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "codex",
          settings: { planMode: true, permissionModeId: "auto" }
        })
      ),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "codex"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.submitInteractivePrompt({
        requestId: "turn-plan",
        action: "feedback",
        payload: { text: "   " }
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exec).not.toHaveBeenCalled();
  });

  it("offers plan implementation when the latest codex turn produced a plan item", async () => {
    const planTimelineItem = {
      id: 1,
      workspaceId: "room-1",
      agentSessionId: "session-1",
      turnId: "turn-plan",
      eventId: "plan-msg-1",
      actorType: "agent",
      actorId: "codex",
      itemType: "message",
      role: "assistant",
      content: "# Plan\n1. inspect",
      payload: { messageKind: "plan" },
      occurredAtUnixMs: 10,
      createdAtUnixMs: 10
    } as unknown as Parameters<typeof timelineItemToMessage>[0];

    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({
        timelineItems: [planTimelineItem]
      })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getComposerOptions: vi.fn(async () => ({
        provider: "codex",
        modelConfig: { configurable: true, options: [] },
        reasoningConfig: { configurable: true, options: [] },
        runtimeContext: { capabilities: ["planMode"] }
      })),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "codex",
          status: "ready",
          settings: { planMode: true, permissionModeId: "auto" },
          runtimeContext: { capabilities: ["planMode"] }
        })
      )
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "codex"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt).toEqual(
        expect.objectContaining({
          kind: "plan-implementation",
          requestId: "turn-plan"
        })
      );
    });

    // Skip suppresses the offer for that plan turn.
    act(() => {
      result.current.actions.submitInteractivePrompt({
        requestId: "turn-plan",
        action: "skip"
      });
    });
    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt).toBeNull();
    });
  });

  it("implements a codex plan by leaving plan mode then submitting the literal prompt", async () => {
    const exec = vi.fn(async () => ({ events: [] }));
    const updateSettings = vi.fn(async ({ settings }) => ({ settings }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "codex",
          settings: {
            planMode: true,
            permissionModeId: "auto"
          }
        })
      ),
      exec,
      updateSettings
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "codex"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.submitInteractivePrompt({
        requestId: "turn-plan",
        action: "implement"
      });
    });

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ planMode: false })
        })
      );
    });
    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith(
        expect.objectContaining({
          content: [{ type: "text", text: "Implement the plan." }]
        })
      );
    });
  });

  it("does not submit plan implementation when leaving plan mode fails", async () => {
    const planTimelineItem = {
      id: 1,
      workspaceId: "room-1",
      agentSessionId: "session-1",
      turnId: "turn-plan",
      eventId: "plan-msg-1",
      actorType: "agent",
      actorId: "codex",
      itemType: "message",
      role: "assistant",
      content: "# Plan\n1. inspect",
      payload: { messageKind: "plan" },
      occurredAtUnixMs: 10,
      createdAtUnixMs: 10
    } as unknown as Parameters<typeof timelineItemToMessage>[0];
    const exec = vi.fn(async () => ({ events: [] }));
    const updateSettings = vi.fn(async () => {
      throw new Error("daemon disconnected");
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({
        timelineItems: [planTimelineItem]
      })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          provider: "codex",
          status: "ready",
          settings: {
            planMode: true,
            permissionModeId: "auto"
          },
          runtimeContext: { capabilities: ["planMode"] }
        })
      ),
      exec,
      updateSettings
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "codex"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt).toEqual(
        expect.objectContaining({
          kind: "plan-implementation",
          requestId: "turn-plan"
        })
      );
    });

    act(() => {
      result.current.actions.submitInteractivePrompt({
        requestId: "turn-plan",
        action: "implement"
      });
    });

    await waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({ planMode: false })
        })
      );
    });
    await Promise.resolve();

    expect(exec).not.toHaveBeenCalled();
    expect(result.current.viewModel.pendingInteractivePrompt).toEqual(
      expect.objectContaining({
        kind: "plan-implementation",
        requestId: "turn-plan"
      })
    );
  });

  it("keeps plan mode after rejecting an exit-plan prompt", async () => {
    const submitInteractive = vi.fn(async () => ({
      agentSessionId: "session-1",
      requestId: "request-plan",
      accepted: true,
      events: []
    }));
    const updateSettings = vi.fn(async ({ settings }) => ({ settings }));
    installExitPlanPromptHostApi({ submitInteractive, updateSettings });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "claude-code"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.kind).toBe(
        "exit-plan"
      );
    });

    act(() => {
      result.current.actions.submitInteractivePrompt({
        requestId: "request-plan",
        action: "deny",
        payload: { denyMessage: "keep planning" }
      });
    });

    await waitFor(() => {
      expect(submitInteractive).toHaveBeenCalled();
    });
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("reports caught approval submission errors to runtime diagnostics", async () => {
    const stackOverflow = new RangeError("Maximum call stack size exceeded");
    stackOverflow.stack =
      "RangeError: Maximum call stack size exceeded\n    at mergeRecords";
    const submitInteractive = vi.fn(async () => {
      throw stackOverflow;
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "approval",
            requestId: "request-1",
            toolName: "Run command",
            status: "waiting",
            input: {
              callId: "call-1",
              options: [
                {
                  id: "allow_once",
                  label: "Allow once",
                  kind: "allow_once"
                }
              ]
            }
          }
        })
      ),
      submitInteractive
    });
    const reportDiagnostic = vi.fn();
    (
      window as unknown as { agentActivityRuntime: AgentActivityRuntime }
    ).agentActivityRuntime.reportDiagnostic = reportDiagnostic;

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "openclaw"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingApproval?.requestId).toBe(
        "request-1"
      );
    });

    act(() => {
      result.current.actions.submitApprovalOption("request-1", "allow_once");
    });

    await waitFor(() => {
      expect(result.current.viewModel.detailError).toBe(
        "Maximum call stack size exceeded"
      );
    });
    expect(reportDiagnostic).toHaveBeenCalledWith({
      details: expect.objectContaining({
        agentSessionId: "session-1",
        error: expect.objectContaining({
          message: "Maximum call stack size exceeded",
          name: "RangeError",
          stack: expect.stringContaining("mergeRecords")
        }),
        errorCode: null,
        phase: "submit_interactive",
        provider: "openclaw",
        requestId: "request-1"
      }),
      event: "agent.gui.caught_error",
      level: "error",
      source: "agent-gui",
      workspaceId: "room-1"
    });
  });

  it("redacts caught approval app error debug messages from runtime diagnostics", async () => {
    const submitInteractive = vi.fn(async () => {
      throw createAppError("common.unexpected", {
        debugMessage: "secret prompt: deploy production credentials"
      });
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "approval",
            requestId: "request-1",
            toolName: "Run command",
            status: "waiting",
            input: {
              callId: "call-1",
              options: [
                {
                  id: "allow_once",
                  label: "Allow once",
                  kind: "allow_once"
                }
              ]
            }
          }
        })
      ),
      submitInteractive
    });
    const reportDiagnostic = vi.fn();
    (
      window as unknown as { agentActivityRuntime: AgentActivityRuntime }
    ).agentActivityRuntime.reportDiagnostic = reportDiagnostic;

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1", "openclaw"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingApproval?.requestId).toBe(
        "request-1"
      );
    });

    act(() => {
      result.current.actions.submitApprovalOption("request-1", "allow_once");
    });

    await waitFor(() => {
      expect(reportDiagnostic).toHaveBeenCalled();
    });
    const diagnosticPayload = reportDiagnostic.mock.calls.find(
      ([payload]) => payload?.event === "agent.gui.caught_error"
    )?.[0];
    expect(diagnosticPayload).toEqual({
      details: expect.objectContaining({
        agentSessionId: "session-1",
        error: expect.objectContaining({
          code: "common.unexpected",
          debugMessageLength: expect.any(Number),
          messageLength: expect.any(Number),
          name: "TshAppError"
        }),
        errorCode: "common.unexpected",
        phase: "submit_interactive",
        provider: "openclaw",
        requestId: "request-1"
      }),
      event: "agent.gui.caught_error",
      level: "error",
      source: "agent-gui",
      workspaceId: "room-1"
    });
    expect(JSON.stringify(diagnosticPayload)).not.toContain("secret prompt");
    expect(JSON.stringify(diagnosticPayload)).not.toContain(
      "deploy production credentials"
    );
  });

  it("preserves raw approval option ids through the interactive endpoint", async () => {
    const submitInteractive = vi.fn(async () => ({
      agentSessionId: "session-1",
      requestId: "request-1",
      accepted: true,
      events: []
    }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () => agentSessionState("session-1")),
      submitInteractive
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.submitApprovalOption("request-1", "abort");
    });

    await waitFor(() => {
      expect(submitInteractive).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        requestId: "request-1",
        optionId: "abort"
      });
    });
  });

  it("submits approval denial feedback through the interactive endpoint", async () => {
    const submitInteractive = vi.fn(async () => ({
      agentSessionId: "session-1",
      requestId: "request-1",
      accepted: true,
      events: []
    }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "approval",
            requestId: "request-1",
            toolName: "Run command",
            status: "waiting",
            input: {
              callId: "call-1",
              options: [
                { optionId: "abort", name: "Abort", kind: "reject_once" }
              ]
            }
          }
        })
      ),
      submitInteractive
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingApproval?.requestId).toBe(
        "request-1"
      );
    });

    act(() => {
      result.current.actions.submitInteractivePrompt({
        requestId: "request-1",
        action: "deny",
        optionId: "abort",
        payload: {
          denyMessage: "Please split the work into smaller steps."
        }
      });
    });

    await waitFor(() => {
      expect(submitInteractive).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        requestId: "request-1",
        action: "deny",
        optionId: "abort",
        payload: {
          denyMessage: "Please split the work into smaller steps."
        }
      });
    });
    expect(result.current.viewModel.queuedPrompts).toEqual([]);
  });

  it("derives ask-user prompts from the session state snapshot and submits answers", async () => {
    const submitInteractive = vi.fn(async () => ({
      agentSessionId: "session-1",
      requestId: "request-ask",
      accepted: true,
      events: []
    }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "interactive",
            requestId: "request-ask",
            toolName: "AskUserQuestion",
            status: "waiting",
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
          }
        })
      ),
      submitInteractive
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt).toEqual(
        expect.objectContaining({
          kind: "ask-user",
          requestId: "request-ask"
        })
      );
    });

    act(() => {
      result.current.actions.submitInteractivePrompt({
        requestId: "request-ask",
        action: "submit",
        payload: {
          answers: ["Small"],
          answersByQuestionId: { scope: "Small" }
        }
      });
    });

    await waitFor(() => {
      expect(submitInteractive).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        requestId: "request-ask",
        action: "submit",
        payload: {
          answers: ["Small"],
          answersByQuestionId: { scope: "Small" }
        }
      });
    });
  });

  it("does not load conversations without a current user id", async () => {
    const list = vi.fn(async () => snapshotWithSession("session-1"));
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      autoLoadRuntime: false
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: null,
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await Promise.resolve();

    expect(list).not.toHaveBeenCalled();
    expect(result.current.viewModel.conversations).toEqual([]);
    expect(result.current.viewModel.activeConversationId).toBeNull();
  });

  it("does not auto-activate completed historical conversations", async () => {
    const activate = vi.fn(
      async (input: AgentHostActivateAgentSessionInput) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const },
        events: []
      })
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-completed", {
            lifecycleStatus: "completed",
            effectiveStatus: "completed",
            providerSessionId: "provider-session-completed"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      activate
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-completed"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe(
        "session-completed"
      );
    });

    expect(activate).not.toHaveBeenCalled();
  });

  it("keeps a newly submitted prompt at the tail when live events arrive before the remote timeline catches up", async () => {
    let emitEvent:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const listSessionTimeline = vi.fn(async () => ({
      timelineItems: [
        timelineMessage({
          agentSessionId: "session-1",
          id: 1,
          eventId: "old-user",
          role: "user",
          content: "Old ask",
          turnId: "turn-1"
        }),
        timelineMessage({
          agentSessionId: "session-1",
          id: 2,
          eventId: "old-assistant",
          role: "assistant",
          content: "Old answer",
          turnId: "turn-1"
        })
      ]
    }));
    const exec = vi.fn(async () => ({
      agentSessionId: "session-1",
      turnId: "turn-2",
      accepted: true,
      sessionStatus: "working" as const,
      events: []
    }));
    const subscribeEvents = vi.fn(
      (
        _input: { workspaceId?: string | null; agentSessionId: string },
        onEvent: (event: AgentHostAgentActivityStreamEvent) => void
      ) => {
        emitEvent = onEvent;
        return vi.fn();
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline,
      subscribeEvents,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversationDetail?.turns).toHaveLength(
        1
      );
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("New ask"));
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        ...promptContent("New ask")
      });
    });
    await waitFor(() => {
      expect(subscribeEvents).toHaveBeenCalledTimes(1);
    });

    act(() => {
      emitEvent?.(
        streamMessage({
          agentSessionId: "session-1",
          eventId: "assistant-new",
          id: 100,
          role: "assistant",
          content: "New answer",
          turnId: "turn-2"
        })
      );
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.conversationDetail?.turns.at(-1)
      ).toMatchObject({
        id: "turn-2",
        userMessage: { body: "New ask" },
        agentMessages: [{ body: "New answer" }]
      });
    });
  });

  it("keeps the optimistic user prompt visible while the remote timeline still lags behind", async () => {
    const listSessionTimeline = vi
      .fn()
      .mockResolvedValueOnce({
        timelineItems: [
          timelineMessage({
            agentSessionId: "session-1",
            id: 1,
            eventId: "old-user",
            role: "user",
            content: "Old ask",
            turnId: "turn-1"
          }),
          timelineMessage({
            agentSessionId: "session-1",
            id: 2,
            eventId: "old-assistant",
            role: "assistant",
            content: "Old answer",
            turnId: "turn-1"
          })
        ]
      })
      .mockResolvedValue({
        timelineItems: [
          timelineMessage({
            agentSessionId: "session-1",
            id: 1,
            eventId: "old-user",
            role: "user",
            content: "Old ask",
            turnId: "turn-1"
          }),
          timelineMessage({
            agentSessionId: "session-1",
            id: 2,
            eventId: "old-assistant",
            role: "assistant",
            content: "Old answer",
            turnId: "turn-1"
          })
        ]
      });
    const exec = vi.fn(async () => ({
      agentSessionId: "session-1",
      turnId: "turn-2",
      accepted: true,
      sessionStatus: "working" as const,
      events: []
    }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn()),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversationDetail?.turns).toHaveLength(
        1
      );
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("New ask"));
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        ...promptContent("New ask")
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.conversationDetail?.turns).toHaveLength(
        2
      );
    });
    expect(
      result.current.viewModel.conversationDetail?.turns.at(-1)
    ).toMatchObject({
      id: "turn-2",
      userMessage: { body: "New ask" },
      agentMessages: []
    });
  });

  it("keeps the processing row visible when exec acknowledges a prompt with ready status", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        presences: [],
        sessions: [workspaceAgentSession("session-1")]
      })
      .mockResolvedValueOnce({
        presences: [],
        sessions: [workspaceAgentSession("session-1")]
      });
    const listSessionTimeline = vi
      .fn()
      .mockResolvedValueOnce({
        timelineItems: [
          timelineMessage({
            agentSessionId: "session-1",
            id: 1,
            eventId: "old-user",
            role: "user",
            content: "Old ask",
            turnId: "turn-1"
          }),
          timelineMessage({
            agentSessionId: "session-1",
            id: 2,
            eventId: "old-assistant",
            role: "assistant",
            content: "Old answer",
            turnId: "turn-1"
          })
        ]
      })
      .mockResolvedValue({
        timelineItems: [
          timelineMessage({
            agentSessionId: "session-1",
            id: 1,
            eventId: "old-user",
            role: "user",
            content: "Old ask",
            turnId: "turn-1"
          }),
          timelineMessage({
            agentSessionId: "session-1",
            id: 2,
            eventId: "old-assistant",
            role: "assistant",
            content: "Old answer",
            turnId: "turn-1"
          })
        ]
      });
    const exec = vi
      .fn()
      .mockResolvedValueOnce({
        agentSessionId: "session-1",
        turnId: "turn-2",
        accepted: true,
        sessionStatus: "ready" as const,
        events: []
      })
      .mockResolvedValueOnce({
        agentSessionId: "session-1",
        turnId: "turn-3",
        accepted: true,
        sessionStatus: "ready" as const,
        events: []
      });
    installAgentHostApi({
      list,
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn()),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversationDetail?.turns).toHaveLength(
        1
      );
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("New ask"));
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        ...promptContent("New ask")
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.conversationDetail?.turns).toHaveLength(
        2
      );
    });
    expect(
      result.current.viewModel.conversationDetail?.turns.at(-1)
    ).toMatchObject({
      id: "turn-2",
      userMessage: { body: "New ask" },
      agentMessages: []
    });
    expect(
      result.current.viewModel.conversation?.rows.some(
        (row) => row.kind === "processing"
      )
    ).toBe(true);
    expect(result.current.viewModel.activeConversation?.status).toBe("working");
  });

  it("settles a pending submitted prompt when its state patch reports idle", async () => {
    let emitEvent:
      | ((event: AgentHostAgentActivityStreamEvent) => void)
      | undefined;
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        presences: [],
        sessions: [workspaceAgentSession("session-1")]
      })
      .mockResolvedValueOnce({
        presences: [],
        sessions: [workspaceAgentSession("session-1")]
      });
    const listSessionTimeline = vi
      .fn()
      .mockResolvedValueOnce({
        timelineItems: [
          timelineMessage({
            agentSessionId: "session-1",
            id: 1,
            eventId: "old-user",
            role: "user",
            content: "Old ask",
            turnId: "turn-1"
          }),
          timelineMessage({
            agentSessionId: "session-1",
            id: 2,
            eventId: "old-assistant",
            role: "assistant",
            content: "Old answer",
            turnId: "turn-1"
          })
        ]
      })
      .mockResolvedValue({
        timelineItems: [
          timelineMessage({
            agentSessionId: "session-1",
            id: 1,
            eventId: "old-user",
            role: "user",
            content: "Old ask",
            turnId: "turn-1"
          }),
          timelineMessage({
            agentSessionId: "session-1",
            id: 2,
            eventId: "old-assistant",
            role: "assistant",
            content: "Old answer",
            turnId: "turn-1"
          })
        ]
      });
    const exec = vi.fn(async () => ({
      agentSessionId: "session-1",
      turnId: "turn-2",
      accepted: true,
      sessionStatus: "ready" as const,
      events: []
    }));
    const subscribeEvents = vi.fn(
      (
        _input: { workspaceId?: string | null; agentSessionId: string },
        onEvent: (event: AgentHostAgentActivityStreamEvent) => void
      ) => {
        emitEvent = onEvent;
        return vi.fn();
      }
    );
    installAgentHostApi({
      list,
      listSessionTimeline,
      subscribeEvents,
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversationDetail?.turns).toHaveLength(
        1
      );
    });
    await waitFor(() => {
      expect(subscribeEvents).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.actions.submitPrompt(promptContent("New ask").content);
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe(
        "working"
      );
    });

    act(() => {
      emitEvent?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          lifecycleStatus: "active",
          currentPhase: "idle",
          turn: {
            turnId: "turn-2",
            phase: "idle",
            outcome: "completed"
          },
          occurredAtUnixMs: 20
        }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe("ready");
    });

    act(() => {
      result.current.actions.submitPrompt(promptContent("Another ask").content);
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe(
        "working"
      );
    });

    act(() => {
      emitEvent?.({
        eventType: "state_patch",
        data: {
          agentSessionId: "session-1",
          lifecycleStatus: "active",
          currentPhase: "idle",
          occurredAtUnixMs: 21
        }
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.activeConversation?.status).toBe("ready");
    });
  });

  it("does not queue when activity-core is idle but stale control state is working", async () => {
    const exec = vi.fn(async () => ({
      agentSessionId: "session-1",
      turnId: "turn-1",
      accepted: true,
      sessionStatus: "working" as const,
      events: []
    }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", { status: "working" })
      ),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    await waitFor(() => {
      expect(result.current.viewModel.canQueueWhileBusy).toBe(false);
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("send immediately"));
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        ...promptContent("send immediately")
      });
    });
    expect(result.current.viewModel.queuedPrompts).toEqual([]);
  });

  it("does not enable local queue from a pending prompt when activity-core is idle", async () => {
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "interactive",
            requestId: "request-ask",
            toolName: "AskUserQuestion",
            status: "waiting",
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
          }
        })
      )
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.requestId).toBe(
        "request-ask"
      );
    });
    expect(result.current.viewModel.canQueueWhileBusy).toBe(false);
  });

  it("queues busy prompts locally without sending them through backend exec", async () => {
    const list = vi.fn(async () => ({
      presences: [],
      sessions: [
        workspaceAgentSession("session-1", {
          effectiveStatus: "waiting",
          turnPhase: "waiting"
        })
      ]
    }));
    const exec = vi.fn();
    installAgentHostApi({
      list,
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "interactive",
            requestId: "request-ask",
            toolName: "AskUserQuestion",
            status: "waiting",
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
          }
        })
      ),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.requestId).toBe(
        "request-ask"
      );
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("first queued prompt"));
      result.current.actions.submitPrompt(promptBlocks("second queued prompt"));
    });

    await waitFor(() => {
      expect(queuedPromptTexts(result.current.viewModel.queuedPrompts)).toEqual(
        ["first queued prompt", "second queued prompt"]
      );
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("sends guidance prompts directly while an active turn is running", async () => {
    const exec = vi.fn(async () => ({
      agentSessionId: "session-1",
      turnId: "turn-2",
      accepted: true,
      sessionStatus: "working" as const,
      events: []
    }));
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "working",
            turnPhase: "running"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          status: "working",
          turnLifecycle: { activeTurnId: "turn-1", phase: "running" },
          submitAvailability: { state: "blocked", reason: "active_turn" }
        })
      ),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    await waitFor(() => {
      expect(result.current.viewModel.canQueueWhileBusy).toBe(true);
    });

    act(() => {
      result.current.actions.submitGuidancePrompt(
        promptBlocks("steer the current turn")
      );
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        ...promptContent("steer the current turn")
      });
    });
    expect(result.current.viewModel.queuedPrompts).toEqual([]);
  });

  it("queues image prompts locally while busy and drains them with image content", async () => {
    const imagePromptContent: AgentPromptContentBlock[] = [
      { type: "text", text: "describe this" },
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        name: "panel.png"
      }
    ];
    const exec = vi.fn(async () => ({
      agentSessionId: "session-1",
      turnId: "turn-2",
      accepted: true,
      sessionStatus: "working" as const,
      events: []
    }));
    installAgentHostApi({
      list: vi.fn(async () =>
        snapshotWithSession("session-1", {
          effectiveStatus: "working",
          turnPhase: "working"
        })
      ),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    await waitFor(() => {
      expect(result.current.viewModel.canQueueWhileBusy).toBe(true);
    });

    act(() => {
      result.current.actions.submitPrompt(imagePromptContent);
    });

    await waitFor(() => {
      expect(result.current.viewModel.queuedPrompts).toEqual([
        expect.objectContaining({
          content: imagePromptContent
        })
      ]);
    });
    expect(result.current.viewModel.detailError).toBeNull();
    expect(exec).not.toHaveBeenCalled();

    act(() => {
      emitRuntimeSessionEventForTests?.({
        eventType: "state_patch",
        data: {
          workspaceId: "room-1",
          agentSessionId: "session-1",
          lifecycleStatus: "active",
          currentPhase: "idle",
          occurredAtUnixMs: 20
        }
      });
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        content: imagePromptContent
      });
    });
  });

  it("preserves draft text entered while a prompt submission is in flight", async () => {
    let resolveExec:
      | ((result: {
          accepted: boolean;
          agentSessionId: string;
          turnId: string;
          sessionStatus: string;
        }) => void)
      | undefined;
    const exec = vi.fn(
      () =>
        new Promise<{
          accepted: boolean;
          agentSessionId: string;
          turnId: string;
          sessionStatus: string;
        }>((resolve) => {
          resolveExec = resolve;
        })
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.updateDraftContent(draftContent("first prompt"));
      result.current.actions.submitPrompt(promptBlocks("first prompt"));
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        ...promptContent("first prompt")
      });
    });

    act(() => {
      result.current.actions.updateDraftContent(
        draftContent("keep this draft")
      );
      resolveExec?.({
        accepted: true,
        agentSessionId: "session-1",
        turnId: "turn-1",
        sessionStatus: "working"
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.isSubmitting).toBe(false);
    });
    expect(result.current.viewModel.draftPrompt).toBe("keep this draft");
  });

  it("clears submitted image draft content when prompt submission settles", async () => {
    const imagePromptContent: AgentPromptContentBlock[] = [
      { type: "text", text: "describe this" },
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        name: "panel.png"
      }
    ];
    let resolveExec:
      | ((result: {
          accepted: boolean;
          agentSessionId: string;
          turnId: string;
          sessionStatus: string;
        }) => void)
      | undefined;
    const exec = vi.fn(
      () =>
        new Promise<{
          accepted: boolean;
          agentSessionId: string;
          turnId: string;
          sessionStatus: string;
        }>((resolve) => {
          resolveExec = resolve;
        })
    );
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.updateDraftContent({
        prompt: "describe this",
        images: [
          {
            id: "draft-image-1",
            name: "panel.png",
            mimeType: "image/png",
            data: "aW1hZ2U=",
            previewUrl: "data:image/png;base64,aW1hZ2U="
          }
        ]
      });
      result.current.actions.submitPrompt(imagePromptContent);
    });

    await waitFor(() => {
      expect(exec).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        content: imagePromptContent
      });
    });

    act(() => {
      resolveExec?.({
        accepted: true,
        agentSessionId: "session-1",
        turnId: "turn-1",
        sessionStatus: "working"
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.isSubmitting).toBe(false);
    });
    expect(result.current.viewModel.draftPrompt).toBe("");
    expect(result.current.viewModel.draftContent.images).toEqual([]);
  });

  it("edits a local queued prompt back into the draft", async () => {
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithWaitingSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "interactive",
            requestId: "request-ask",
            toolName: "AskUserQuestion",
            status: "waiting",
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
          }
        })
      )
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });
    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.requestId).toBe(
        "request-ask"
      );
    });

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.requestId).toBe(
        "request-ask"
      );
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("first queued prompt"));
      result.current.actions.submitPrompt(promptBlocks("second queued prompt"));
    });

    await waitFor(() => {
      expect(queuedPromptTexts(result.current.viewModel.queuedPrompts)).toEqual(
        ["first queued prompt", "second queued prompt"]
      );
    });
    const queuedPromptId = result.current.viewModel.queuedPrompts[1]?.id;
    expect(queuedPromptId).toBeTruthy();

    act(() => {
      result.current.actions.editQueuedPrompt(queuedPromptId!);
    });

    await waitFor(() => {
      expect(queuedPromptTexts(result.current.viewModel.queuedPrompts)).toEqual(
        ["first queued prompt"]
      );
      expect(result.current.viewModel.draftPrompt).toBe("second queued prompt");
    });
  });

  it("edits a local queued image prompt back into the draft content restore", async () => {
    const imagePromptContent: AgentPromptContentBlock[] = [
      { type: "text", text: "describe this" },
      {
        type: "image",
        mimeType: "image/png",
        data: "aW1hZ2U=",
        name: "panel.png"
      }
    ];
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithWaitingSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn())
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.activeConversationId).toBe("session-1");
    });

    act(() => {
      result.current.actions.submitPrompt(imagePromptContent);
    });

    await waitFor(() => {
      expect(result.current.viewModel.queuedPrompts).toEqual([
        expect.objectContaining({
          content: imagePromptContent
        })
      ]);
    });
    const queuedPromptId = result.current.viewModel.queuedPrompts[0]?.id;
    expect(queuedPromptId).toBeTruthy();

    act(() => {
      result.current.actions.editQueuedPrompt(queuedPromptId!);
    });

    await waitFor(() => {
      expect(result.current.viewModel.queuedPrompts).toEqual([]);
      expect(result.current.viewModel.draftPrompt).toBe("describe this");
      expect(result.current.viewModel.draftContent.images).toEqual([
        expect.objectContaining({
          id: `restore-${queuedPromptId}:image:0`,
          name: "panel.png",
          mimeType: "image/png",
          data: "aW1hZ2U=",
          previewUrl: "data:image/png;base64,aW1hZ2U="
        })
      ]);
    });
  });

  it("queues prompts locally during a pending interactive prompt without calling backend exec", async () => {
    const exec = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithWaitingSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "interactive",
            requestId: "request-ask",
            toolName: "AskUserQuestion",
            status: "waiting",
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
          }
        })
      ),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.requestId).toBe(
        "request-ask"
      );
    });

    act(() => {
      result.current.actions.submitPrompt(
        promptBlocks("prompt that backend rejects")
      );
    });

    await waitFor(() => {
      expect(result.current.viewModel.queuedPrompts).toEqual([
        expect.objectContaining({
          content: promptBlocks("prompt that backend rejects")
        })
      ]);
      expect(result.current.viewModel.detailError).toBeNull();
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not hit backend exec for busy prompts that would otherwise active-turn conflict", async () => {
    const exec = vi.fn(async () => {
      throw new Error("agent session already has an active turn");
    });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            effectiveStatus: "waiting",
            turnPhase: "waiting"
          })
        ]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "interactive",
            requestId: "request-ask",
            toolName: "AskUserQuestion",
            status: "waiting",
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
          }
        })
      ),
      exec
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.requestId).toBe(
        "request-ask"
      );
    });

    act(() => {
      result.current.actions.submitPrompt(
        promptBlocks("locally queued prompt")
      );
    });

    await waitFor(() => {
      expect(result.current.viewModel.queuedPrompts).toEqual([
        expect.objectContaining({
          content: promptBlocks("locally queued prompt")
        })
      ]);
      expect(result.current.viewModel.detailError).toBeNull();
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("promotes a local queued prompt while an interactive prompt is pending", async () => {
    const cancel = vi.fn(async () => ({ canceled: true }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithWaitingSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "interactive",
            requestId: "request-ask",
            toolName: "AskUserQuestion",
            status: "waiting",
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
          }
        })
      ),
      cancel
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.requestId).toBe(
        "request-ask"
      );
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("first queued prompt"));
      result.current.actions.submitPrompt(promptBlocks("second queued prompt"));
      result.current.actions.submitPrompt(promptBlocks("third queued prompt"));
    });

    await waitFor(() => {
      expect(result.current.viewModel.queuedPrompts).toHaveLength(3);
    });

    const queuedPromptId = result.current.viewModel.queuedPrompts[2]?.id;
    expect(queuedPromptId).toBeTruthy();

    act(() => {
      result.current.actions.sendQueuedPromptNext(queuedPromptId!);
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(queuedPromptTexts(result.current.viewModel.queuedPrompts)).toEqual([
      "third queued prompt",
      "first queued prompt",
      "second queued prompt"
    ]);
  });

  it("does not interrupt immediately when send next is requested during an interactive prompt", async () => {
    const cancel = vi.fn(async () => ({ canceled: true }));
    installAgentHostApi({
      list: vi.fn(async () => snapshotWithWaitingSession("session-1")),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      getState: vi.fn(async () =>
        agentSessionState("session-1", {
          pendingInteractive: {
            kind: "interactive",
            requestId: "request-ask",
            toolName: "AskUserQuestion",
            status: "waiting",
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
          }
        })
      ),
      cancel
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.requestId).toBe(
        "request-ask"
      );
    });

    await waitFor(() => {
      expect(result.current.viewModel.pendingInteractivePrompt?.requestId).toBe(
        "request-ask"
      );
    });

    act(() => {
      result.current.actions.submitPrompt(promptBlocks("first queued prompt"));
      result.current.actions.submitPrompt(promptBlocks("second queued prompt"));
    });

    await waitFor(() => {
      expect(queuedPromptTexts(result.current.viewModel.queuedPrompts)).toEqual(
        ["first queued prompt", "second queued prompt"]
      );
    });
    const queuedPromptId = result.current.viewModel.queuedPrompts[1]?.id;
    expect(queuedPromptId).toBeTruthy();

    act(() => {
      result.current.actions.sendQueuedPromptNext(queuedPromptId!);
    });

    expect(queuedPromptTexts(result.current.viewModel.queuedPrompts)).toEqual([
      "second queued prompt",
      "first queued prompt"
    ]);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(cancel).not.toHaveBeenCalled();
  });

  it("deletes the active conversation and selects the next session", async () => {
    let resolveDeleteSession: (() => void) | null = null;
    const deleteSession = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDeleteSession = () => resolve({});
        })
    );
    const session2TimelineResolvers: Array<
      (value: { timelineItems: AgentHostWorkspaceAgentTimelineItem[] }) => void
    > = [];
    const listSessionTimeline = vi.fn(
      ({ agentSessionId }: { agentSessionId: string }) => {
        if (agentSessionId === "session-2") {
          return new Promise<{
            timelineItems: AgentHostWorkspaceAgentTimelineItem[];
          }>((resolve) => {
            session2TimelineResolvers.push(resolve);
          });
        }
        return Promise.resolve({ timelineItems: [] });
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1"),
          workspaceAgentSession("session-2")
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn()),
      deleteSession
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversations).toHaveLength(2);
    });

    act(() => {
      result.current.actions.requestDeleteConversation("session-1");
    });
    act(() => {
      result.current.actions.confirmDeleteConversation();
    });

    await waitFor(() => {
      expect(deleteSession).toHaveBeenCalledWith({
        workspaceId: "room-1",
        agentSessionId: "session-1",
        sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN
      });
    });
    expect(result.current.viewModel.isDeletingConversation).toBe(true);
    expect(result.current.viewModel.isLoadingMessages).toBe(true);

    await act(async () => {
      resolveDeleteSession?.();
    });

    await waitFor(() => {
      expect(
        result.current.viewModel.conversations.map(
          (conversation) => conversation.id
        )
      ).toEqual(["session-2"]);
    });
    expect(result.current.viewModel.activeConversationId).toBe("session-2");
    await waitFor(() => {
      expect(session2TimelineResolvers.length).toBeGreaterThan(0);
    });
    expect(result.current.viewModel.isLoadingMessages).toBe(true);
    expect(
      getAgentSessionView({
        workspaceId: "room-1",
        agentSessionId: "session-2"
      })?.isLoadingMessages
    ).toBe(true);

    await act(async () => {
      for (const resolve of session2TimelineResolvers.splice(0)) {
        resolve({
          timelineItems: [
            timelineMessage({
              agentSessionId: "session-2",
              id: 2,
              eventId: "session-2-user",
              role: "user",
              content: "Continue here"
            })
          ]
        });
      }
    });

    await waitFor(() => {
      expect(result.current.viewModel.isLoadingMessages).toBe(false);
      expect(result.current.viewModel.conversation?.rows).toHaveLength(1);
    });
  });

  it("shows a toast when deleting a conversation fails", async () => {
    const deleteSession = vi.fn(async () => {
      throw new Error("delete failed");
    });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [workspaceAgentSession("session-1")]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      deleteSession
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversations).toHaveLength(1);
    });

    act(() => {
      result.current.actions.requestDeleteConversation("session-1");
    });
    act(() => {
      result.current.actions.confirmDeleteConversation();
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("delete failed");
    });
    expect(result.current.viewModel.detailError).toBe("delete failed");
  });

  it("shows a toast when pinning a conversation fails", async () => {
    const setSessionPinned = vi.fn(async () => {
      throw new Error("pin failed");
    });
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [workspaceAgentSession("session-1")]
      })),
      listSessionTimeline: vi.fn(async () => ({ timelineItems: [] })),
      subscribeEvents: vi.fn(() => vi.fn()),
      setSessionPinned
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel.conversations).toHaveLength(1);
    });

    act(() => {
      result.current.actions.toggleConversationPinned("session-1", true);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("pin failed");
    });
    expect(result.current.viewModel.detailError).toBe("pin failed");
    expect(result.current.viewModel.activeConversation?.pinnedAtUnixMs).toBe(
      null
    );
  });

  it("batch deletes all conversations assigned to a project", async () => {
    const deleteSession = vi.fn(async () => ({}));
    const session3TimelineResolvers: Array<
      (value: { timelineItems: AgentHostWorkspaceAgentTimelineItem[] }) => void
    > = [];
    const listSessionTimeline = vi.fn(
      ({ agentSessionId }: { agentSessionId: string }) => {
        if (agentSessionId === "session-3") {
          return new Promise<{
            timelineItems: AgentHostWorkspaceAgentTimelineItem[];
          }>((resolve) => {
            session3TimelineResolvers.push(resolve);
          });
        }
        return Promise.resolve({ timelineItems: [] });
      }
    );
    installAgentHostApi({
      list: vi.fn(async () => ({
        presences: [],
        sessions: [
          workspaceAgentSession("session-1", {
            cwd: "/workspace/app"
          }),
          workspaceAgentSession("session-2", {
            cwd: "/workspace/app/src",
            pinnedAtUnixMs: 10
          }),
          workspaceAgentSession("session-3", {
            cwd: "/workspace/site"
          })
        ]
      })),
      listSessionTimeline,
      subscribeEvents: vi.fn(() => vi.fn()),
      deleteSession,
      userProjects: {
        list: vi.fn(async () => ({
          projects: [
            {
              id: "app",
              path: "/workspace/app",
              label: "App"
            },
            {
              id: "site",
              path: "/workspace/site",
              label: "Site"
            }
          ]
        })),
        subscribe: vi.fn(() => vi.fn()),
        use: vi.fn()
      }
    });

    const { result } = renderHook(() =>
      useAgentGUINodeController({
        workspaceId: "room-1",
        currentUserId: "user-1",
        workspacePath: "/workspace",
        avoidGroupingEdits: false,
        data: agentGuiData("session-1"),
        onDataChange: vi.fn()
      })
    );

    await waitFor(() => {
      expect(
        result.current.viewModel.conversations.map(
          (conversation) => conversation.project?.label ?? null
        )
      ).toEqual(["App", "App", "Site"]);
    });

    act(() => {
      result.current.actions.requestDeleteProjectConversations(
        "/workspace/app"
      );
    });

    expect(
      result.current.viewModel.pendingDeleteProjectConversations
    ).toMatchObject({
      conversationCount: 2,
      label: "App",
      path: "/workspace/app"
    });

    act(() => {
      result.current.actions.confirmDeleteProjectConversations();
    });

    await waitFor(() => {
      expect(deleteSession).toHaveBeenCalledTimes(2);
    });
    expect(
      (
        deleteSession.mock.calls as unknown as Array<
          [{ agentSessionId: string }]
        >
      )
        .map(([input]) => (input as { agentSessionId: string }).agentSessionId)
        .sort()
    ).toEqual(["session-1", "session-2"]);
    await waitFor(() => {
      expect(
        result.current.viewModel.conversations.map(
          (conversation) => conversation.id
        )
      ).toEqual(["session-3"]);
    });
    expect(result.current.viewModel.activeConversationId).toBe("session-3");
    await waitFor(() => {
      expect(session3TimelineResolvers.length).toBeGreaterThan(0);
    });
    expect(result.current.viewModel.isLoadingMessages).toBe(true);
    expect(
      getAgentSessionView({
        workspaceId: "room-1",
        agentSessionId: "session-3"
      })?.isLoadingMessages
    ).toBe(true);

    await act(async () => {
      for (const resolve of session3TimelineResolvers.splice(0)) {
        resolve({
          timelineItems: [
            timelineMessage({
              agentSessionId: "session-3",
              id: 3,
              eventId: "session-3-user",
              role: "user",
              content: "Remaining session"
            })
          ]
        });
      }
    });

    await waitFor(() => {
      expect(result.current.viewModel.isLoadingMessages).toBe(false);
      expect(result.current.viewModel.conversation?.rows).toHaveLength(1);
    });
  });
});

function installAgentHostApi({
  list,
  listSessionTimeline,
  subscribeEvents,
  logRuntimeDiagnostics = vi.fn(),
  listModels = vi.fn(async () => ({
    provider: "codex",
    source: "codex-cli",
    fetchedAt: new Date().toISOString(),
    models: [
      { id: "gpt-5", displayName: "GPT-5", description: "", isDefault: true }
    ],
    error: null
  })),
  activate = vi.fn(async (input: AgentHostActivateAgentSessionInput) => ({
    session: agentSession(input.agentSessionId),
    activation: { mode: input.mode, status: "attached" as const }
  })),
  unactivate = vi.fn(),
  exec = vi.fn(),
  getState = vi.fn(async ({ agentSessionId }: { agentSessionId: string }) =>
    agentSessionState(agentSessionId)
  ),
  getComposerOptions,
  submitInteractive = vi.fn(),
  cancel = vi.fn(),
  updateSettings = vi.fn(),
  deleteSession = vi.fn(),
  setSessionPinned = vi.fn(),
  warmupOpenclawGateway = vi.fn(async () => ({ accepted: true, ready: true })),
  onEvent = vi.fn(() => vi.fn()),
  retainEventStream,
  releaseEventStream,
  onSessionEvent,
  userProjects,
  trackSettingsProjectChange,
  autoLoadRuntime = false
}: {
  list: ReturnType<typeof vi.fn>;
  listSessionTimeline: ReturnType<typeof vi.fn>;
  subscribeEvents: ReturnType<typeof vi.fn>;
  autoLoadRuntime?: boolean;
  logRuntimeDiagnostics?: ReturnType<typeof vi.fn>;
  listModels?: ReturnType<typeof vi.fn>;
  activate?: ReturnType<typeof vi.fn>;
  unactivate?: ReturnType<typeof vi.fn>;
  exec?: ReturnType<typeof vi.fn>;
  getState?: ReturnType<typeof vi.fn>;
  getComposerOptions?: ReturnType<typeof vi.fn> | undefined;
  submitInteractive?: ReturnType<typeof vi.fn>;
  cancel?: ReturnType<typeof vi.fn>;
  updateSettings?: ReturnType<typeof vi.fn>;
  deleteSession?: ReturnType<typeof vi.fn>;
  setSessionPinned?: ReturnType<typeof vi.fn>;
  warmupOpenclawGateway?: ReturnType<typeof vi.fn>;
  onEvent?: ReturnType<typeof vi.fn>;
  retainEventStream?: ReturnType<typeof vi.fn> | undefined;
  releaseEventStream?: ReturnType<typeof vi.fn> | undefined;
  onSessionEvent?: ReturnType<typeof vi.fn> | undefined;
  userProjects?: unknown;
  trackSettingsProjectChange?: ReturnType<typeof vi.fn> | undefined;
}): void {
  const sessionEventListeners = new Set<
    (event: AgentHostAgentActivityStreamEvent) => void
  >();
  const emitSessionEvent = (event: AgentHostAgentActivityStreamEvent) => {
    for (const listener of sessionEventListeners) {
      listener(event);
    }
  };
  const subscribeSessionEvents = (
    listener: (event: AgentHostAgentActivityStreamEvent) => void
  ) => {
    sessionEventListeners.add(listener);
    const upstreamUnsubscribe =
      (
        onSessionEvent as
          | ((
              listener: (event: AgentHostAgentActivityStreamEvent) => void
            ) => () => void)
          | undefined
      )?.(listener) ?? null;
    return () => {
      sessionEventListeners.delete(listener);
      upstreamUnsubscribe?.();
    };
  };
  Object.defineProperty(window, "agentHostApi", {
    configurable: true,
    value: {
      agent: {
        listModels
      },
      agentSessions: {
        subscribeEvents,
        ...(retainEventStream ? { retainEventStream } : {}),
        ...(releaseEventStream ? { releaseEventStream } : {}),
        onEvent: subscribeSessionEvents,
        activate,
        unactivate,
        exec,
        cancel,
        submitApprovalOption: vi.fn(),
        updateSettings,
        getState,
        ...(trackSettingsProjectChange ? { trackSettingsProjectChange } : {}),
        ...(getComposerOptions ? { getComposerOptions } : {}),
        submitInteractive
      },
      debug: {
        logRuntimeDiagnostics
      },
      onHostEvent: onEvent,
      runtime: {
        warmupOpenclawGateway
      },
      ...(userProjects ? { userProjects } : {}),
      workspaceAgents: {
        list,
        listSessionTimeline,
        listSessionMessages: async (input: unknown) => {
          const loadTimeline = listSessionTimeline as (
            input: unknown
          ) => Promise<{
            hasMore?: boolean;
            latestVersion?: number;
            timelineItems?: AgentHostWorkspaceAgentTimelineItem[];
          }>;
          const timeline = await loadTimeline(input);
          return {
            messages: (timeline.timelineItems ?? []).map(timelineItemToMessage),
            latestVersion:
              timeline.latestVersion ??
              (timeline.timelineItems ?? []).reduce(
                (max: number, item: AgentHostWorkspaceAgentTimelineItem) =>
                  Math.max(max, item.seq ?? item.id ?? 0),
                0
              ),
            hasMore: timeline.hasMore ?? false
          };
        },
        deleteSession
      }
    }
  });
  installAgentActivityRuntimeForHostMocks({
    activate: activate as CallableMock,
    cancel: cancel as CallableMock,
    deleteSession: deleteSession as CallableMock,
    emitSessionEvent,
    exec: exec as CallableMock,
    getComposerOptions: getComposerOptions as CallableMock | undefined,
    getState: getState as CallableMock,
    list: list as CallableMock,
    listSessionTimeline: listSessionTimeline as CallableMock,
    releaseEventStream: releaseEventStream as CallableMock | undefined,
    retainEventStream: retainEventStream as CallableMock | undefined,
    subscribeEvents: subscribeEvents as CallableMock,
    submitInteractive: submitInteractive as CallableMock,
    setSessionPinned: setSessionPinned as CallableMock,
    trackSettingsProjectChange: trackSettingsProjectChange as
      | CallableMock
      | undefined,
    updateSettings: updateSettings as CallableMock,
    warmupOpenclawGateway: warmupOpenclawGateway as CallableMock,
    unactivate: unactivate as CallableMock,
    autoLoadRuntime
  });
}

function installAgentActivityRuntimeForHostMocks({
  activate,
  cancel,
  deleteSession,
  emitSessionEvent,
  exec,
  getComposerOptions,
  getState,
  list,
  listSessionTimeline,
  releaseEventStream,
  retainEventStream,
  subscribeEvents,
  submitInteractive,
  setSessionPinned,
  trackSettingsProjectChange,
  updateSettings,
  warmupOpenclawGateway,
  unactivate,
  autoLoadRuntime
}: {
  activate: CallableMock;
  autoLoadRuntime: boolean;
  cancel: CallableMock;
  deleteSession: CallableMock;
  emitSessionEvent: (event: AgentHostAgentActivityStreamEvent) => void;
  exec: CallableMock;
  getComposerOptions?: CallableMock | undefined;
  getState: CallableMock;
  list: CallableMock;
  listSessionTimeline: CallableMock;
  releaseEventStream?: CallableMock | undefined;
  retainEventStream?: CallableMock | undefined;
  subscribeEvents: CallableMock;
  submitInteractive: CallableMock;
  setSessionPinned: CallableMock;
  trackSettingsProjectChange?: CallableMock | undefined;
  updateSettings: CallableMock;
  warmupOpenclawGateway: CallableMock;
  unactivate: CallableMock;
}): void {
  const snapshotsByWorkspaceId = new Map<string, AgentActivitySnapshot>();
  const listenersByWorkspaceId = new Map<
    string,
    Set<(snapshot: AgentActivitySnapshot) => void>
  >();
  const sessionEventListenersByWorkspaceId = new Map<
    string,
    Set<(event: AgentHostAgentActivityStreamEvent) => void>
  >();

  const getSnapshot = (workspaceId: string): AgentActivitySnapshot => {
    const current = snapshotsByWorkspaceId.get(workspaceId);
    if (current) {
      return current;
    }
    const empty = emptyAgentActivitySnapshot(workspaceId);
    snapshotsByWorkspaceId.set(workspaceId, empty);
    return empty;
  };

  const setSnapshot = (
    workspaceId: string,
    updater: (current: AgentActivitySnapshot) => AgentActivitySnapshot
  ): AgentActivitySnapshot => {
    const current =
      snapshotsByWorkspaceId.get(workspaceId) ??
      emptyAgentActivitySnapshot(workspaceId);
    const next = updater(current);
    snapshotsByWorkspaceId.set(workspaceId, next);
    for (const listener of listenersByWorkspaceId.get(workspaceId) ?? []) {
      listener(next);
    }
    return next;
  };

  const loadSessionMessages = async (input: {
    afterVersion?: number;
    agentSessionId: string;
    beforeVersion?: number;
    cache?: boolean;
    limit?: number;
    order?: AgentActivityMessageOrder;
    workspaceId: string;
  }): Promise<AgentActivityMessagePage> => {
    const result = await listSessionTimeline({
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId,
      sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
      ...(input.afterVersion !== undefined
        ? { afterVersion: input.afterVersion }
        : {}),
      ...(input.beforeVersion !== undefined
        ? { beforeVersion: input.beforeVersion }
        : {}),
      ...(input.cache !== undefined ? { cache: input.cache } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.order !== undefined ? { order: input.order } : {})
    });
    const messages = (result.timelineItems ?? []).map(
      (item: AgentHostWorkspaceAgentTimelineItem) =>
        agentActivityMessageFromHostMessage(timelineItemToMessage(item), {
          workspaceId: input.workspaceId
        })
    );
    if (messages.length > 0 && input.cache !== false) {
      setSnapshot(input.workspaceId, (current) =>
        mergeMessagesInSnapshot(current, input.agentSessionId, messages)
      );
    }
    return {
      messages,
      latestVersion:
        result.latestVersion ??
        messages.reduce(
          (max: number, message: AgentActivityMessage) =>
            Math.max(max, message.version),
          0
        ),
      hasMore: result.hasMore ?? false
    };
  };

  const synchronizeSession = (
    input: AgentActivityRuntimeRetainSessionEventsInput
  ): (() => void) => {
    void loadSessionMessages(input).catch(input.onError ?? (() => {}));
    let released = false;
    let retainedLeaseId: string | null = null;
    const unsubscribe = subscribeEvents(
      {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId
      },
      (event: AgentHostAgentActivityStreamEvent) => {
        applyRuntimeStreamEvent({
          event,
          setSnapshot,
          workspaceId: input.workspaceId
        });
        emitSessionEvent(event);
      }
    );
    const retainPromise = retainEventStream?.({
      workspaceId: input.workspaceId,
      agentSessionId: input.agentSessionId
    });
    if (retainPromise) {
      void retainPromise
        .then((result: { leaseId?: string | null }) => {
          retainedLeaseId = result.leaseId ?? null;
          if (released && retainedLeaseId) {
            void releaseEventStream?.({ leaseId: retainedLeaseId });
          }
        })
        .catch(input.onError ?? (() => {}));
    }
    return () => {
      released = true;
      unsubscribe?.();
      if (retainedLeaseId) {
        void releaseEventStream?.({ leaseId: retainedLeaseId });
      }
    };
  };

  const runtime: AgentActivityRuntime = {
    async activateSession(input) {
      const result = await activate({
        mode: input.mode,
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        ...(input.mode === "new"
          ? {
              provider: input.provider,
              providerTargetRef: input.providerTargetRef,
              cwd: input.cwd,
              initialContent: input.initialContent,
              title: input.title,
              settings: input.settings,
              visible: input.visible,
              openclawGatewayReady: input.openclawGatewayReady
            }
          : { visible: input.visible })
      });
      const session = agentActivitySessionFromHostSession(
        result.session,
        input.workspaceId
      );
      setSnapshot(input.workspaceId, (current) =>
        upsertSessionInSnapshot(current, session)
      );
      return result;
    },
    async cancelSession(input) {
      const result = await cancel({
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        reason: "user_interrupt"
      });
      const canceled = result?.canceled ?? false;
      const reason =
        result?.reason ??
        (canceled ? "active_turn_canceled" : "no_active_turn");
      const session = upsertRuntimeSession(setSnapshot, input.workspaceId, {
        agentSessionId: input.agentSessionId,
        status: result?.sessionStatus ?? (canceled ? "canceled" : "ready")
      });
      return {
        canceled,
        reason,
        session
      };
    },
    async createSession(input) {
      const result = await activate({
        mode: "new",
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId ?? createTestAgentSessionId(),
        provider: input.provider,
        cwd: input.cwd ?? undefined,
        title: input.title ?? undefined,
        settings: {
          model: input.model ?? undefined,
          planMode: input.planMode ?? undefined,
          reasoningEffort: input.reasoningEffort ?? undefined,
          permissionModeId: input.permissionModeId ?? undefined
        },
        visible: input.visible ?? undefined
      });
      const session = agentActivitySessionFromHostSession(
        result.session,
        input.workspaceId
      );
      setSnapshot(input.workspaceId, (current) =>
        upsertSessionInSnapshot(current, session)
      );
      return session;
    },
    async deleteSession(input) {
      await deleteSession({
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN
      });
      setSnapshot(input.workspaceId, (current) => {
        const sessionMessagesById = { ...current.sessionMessagesById };
        delete sessionMessagesById[input.agentSessionId];
        return {
          ...current,
          sessions: current.sessions.filter(
            (session) => session.agentSessionId !== input.agentSessionId
          ),
          sessionMessagesById
        };
      });
      return { removed: true };
    },
    async getSession(workspaceId, agentSessionId) {
      const session = getSnapshot(workspaceId).sessions.find(
        (candidate) => candidate.agentSessionId === agentSessionId
      );
      if (session) {
        return session;
      }
      return upsertRuntimeSession(setSnapshot, workspaceId, {
        agentSessionId,
        status: "ready"
      });
    },
    async getComposerOptions(input) {
      if (getComposerOptions) {
        const result = await getComposerOptions(input);
        const options = composerOptionsFromRuntimeResult(
          input.provider ?? "codex",
          result
        );
        setSnapshot(input.workspaceId, (current) => ({
          ...current,
          composerOptionsByProvider: {
            ...(current.composerOptionsByProvider ?? {}),
            [options.provider]: options
          }
        }));
        return options;
      }
      return {};
    },
    async updateSessionSettings(input) {
      return updateSettings({
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        settings: input.settings
      });
    },
    ...(trackSettingsProjectChange
      ? {
          trackSettingsProjectChange: async (input) => {
            await trackSettingsProjectChange(input);
          }
        }
      : {}),
    async warmupOpenclawGateway(input) {
      return warmupOpenclawGateway(input);
    },
    async getSessionControlState(input) {
      return getState({
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId
      });
    },
    getSnapshot,
    async listSessionMessages(input) {
      return loadSessionMessages(input);
    },
    async load(workspaceId) {
      const snapshot = await list({
        workspaceId,
        sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
        userId: "user-1"
      });
      const next = agentActivitySnapshotFromHostSnapshot(snapshot, workspaceId);
      const merged = setSnapshot(workspaceId, (current) => ({
        ...next,
        composerOptionsByProvider:
          current.composerOptionsByProvider ??
          next.composerOptionsByProvider ??
          {},
        sessionMessagesById: {
          ...next.sessionMessagesById,
          ...current.sessionMessagesById
        }
      }));
      return cloneAgentActivitySnapshot(merged);
    },
    ensureSessionSynchronized: synchronizeSession,
    retainSessionEvents: synchronizeSession,
    async sendInput(input) {
      const result = await exec({
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        content: input.content
      });
      const status =
        typeof result?.sessionStatus === "string"
          ? result.sessionStatus
          : "working";
      const session = upsertRuntimeSession(setSnapshot, input.workspaceId, {
        agentSessionId: input.agentSessionId,
        status
      });
      const turnId =
        typeof result?.turnId === "string" ? result.turnId : "turn-1";
      return {
        session,
        turnId,
        turnLifecycle: { activeTurnId: turnId, phase: "submitted" },
        submitAvailability: { state: "blocked", reason: "active_turn" }
      };
    },
    async setSessionPinned(input) {
      await setSessionPinned({
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        pinned: input.pinned
      });
      const pinnedAtUnixMs = input.pinned ? Date.now() : null;
      return upsertRuntimeSession(setSnapshot, input.workspaceId, {
        agentSessionId: input.agentSessionId,
        pinnedAtUnixMs,
        status: "ready"
      });
    },
    async unactivateSession(input) {
      return unactivate({
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId
      });
    },
    async submitInteractive(input) {
      return submitInteractive({
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        requestId: input.requestId,
        ...(input.action ? { action: input.action } : {}),
        ...(input.optionId ? { optionId: input.optionId } : {}),
        ...(input.payload ? { payload: input.payload } : {})
      });
    },
    subscribeSessionEvents(workspaceId, listener) {
      const listeners =
        sessionEventListenersByWorkspaceId.get(workspaceId) ?? new Set();
      listeners.add(
        listener as (event: AgentHostAgentActivityStreamEvent) => void
      );
      sessionEventListenersByWorkspaceId.set(workspaceId, listeners);
      return () => {
        listeners.delete(
          listener as (event: AgentHostAgentActivityStreamEvent) => void
        );
      };
    },
    subscribe(workspaceId, listener) {
      const listeners = listenersByWorkspaceId.get(workspaceId) ?? new Set();
      listeners.add(listener);
      listenersByWorkspaceId.set(workspaceId, listeners);
      return () => {
        listeners.delete(listener);
      };
    }
  };

  Object.defineProperty(window, "agentActivityRuntime", {
    configurable: true,
    value: runtime
  });
  if (autoLoadRuntime) {
    void loadAgentActivityRuntimeForTests();
  }

  const emitRuntimeSessionEvent = (
    event: AgentHostAgentActivityStreamEvent
  ): void => {
    const emitForWorkspace = (workspaceId: string): void => {
      applyRuntimeStreamEvent({
        event,
        setSnapshot,
        workspaceId
      });
      for (const listener of sessionEventListenersByWorkspaceId.get(
        workspaceId
      ) ?? []) {
        listener(event);
      }
    };
    const workspaceId =
      typeof event.data.workspaceId === "string"
        ? event.data.workspaceId.trim()
        : "";
    if (workspaceId) {
      emitForWorkspace(workspaceId);
      return;
    }
    for (const targetWorkspaceId of sessionEventListenersByWorkspaceId.keys()) {
      emitForWorkspace(targetWorkspaceId);
    }
  };
  const previousEmitSessionEvent = emitSessionEvent;
  emitSessionEvent = (event: AgentHostAgentActivityStreamEvent) => {
    previousEmitSessionEvent(event);
    emitRuntimeSessionEvent(event);
  };
  emitRuntimeSessionEventForTests = emitRuntimeSessionEvent;
}

async function loadAgentActivityRuntimeForTests(
  workspaceId = "room-1"
): Promise<void> {
  await (
    window as { agentActivityRuntime?: AgentActivityRuntime }
  ).agentActivityRuntime?.load(workspaceId);
}

async function loadAgentActivitySessionMessagesForTests(
  agentSessionId: string,
  workspaceId = "room-1"
): Promise<void> {
  await (
    window as { agentActivityRuntime?: AgentActivityRuntime }
  ).agentActivityRuntime?.listSessionMessages({
    workspaceId,
    agentSessionId
  });
}

function installNoopAgentActivityRuntimeForTests(): void {
  const snapshotsByWorkspaceId = new Map<string, AgentActivitySnapshot>();
  const getSnapshot = (workspaceId: string): AgentActivitySnapshot => {
    const existing = snapshotsByWorkspaceId.get(workspaceId);
    if (existing) {
      return existing;
    }
    const next = emptyAgentActivitySnapshot(workspaceId);
    snapshotsByWorkspaceId.set(workspaceId, next);
    return next;
  };
  Object.defineProperty(window, "agentActivityRuntime", {
    configurable: true,
    value: {
      activateSession: async (input) => ({
        session: agentSession(input.agentSessionId),
        activation: { mode: input.mode, status: "attached" as const }
      }),
      cancelSession: async (input) => ({
        canceled: true,
        reason: "active_turn_canceled",
        session: upsertRuntimeSession(
          (workspaceId, updater) => updater(getSnapshot(workspaceId)),
          input.workspaceId,
          { agentSessionId: input.agentSessionId, status: "canceled" }
        )
      }),
      createSession: async (input) =>
        upsertRuntimeSession(
          (workspaceId, updater) => updater(getSnapshot(workspaceId)),
          input.workspaceId,
          {
            agentSessionId: input.agentSessionId ?? createTestAgentSessionId(),
            provider: input.provider,
            status: "ready"
          }
        ),
      deleteSession: async () => ({ removed: true }),
      getSession: async (workspaceId, agentSessionId) =>
        upsertRuntimeSession(
          (targetWorkspaceId, updater) =>
            updater(getSnapshot(targetWorkspaceId)),
          workspaceId,
          { agentSessionId, status: "ready" }
        ),
      getComposerOptions: async () => ({}),
      updateSessionSettings: async (input) => ({
        agentSessionId: input.agentSessionId,
        settings: input.settings
      }),
      getSessionControlState: async (input) =>
        agentSessionState(input.agentSessionId, {
          workspaceId: input.workspaceId
        }),
      getSnapshot,
      listSessionMessages: async () => ({
        messages: [],
        latestVersion: 0,
        hasMore: false
      }),
      load: async (workspaceId) => getSnapshot(workspaceId),
      ensureSessionSynchronized: () => () => {},
      retainSessionEvents: () => () => {},
      sendInput: async (input) => {
        const session = upsertRuntimeSession(
          (workspaceId, updater) => updater(getSnapshot(workspaceId)),
          input.workspaceId,
          { agentSessionId: input.agentSessionId, status: "working" }
        );
        return {
          session,
          turnId: "turn-1",
          turnLifecycle: { activeTurnId: "turn-1", phase: "submitted" },
          submitAvailability: { state: "blocked", reason: "active_turn" }
        };
      },
      setSessionPinned: async (input) =>
        upsertRuntimeSession(
          (workspaceId, updater) => updater(getSnapshot(workspaceId)),
          input.workspaceId,
          {
            agentSessionId: input.agentSessionId,
            pinnedAtUnixMs: input.pinned ? Date.now() : null,
            status: "ready"
          }
        ),
      subscribeSessionEvents: () => () => {},
      unactivateSession: async (input) => ({
        agentSessionId: input.agentSessionId,
        buffered: true
      }),
      submitInteractive: async () => ({}),
      subscribe: () => () => {}
    } satisfies AgentActivityRuntime
  });
}

function emptyAgentActivitySnapshot(
  workspaceId: string
): AgentActivitySnapshot {
  return {
    workspaceId,
    presences: [],
    sessions: [],
    sessionMessagesById: {},
    composerOptionsByProvider: {}
  };
}

function createTestAgentSessionId(): string {
  return `test-session-${Math.random().toString(16).slice(2)}`;
}

function composerOptionsFromRuntimeResult(
  provider: string,
  value: unknown
): AgentActivityComposerOptions {
  const result = recordValue(value) ?? {};
  const runtimeContext = recordValue(result.runtimeContext) ?? {};
  const configOptions = Array.isArray(runtimeContext.configOptions)
    ? runtimeContext.configOptions
    : [];
  const models = Array.isArray(result.models)
    ? settingOptionsFromRuntimeOptions(result.models)
    : settingOptionsFromRuntimeConfig(
        recordValue(result.modelConfig),
        configOptions,
        ["model"]
      );
  const reasoningEfforts = Array.isArray(result.reasoningEfforts)
    ? settingOptionsFromRuntimeOptions(result.reasoningEfforts)
    : settingOptionsFromRuntimeConfig(
        recordValue(result.reasoningConfig),
        configOptions,
        ["reasoning_effort", "model_reasoning_effort", "effort"]
      );
  const modelConfig = recordValue(result.modelConfig) ?? {};
  const reasoningConfig = recordValue(result.reasoningConfig) ?? {};
  // Mirrors the production adapter mapping: configurable comes from the wire,
  // with a fixture convenience fallback to "has any options".
  const modelConfigurable =
    modelConfig.configurable === true ||
    (modelConfig.configurable === undefined && models.length > 0);
  const reasoningConfigurable =
    reasoningConfig.configurable === true ||
    (reasoningConfig.configurable === undefined && reasoningEfforts.length > 0);
  return {
    provider: normalizeConfigOptionValue(result.provider) ?? provider,
    models,
    reasoningEfforts,
    speeds: [],
    modelConfigurable,
    reasoningConfigurable,
    permissionConfig: permissionConfigFromRuntimeResult(
      result.permissionConfig
    ),
    runtimeContext,
    skills: [],
    loadedAtUnixMs: 1
  };
}

function settingOptionsFromRuntimeConfig(
  config: Record<string, unknown> | null,
  configOptions: unknown[],
  ids: string[]
): AgentActivityComposerOptions["models"] {
  const source =
    config && Object.keys(config).length > 0
      ? config
      : (configOptions.map(recordValue).find((option) => {
          const id = normalizeConfigOptionValue(option?.id);
          return id ? ids.includes(id) : false;
        }) ?? null);
  if (!source) {
    return [];
  }
  const options = settingOptionsFromRuntimeOptions(source.options);
  const currentValue = normalizeConfigOptionValue(
    source.currentValue ?? source.current_value ?? source.defaultValue
  );
  if (
    !currentValue ||
    options.some((option) => option.value === currentValue)
  ) {
    return options;
  }
  return [...options, { value: currentValue, label: currentValue }];
}

function settingOptionsFromRuntimeOptions(
  value: unknown
): AgentActivityComposerOptions["models"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(recordValue).flatMap((option) => {
    const optionValue = normalizeConfigOptionValue(option?.value ?? option?.id);
    if (!optionValue) {
      return [];
    }
    const label =
      normalizeConfigOptionValue(
        option?.label ?? option?.name ?? option?.displayName
      ) ?? optionValue;
    const description = normalizeConfigOptionValue(option?.description);
    return [
      {
        value: optionValue,
        label,
        ...(description ? { description } : {})
      }
    ];
  });
}

function permissionConfigFromRuntimeResult(
  value: unknown
): AgentActivityComposerOptions["permissionConfig"] {
  const config = recordValue(value);
  if (!config) {
    return null;
  }
  return {
    configurable: Boolean(config.configurable),
    defaultValue:
      normalizeConfigOptionValue(
        config.defaultValue ?? config.currentValue ?? config.current_value
      ) ?? null,
    modes: Array.isArray(config.modes)
      ? config.modes.map(recordValue).flatMap((mode) => {
          const id = normalizeConfigOptionValue(mode?.id);
          if (!id) {
            return [];
          }
          const label = normalizeConfigOptionValue(mode?.label);
          const description = normalizeConfigOptionValue(mode?.description);
          const semantic = normalizeConfigOptionValue(mode?.semantic);
          return [
            {
              id,
              ...(label ? { label } : {}),
              ...(description ? { description } : {}),
              ...(semantic ? { semantic } : {})
            }
          ];
        })
      : []
  };
}

function cloneAgentActivitySnapshot(
  snapshot: AgentActivitySnapshot
): AgentActivitySnapshot {
  return {
    workspaceId: snapshot.workspaceId,
    presences: snapshot.presences.map((presence) => ({ ...presence })),
    sessions: snapshot.sessions.map((session) => ({ ...session })),
    composerOptionsByProvider: Object.fromEntries(
      Object.entries(snapshot.composerOptionsByProvider ?? {}).map(
        ([provider, options]) => [
          provider,
          {
            ...options,
            models: options.models.map((option) => ({ ...option })),
            reasoningEfforts: options.reasoningEfforts.map((option) => ({
              ...option
            })),
            permissionConfig: options.permissionConfig
              ? {
                  configurable: options.permissionConfig.configurable,
                  defaultValue: options.permissionConfig.defaultValue ?? null,
                  modes: options.permissionConfig.modes.map((mode) => ({
                    ...mode
                  }))
                }
              : (options.permissionConfig ?? null),
            runtimeContext: options.runtimeContext
              ? { ...options.runtimeContext }
              : options.runtimeContext,
            skills: options.skills.map((skill) => ({ ...skill }))
          }
        ]
      )
    ),
    sessionMessagesById: Object.fromEntries(
      Object.entries(snapshot.sessionMessagesById).map(
        ([agentSessionId, messages]) => [
          agentSessionId,
          messages.map((message) => ({
            ...message,
            payload: { ...message.payload }
          }))
        ]
      )
    )
  };
}

function agentActivitySnapshotFromHostSnapshot(
  snapshot: AgentHostWorkspaceAgentSnapshot,
  workspaceId: string
): AgentActivitySnapshot {
  const sessionMessagesById: Record<string, AgentActivityMessage[]> = {};
  for (const [agentSessionId, messages] of Object.entries(
    snapshot.sessionMessagesById ?? {}
  )) {
    const nextMessages = messages.map((message) =>
      agentActivityMessageFromHostMessage(message, { workspaceId })
    );
    if (nextMessages.length > 0) {
      sessionMessagesById[agentSessionId] = nextMessages;
    }
  }
  return {
    workspaceId,
    presences: (snapshot.presences ?? []).map((presence, index) => ({
      id: presence.id ?? index + 1,
      workspaceId,
      provider: presence.provider,
      status: presence.status,
      userId: presence.userId ?? null
    })),
    sessions: snapshot.sessions.map((session) =>
      agentActivitySessionFromWorkspaceAgentSession(session, workspaceId)
    ),
    sessionMessagesById,
    composerOptionsByProvider:
      (
        snapshot as {
          composerOptionsByProvider?: AgentActivitySnapshot["composerOptionsByProvider"];
        }
      ).composerOptionsByProvider ?? {}
  };
}

function agentActivitySessionFromWorkspaceAgentSession(
  session: AgentHostWorkspaceAgentSession,
  workspaceId: string
): AgentActivitySession {
  return {
    workspaceId,
    agentSessionId: session.agentSessionId,
    provider: session.provider,
    providerSessionId: session.providerSessionId ?? null,
    cwd: session.cwd ?? "/workspace",
    title: session.title ?? session.provider,
    status:
      session.effectiveStatus ??
      session.status ??
      statusFromLifecyclePatch({
        lifecycleStatus: session.lifecycleStatus,
        currentPhase: session.turnPhase
      }),
    sessionOrigin: session.sessionOrigin ?? AGENT_GUI_RUNTIME_SESSION_ORIGIN,
    currentPhase: session.turnPhase ?? null,
    pinnedAtUnixMs: session.pinnedAtUnixMs ?? null,
    resumable: session.resumable,
    createdAtUnixMs: session.createdAtUnixMs,
    updatedAtUnixMs: session.updatedAtUnixMs,
    ...("syncState" in session && session.syncState
      ? { syncState: session.syncState }
      : {})
  } as AgentActivitySession;
}

function agentActivitySessionFromHostSession(
  session: AgentHostAgentSession,
  workspaceId: string
): AgentActivitySession {
  return {
    workspaceId,
    agentSessionId: session.agentSessionId,
    provider: session.provider,
    providerSessionId: session.providerSessionId ?? null,
    cwd: session.cwd ?? "/workspace",
    title: session.title ?? session.provider,
    status: session.status ?? "ready",
    sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
    pinnedAtUnixMs: session.pinnedAtUnixMs ?? null,
    createdAtUnixMs: session.createdAtUnixMs,
    updatedAtUnixMs: session.updatedAtUnixMs
  } as AgentActivitySession;
}

function agentActivityMessageFromHostMessage(
  message: AgentHostWorkspaceAgentMessage,
  input: { workspaceId: string }
): AgentActivityMessage {
  return {
    workspaceId: message.workspaceId ?? input.workspaceId,
    agentSessionId: message.agentSessionId,
    messageId: message.messageId,
    id: message.id,
    version: message.version,
    turnId: message.turnId?.trim() || `message:${message.messageId}`,
    role: message.role,
    kind: message.kind,
    status: message.status ?? null,
    payload: { ...message.payload },
    occurredAtUnixMs:
      message.occurredAtUnixMs ??
      message.startedAtUnixMs ??
      message.completedAtUnixMs ??
      message.version,
    startedAtUnixMs: message.startedAtUnixMs,
    completedAtUnixMs: message.completedAtUnixMs
  };
}

function mergeMessagesInSnapshot(
  snapshot: AgentActivitySnapshot,
  agentSessionId: string,
  messages: readonly AgentActivityMessage[]
): AgentActivitySnapshot {
  if (messages.length === 0) {
    return snapshot;
  }
  const current = snapshot.sessionMessagesById[agentSessionId] ?? [];
  const byKey = new Map<string, AgentActivityMessage>();
  for (const message of [...current, ...messages]) {
    byKey.set(
      `${message.agentSessionId}:${message.messageId}:${message.version}`,
      message
    );
  }
  return {
    ...snapshot,
    sessionMessagesById: {
      ...snapshot.sessionMessagesById,
      [agentSessionId]: [...byKey.values()].sort(
        (left, right) =>
          (left.occurredAtUnixMs ?? left.version) -
            (right.occurredAtUnixMs ?? right.version) ||
          left.messageId.localeCompare(right.messageId)
      )
    }
  };
}

function upsertRuntimeSession(
  setSnapshot: (
    workspaceId: string,
    updater: (current: AgentActivitySnapshot) => AgentActivitySnapshot
  ) => AgentActivitySnapshot,
  workspaceId: string,
  input: Partial<AgentActivitySession> & { agentSessionId: string }
): AgentActivitySession {
  let nextSession: AgentActivitySession | null = null;
  setSnapshot(workspaceId, (current) => {
    const existing = current.sessions.find(
      (session) => session.agentSessionId === input.agentSessionId
    );
    nextSession = {
      workspaceId,
      agentSessionId: input.agentSessionId,
      provider: input.provider ?? existing?.provider ?? "codex",
      providerSessionId:
        input.providerSessionId ?? existing?.providerSessionId ?? null,
      cwd: input.cwd ?? existing?.cwd ?? "/workspace",
      title: input.title ?? existing?.title ?? "Codex",
      status: input.status ?? existing?.status ?? "ready",
      sessionOrigin:
        (input as { sessionOrigin?: string }).sessionOrigin ??
        (existing as { sessionOrigin?: string } | undefined)?.sessionOrigin ??
        AGENT_GUI_RUNTIME_SESSION_ORIGIN,
      currentPhase: input.currentPhase ?? existing?.currentPhase ?? null,
      pinnedAtUnixMs:
        input.pinnedAtUnixMs !== undefined
          ? input.pinnedAtUnixMs
          : (existing?.pinnedAtUnixMs ?? null),
      createdAtUnixMs: input.createdAtUnixMs ?? existing?.createdAtUnixMs ?? 1,
      updatedAtUnixMs: input.updatedAtUnixMs ?? Date.now()
    } as AgentActivitySession;
    return upsertSessionInSnapshot(current, nextSession);
  });
  return nextSession!;
}

function upsertSessionInSnapshot(
  snapshot: AgentActivitySnapshot,
  session: AgentActivitySession
): AgentActivitySnapshot {
  const index = snapshot.sessions.findIndex(
    (candidate) => candidate.agentSessionId === session.agentSessionId
  );
  if (index < 0) {
    return { ...snapshot, sessions: [session, ...snapshot.sessions] };
  }
  const sessions = [...snapshot.sessions];
  sessions[index] = { ...sessions[index], ...session };
  return { ...snapshot, sessions };
}

function applyRuntimeStreamEvent({
  event,
  setSnapshot,
  workspaceId
}: {
  event: AgentHostAgentActivityStreamEvent;
  setSnapshot: (
    workspaceId: string,
    updater: (current: AgentActivitySnapshot) => AgentActivitySnapshot
  ) => AgentActivitySnapshot;
  workspaceId: string;
}): void {
  if (event.eventType === "message_update") {
    const message = agentActivityMessageFromStreamEvent(event, workspaceId);
    if (message) {
      setSnapshot(workspaceId, (current) =>
        mergeMessagesInSnapshot(current, message.agentSessionId, [message])
      );
    }
    return;
  }
  if (event.eventType === "state_patch") {
    const data = recordValue(event.data) ?? {};
    const agentSessionId = normalizeConfigOptionValue(data.agentSessionId);
    if (!agentSessionId) {
      return;
    }
    upsertRuntimeSession(setSnapshot, workspaceId, {
      agentSessionId,
      provider: normalizeConfigOptionValue(data.provider) ?? undefined,
      providerSessionId:
        normalizeConfigOptionValue(data.providerSessionId) ?? undefined,
      cwd: normalizeConfigOptionValue(data.cwd) ?? undefined,
      title: normalizeConfigOptionValue(data.title) ?? undefined,
      status: statusFromLifecyclePatch({
        lifecycleStatus: normalizeConfigOptionValue(data.lifecycleStatus),
        currentPhase: normalizeConfigOptionValue(data.currentPhase)
      }),
      currentPhase: normalizeConfigOptionValue(data.currentPhase) ?? undefined,
      updatedAtUnixMs:
        typeof data.occurredAtUnixMs === "number"
          ? data.occurredAtUnixMs
          : Date.now()
    });
    return;
  }
}

function agentActivityMessageFromStreamEvent(
  event: AgentHostAgentActivityStreamEvent,
  workspaceId: string
): AgentActivityMessage | null {
  const data = recordValue(event.data) ?? {};
  const agentSessionId = normalizeConfigOptionValue(data.agentSessionId);
  const messageId = normalizeConfigOptionValue(data.messageId);
  const role = normalizeConfigOptionValue(data.role);
  const kind = normalizeConfigOptionValue(data.kind);
  if (!agentSessionId || !messageId || !role || !kind) {
    return null;
  }
  const version =
    typeof data.seq === "number"
      ? data.seq
      : typeof data.version === "number"
        ? data.version
        : 0;
  return {
    workspaceId,
    agentSessionId,
    messageId,
    id: typeof data.id === "number" ? data.id : undefined,
    version,
    turnId: normalizeConfigOptionValue(data.turnId) ?? `message:${messageId}`,
    role,
    kind: kind === "message" ? "text" : kind,
    status: normalizeConfigOptionValue(data.status),
    payload: {
      ...(recordValue(data.payload) ?? {}),
      ...(normalizeConfigOptionValue(data.callId)
        ? { callId: normalizeConfigOptionValue(data.callId) }
        : {}),
      ...(normalizeConfigOptionValue(data.title)
        ? { title: normalizeConfigOptionValue(data.title) }
        : {})
    },
    occurredAtUnixMs:
      typeof data.occurredAtUnixMs === "number"
        ? data.occurredAtUnixMs
        : typeof data.startedAtUnixMs === "number"
          ? data.startedAtUnixMs
          : version,
    startedAtUnixMs:
      typeof data.startedAtUnixMs === "number"
        ? data.startedAtUnixMs
        : undefined
  };
}

function statusFromLifecyclePatch(input: {
  lifecycleStatus?: string | null;
  currentPhase?: string | null;
}): string {
  const lifecycleStatus = input.lifecycleStatus?.trim() ?? "";
  if (
    lifecycleStatus === "failed" ||
    lifecycleStatus === "canceled" ||
    lifecycleStatus === "completed"
  ) {
    return lifecycleStatus;
  }
  const phase = input.currentPhase?.trim() ?? "";
  if (phase.includes("wait") || phase.includes("approval")) {
    return "waiting";
  }
  if (phase.includes("work") || phase.includes("run")) {
    return "working";
  }
  if (phase === "failed" || phase === "canceled" || phase === "completed") {
    return phase;
  }
  return "ready";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeConfigOptionValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timelineItemToMessage(
  item: AgentHostWorkspaceAgentTimelineItem
): AgentHostWorkspaceAgentMessage {
  const payload = {
    ...(item.payload ?? {}),
    ...(item.content ? { content: item.content } : {}),
    ...(item.callId ? { callId: item.callId } : {}),
    ...(item.name ? { title: item.name } : {}),
    ...(item.callType ? { callType: item.callType } : {})
  };
  const itemType = item.itemType?.trim().toLowerCase() ?? "";
  const role =
    item.role?.trim().toLowerCase() === "user" ? "user" : "assistant";
  const kind =
    item.callId || itemType.startsWith("call.")
      ? "tool_call"
      : itemType === "message.assistant_thinking" ||
          item.role === "assistant_thinking"
        ? "reasoning"
        : "text";
  return {
    id: item.id,
    agentSessionId: item.agentSessionId,
    messageId: item.eventId || `message:${item.id}`,
    version: item.seq ?? item.id,
    turnId: item.turnId ?? `timeline:${item.eventId || item.id}`,
    role,
    kind,
    status: item.status,
    payload,
    occurredAtUnixMs: item.occurredAtUnixMs ?? item.createdAtUnixMs ?? item.id,
    ...(item.createdAtUnixMs !== undefined
      ? { startedAtUnixMs: item.createdAtUnixMs }
      : {})
  };
}

function agentGuiData(
  lastActiveAgentSessionId: string | null,
  provider: AgentGUINodeData["provider"] = "codex",
  overrides: Partial<AgentGUINodeData> = {}
): AgentGUINodeData {
  return {
    provider,
    lastActiveAgentSessionId,
    ...overrides
  };
}

function snapshotWithSession(
  agentSessionId: string,
  overrides: Partial<AgentHostWorkspaceAgentSession> = {}
): AgentHostWorkspaceAgentSnapshot {
  return {
    presences: [],
    sessions: [workspaceAgentSession(agentSessionId, overrides)]
  };
}

function snapshotWithWaitingSession(
  agentSessionId: string
): AgentHostWorkspaceAgentSnapshot {
  return snapshotWithSession(agentSessionId, {
    effectiveStatus: "waiting",
    turnPhase: "waiting"
  });
}

function workspaceAgentSession(
  agentSessionId: string,
  overrides: Partial<AgentHostWorkspaceAgentSession> = {}
): AgentHostWorkspaceAgentSession {
  return {
    id: 1,
    agentSessionId,
    presenceId: 1,
    userId: "user-1",
    provider: "codex",
    providerSessionId: "provider-session-1",
    sessionOrigin: AGENT_GUI_RUNTIME_SESSION_ORIGIN,
    title: "Codex",
    cwd: "/workspace",
    lifecycleStatus: "active",
    turnPhase: "idle",
    effectiveStatus: "ready",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2,
    ...overrides
  } as AgentHostWorkspaceAgentSession;
}

function timelineMessage({
  agentSessionId,
  id,
  eventId,
  role,
  content,
  turnId,
  occurredAtUnixMs
}: {
  agentSessionId: string;
  id: number;
  eventId: string;
  role: "user" | "assistant";
  content: string;
  turnId?: string;
  occurredAtUnixMs?: number;
}): AgentHostWorkspaceAgentTimelineItem {
  const messageTimeUnixMs = occurredAtUnixMs ?? id;
  return {
    id,
    workspaceId: "room-1",
    agentSessionId,
    turnId,
    eventId,
    actorType: role === "user" ? "user" : "agent",
    actorId: role === "user" ? "user-1" : "codex",
    itemType: "message",
    role,
    content,
    occurredAtUnixMs: messageTimeUnixMs,
    createdAtUnixMs: messageTimeUnixMs
  };
}

function timelineToolCall({
  agentSessionId,
  callId,
  name,
  status,
  occurredAtUnixMs
}: {
  agentSessionId: string;
  callId: string;
  name: string;
  status: string;
  occurredAtUnixMs: number;
}): AgentHostWorkspaceAgentTimelineItem {
  return {
    id: 0,
    workspaceId: "room-1",
    agentSessionId,
    turnId: "turn-1",
    seq: 0,
    eventId: `${callId}:started`,
    actorType: "agent",
    actorId: "codex",
    itemType: "call.started",
    role: "assistant",
    callType: "tool",
    callId,
    name,
    status,
    payload: {
      status,
      toolName: name
    },
    occurredAtUnixMs,
    createdAtUnixMs: occurredAtUnixMs
  };
}

function streamMessage(
  input: Parameters<typeof timelineMessage>[0]
): AgentHostAgentActivityStreamEvent {
  const item = timelineMessage(input);
  return {
    eventType: "message_update",
    data: {
      agentSessionId: item.agentSessionId,
      messageId: item.eventId,
      seq: item.seq ?? item.id,
      turnId: item.turnId ?? `turn:${item.eventId}`,
      role: item.role ?? "assistant",
      kind: "message",
      payload: {
        content: item.content,
        text: item.content
      },
      occurredAtUnixMs:
        item.occurredAtUnixMs ?? item.createdAtUnixMs ?? item.id,
      startedAtUnixMs: item.createdAtUnixMs
    }
  };
}

function streamToolCall(
  input: Parameters<typeof timelineToolCall>[0]
): AgentHostAgentActivityStreamEvent {
  const item = timelineToolCall(input);
  return {
    eventType: "message_update",
    data: {
      agentSessionId: item.agentSessionId,
      messageId: item.eventId,
      seq: item.seq ?? item.id,
      turnId: item.turnId ?? `turn:${item.eventId}`,
      role: item.role ?? "assistant",
      kind: "tool_call",
      status: item.status,
      callId: item.callId,
      title: item.name,
      payload: {
        name: item.name,
        callType: item.callType,
        status: item.status
      },
      occurredAtUnixMs:
        item.occurredAtUnixMs ?? item.createdAtUnixMs ?? item.id,
      startedAtUnixMs: item.createdAtUnixMs
    }
  };
}

function agentSession(
  agentSessionId: string,
  overrides: Partial<AgentHostAgentSession> = {}
): AgentHostAgentSession {
  return {
    workspaceId: "room-1",

    agentSessionId,
    provider: "codex",
    providerSessionId: "provider-session-1",
    cwd: "/workspace",
    status: "ready",
    title: "Codex",
    permissionModeId: "auto",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 3,
    ...overrides
  };
}

function agentSessionState(
  agentSessionId: string,
  overrides: Partial<AgentHostAgentSessionState> = {}
): AgentHostAgentSessionState {
  return {
    workspaceId: "room-1",

    agentSessionId,
    provider: "codex",
    providerSessionId: "provider-session-1",
    status: "ready",
    permissionModeId: "auto",
    runtimeContext: {
      cwd: "/workspace",
      permissionModeId: "preset"
    },
    pendingInteractive: null,
    updatedAtUnixMs: 3,
    ...overrides
  };
}
