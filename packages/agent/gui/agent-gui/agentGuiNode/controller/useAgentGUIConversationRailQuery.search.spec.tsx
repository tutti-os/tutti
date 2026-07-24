import {
  normalizeAgentActivitySession,
  type AgentActivityTurn
} from "@tutti-os/agent-activity-core";
import { TooltipProvider } from "@tutti-os/ui-system";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from "@testing-library/react";
import { Profiler, useLayoutEffect, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentActivityRuntimeProvider,
  type AgentActivityRuntime,
  type AgentActivityRuntimeListSessionsPageInput
} from "../../../agentActivityRuntime";
import type { AgentHostUserProjectsApi } from "../../../host/agentHostApi";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import type { AgentGUINodeData } from "../../../types";
import { useAgentGUIConversationRailQuery } from "./useAgentGUIConversationRailQuery";
import { useAgentGUILocalState } from "./useAgentGUILocalState";
import {
  projectDragAutoScrollDelta,
  useAgentGUIProjectDrag
} from "./useAgentGUIProjectDrag";
import { AgentGUIConversationRailPane } from "../view/AgentGUIConversationRailPane";
import type { AgentGUIViewLabels } from "../view/AgentGUINodeView.types";
import { createDefaultWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";

describe("useAgentGUIConversationRailQuery search", () => {
  it("fails batch deletion closed and reports a partial runtime contract", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    const reportDiagnostic = vi.fn();
    const runtime = {
      deleteSessionsBatch: vi.fn(),
      getSessionEngine: () => engine,
      reportDiagnostic
    } as unknown as AgentActivityRuntime;
    const wrapper = ({ children }: PropsWithChildren) => (
      <AgentActivityRuntimeProvider runtime={runtime}>
        {children}
      </AgentActivityRuntimeProvider>
    );

    const { result } = renderHook(
      () =>
        useAgentGUIConversationRailQuery({
          activeConversationId: null,
          conversationFilter: { kind: "all" },
          conversationQuery: "",
          sectionAgentTargetFallbackId: null,
          userProjects: [],
          workspaceId: "workspace-1"
        }),
      { wrapper }
    );

    expect(result.current.batchDeletionAvailable).toBe(false);
    await waitFor(() =>
      expect(reportDiagnostic).toHaveBeenCalledWith({
        details: {
          missingMethods: ["listSessionSectionDeletionCandidates"]
        },
        event: "agent.gui.conversation_batch_delete.capability_incomplete",
        level: "warn",
        source: "agent-gui",
        workspaceId: "workspace-1"
      })
    );
  });

  it("commits the latest dragover target even before React renders it", async () => {
    const projects = ["Alpha", "Beta", "Gamma"].map((label) => ({
      id: label.toLowerCase(),
      label,
      path: `/workspace/${label.toLowerCase()}`,
      pinnedAtUnixMs: 0,
      sectionKey: `project:/workspace/${label.toLowerCase()}`
    }));
    const moveProject = vi.fn(() => Promise.resolve());
    const header = document.createElement("div");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.dataset.projectDragIcon = "true";
    header.append(icon);
    document.body.append(header);
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      setData() {},
      setDragImage() {}
    };
    const event = {
      clientY: 0,
      currentTarget: header,
      dataTransfer,
      preventDefault: vi.fn(),
      target: header
    } as unknown as React.DragEvent<HTMLElement>;
    const alphaSection = {
      id: projects[0]?.sectionKey ?? "",
      items: [],
      kind: "project" as const,
      label: "Alpha",
      project: projects[0] ?? null
    };
    const gammaSection = {
      id: projects[2]?.sectionKey ?? "",
      items: [],
      kind: "project" as const,
      label: "Gamma",
      project: projects[2] ?? null
    };
    const { result } = renderHook(() =>
      useAgentGUIProjectDrag({
        disabled: false,
        onMoveProject: moveProject,
        scrollViewportRef: { current: null },
        userProjects: projects
      })
    );

    act(() => result.current.start(alphaSection, event));
    const updateTargetBeforeRender = result.current.updateTarget;
    const dropBeforeRender = result.current.drop;
    await act(async () => {
      updateTargetBeforeRender(gammaSection, "after", event);
      await dropBeforeRender(event);
    });

    expect(moveProject).toHaveBeenCalledWith("alpha", null);

    act(() => result.current.start(gammaSection, event));
    const updateTopTargetBeforeRender = result.current.updateTarget;
    const dropAtTopBeforeRender = result.current.drop;
    await act(async () => {
      updateTopTargetBeforeRender(alphaSection, "before", event);
      await dropAtTopBeforeRender(event);
    });

    expect(moveProject).toHaveBeenNthCalledWith(2, "gamma", "alpha");
    header.remove();
  });

  it("rejects cross-partition drops and resolves the end of the pinned partition as null", async () => {
    const projects = [
      {
        id: "alpha",
        label: "Alpha",
        path: "/alpha",
        pinnedAtUnixMs: 20,
        sectionKey: "project:/alpha"
      },
      {
        id: "beta",
        label: "Beta",
        path: "/beta",
        pinnedAtUnixMs: 10,
        sectionKey: "project:/beta"
      },
      {
        id: "gamma",
        label: "Gamma",
        path: "/gamma",
        pinnedAtUnixMs: 0,
        sectionKey: "project:/gamma"
      }
    ];
    const moveProject = vi.fn(() => Promise.resolve());
    const header = document.createElement("div");
    const folderIcon = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg"
    );
    folderIcon.dataset.projectDragIcon = "true";
    header.append(folderIcon);
    document.body.append(header);
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      setData() {},
      setDragImage: vi.fn()
    };
    const event = {
      clientY: 0,
      currentTarget: header,
      dataTransfer,
      preventDefault: vi.fn(),
      target: header
    } as unknown as React.DragEvent<HTMLElement>;
    const sectionFor = (index: number) => ({
      id: projects[index]?.sectionKey ?? "",
      items: [],
      kind: "project" as const,
      label: projects[index]?.label ?? "",
      project: projects[index] ?? null
    });
    const { result } = renderHook(() =>
      useAgentGUIProjectDrag({
        disabled: false,
        onMoveProject: moveProject,
        scrollViewportRef: { current: null },
        userProjects: projects
      })
    );

    act(() => result.current.start(sectionFor(0), event));
    const dragImage = dataTransfer.setDragImage.mock
      .calls[0]?.[0] as HTMLElement;
    expect(dragImage.querySelectorAll("svg")).toHaveLength(1);
    act(() => result.current.updateTarget(sectionFor(2), "before", event));
    expect(dataTransfer.dropEffect).toBe("none");
    expect(result.current.dragState?.indicator).toBeNull();
    await act(async () => result.current.drop(event));
    expect(moveProject).not.toHaveBeenCalled();

    act(() => result.current.start(sectionFor(0), event));
    act(() => result.current.updateTarget(sectionFor(1), "after", event));
    await act(async () => result.current.drop(event));
    expect(moveProject).toHaveBeenCalledWith("alpha", null);
    header.remove();
  });

  it("marks a newly rendered target unresolved before its controller effect settles", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    const sectionResolvers: Array<() => void> = [];
    const runtime = {
      getSessionEngine: () => engine,
      listSessionSections: vi.fn(
        (input: { workspaceId: string }) =>
          new Promise<{ sections: []; workspaceId: string }>((resolve) => {
            sectionResolvers.push(() =>
              resolve({ sections: [], workspaceId: input.workspaceId })
            );
          })
      ),
      listSessionSectionPage: vi.fn()
    } as unknown as AgentActivityRuntime;
    const wrapper = ({ children }: PropsWithChildren) => (
      <AgentActivityRuntimeProvider runtime={runtime}>
        {children}
      </AgentActivityRuntimeProvider>
    );
    const layoutObservations: Array<{
      agentTargetId: string;
      scopeResolved: boolean;
    }> = [];
    function ScopeResolutionProbe({
      agentTargetId
    }: {
      agentTargetId: string;
    }): null {
      const query = useAgentGUIConversationRailQuery({
        activeConversationId: null,
        conversationFilter: { agentTargetId, kind: "agentTarget" },
        conversationQuery: "",
        sectionAgentTargetFallbackId: null,
        userProjects: [],
        workspaceId: "workspace-1"
      });
      useLayoutEffect(() => {
        layoutObservations.push({
          agentTargetId,
          scopeResolved: query.runtimeRailScopeResolved
        });
      }, [agentTargetId, query.runtimeRailScopeResolved]);
      return null;
    }
    const view = render(<ScopeResolutionProbe agentTargetId="local:codex" />, {
      wrapper
    });

    await waitFor(() => expect(sectionResolvers).toHaveLength(1));
    await act(async () => sectionResolvers.shift()?.());
    await waitFor(() =>
      expect(layoutObservations).toContainEqual({
        agentTargetId: "local:codex",
        scopeResolved: true
      })
    );

    const observationCountBeforeSwitch = layoutObservations.length;
    view.rerender(<ScopeResolutionProbe agentTargetId="local:claude-code" />);

    expect(layoutObservations[observationCountBeforeSwitch]).toEqual({
      agentTargetId: "local:claude-code",
      scopeResolved: false
    });
    view.unmount();
    engine.dispose();
  });

  it("searches every backend page and stores returned entities in the workspace engine", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    const calls: AgentActivityRuntimeListSessionsPageInput[] = [];
    const firstSession = searchSession("session-1", "backend first result", 2);
    const secondSession = searchSession("session-2", "backend older result", 1);
    const runtime = {
      getSessionEngine: () => engine,
      async listSessionsPage(input: AgentActivityRuntimeListSessionsPageInput) {
        calls.push(input);
        return input.cursor
          ? {
              hasMore: false,
              sessions: [secondSession],
              workspaceId: input.workspaceId
            }
          : {
              hasMore: true,
              nextCursor: "2|session-1",
              sessions: [firstSession],
              workspaceId: input.workspaceId
            };
      }
    } as unknown as AgentActivityRuntime;
    const wrapper = ({ children }: PropsWithChildren) => (
      <AgentActivityRuntimeProvider runtime={runtime}>
        {children}
      </AgentActivityRuntimeProvider>
    );

    const { result } = renderHook(
      () =>
        useAgentGUIConversationRailQuery({
          activeConversationId: null,
          conversationFilter: {
            agentTargetId: " target-1 ",
            kind: "agentTarget"
          },
          conversationQuery: " backend ",
          sectionAgentTargetFallbackId: null,
          userProjects: [],
          workspaceId: "workspace-1"
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(calls).toHaveLength(1);
      expect(result.current.railSearch.sessionIds).toEqual(["session-1"]);
    });

    expect(calls[0]).toMatchObject({
      agentTargetId: "target-1",
      limit: 100,
      searchQuery: "backend",
      workspaceId: "workspace-1"
    });
    expect(result.current.railSearch.hasMore).toBe(true);
    expect(
      engine.getSnapshot().sessionLifecycle.sessionsById["session-1"]?.title
    ).toBe("backend first result");
    const loadMoreSectionConversations =
      result.current.loadMoreSectionConversations;
    const loadMoreSearchResults = result.current.railSearch.loadMore;
    const retrySearchResults = result.current.railSearch.retry;

    await act(async () => {
      result.current.railSearch.loadMore();
      await Promise.resolve();
    });

    expect(calls[1]).toMatchObject({
      cursor: "2|session-1",
      searchQuery: "backend",
      workspaceId: "workspace-1"
    });
    expect(result.current.railSearch.sessionIds).toEqual([
      "session-1",
      "session-2"
    ]);
    expect(result.current.railSearch.hasMore).toBe(false);
    expect(result.current.loadMoreSectionConversations).toBe(
      loadMoreSectionConversations
    );
    expect(result.current.railSearch.loadMore).toBe(loadMoreSearchResults);
    expect(result.current.railSearch.retry).toBe(retrySearchResults);
    expect(
      engine.getSnapshot().sessionLifecycle.sessionsById["session-2"]?.title
    ).toBe("backend older result");
  });

  it("exposes retry after an initial backend search failure", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    let requestCount = 0;
    const runtime = {
      getSessionEngine: () => engine,
      async listSessionsPage(input: AgentActivityRuntimeListSessionsPageInput) {
        requestCount += 1;
        if (requestCount === 1) throw new Error("search unavailable");
        return {
          hasMore: false,
          sessions: [searchSession("session-retried", "retried result", 1)],
          workspaceId: input.workspaceId
        };
      }
    } as unknown as AgentActivityRuntime;
    const wrapper = ({ children }: PropsWithChildren) => (
      <AgentActivityRuntimeProvider runtime={runtime}>
        {children}
      </AgentActivityRuntimeProvider>
    );
    const { result } = renderHook(
      () =>
        useAgentGUIConversationRailQuery({
          activeConversationId: null,
          conversationFilter: { kind: "all" },
          conversationQuery: "backend",
          sectionAgentTargetFallbackId: null,
          userProjects: [],
          workspaceId: "workspace-1"
        }),
      { wrapper }
    );

    await waitFor(() => expect(result.current.railSearch.failed).toBe(true));
    act(() => result.current.railSearch.retry());
    await waitFor(() =>
      expect(result.current.railSearch.sessionIds).toEqual(["session-retried"])
    );
    expect(result.current.railSearch.failed).toBe(false);
  });

  it("keeps the rail query idle when a streaming turn update does not change rail presentation", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    engine.dispatch({
      type: "session/upserted",
      session: normalizeAgentActivitySession({
        activeTurnId: "turn-1",
        agentSessionId: "session-1",
        agentTargetId: "target-1",
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        railSectionKey: "conversations",
        title: "streaming session",
        updatedAtUnixMs: 1,
        workspaceId: "workspace-1"
      })
    });
    engine.dispatch({ type: "turn/upserted", turn: runningTurn(1) });
    const runtime = {
      getSessionEngine: () => engine
    } as unknown as AgentActivityRuntime;
    const wrapper = ({ children }: PropsWithChildren) => (
      <AgentActivityRuntimeProvider runtime={runtime}>
        {children}
      </AgentActivityRuntimeProvider>
    );
    let renderCount = 0;
    const { result } = renderHook(
      () => {
        renderCount += 1;
        return useAgentGUIConversationRailQuery({
          activeConversationId: "session-1",
          conversationFilter: { kind: "all" },
          conversationQuery: "",
          sectionAgentTargetFallbackId: null,
          userProjects: [],
          workspaceId: "workspace-1"
        });
      },
      { wrapper }
    );

    await waitFor(() =>
      expect(result.current.runtimeRailConversations).toHaveLength(1)
    );
    const previousResult = result.current;
    const previousRenderCount = renderCount;

    act(() => {
      engine.dispatch({ type: "turn/upserted", turn: runningTurn(2) });
    });

    expect(renderCount).toBe(previousRenderCount);
    expect(result.current).toBe(previousResult);
  });

  it("keeps the mounted rail idle for render-irrelevant engine updates", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    engine.dispatch({
      type: "session/upserted",
      session: normalizeAgentActivitySession({
        activeTurnId: "turn-1",
        agentSessionId: "session-1",
        agentTargetId: "target-1",
        cwd: "/workspace",
        latestTurnInteractions: [],
        pendingInteractions: [],
        provider: "codex",
        railSectionKey: "conversations",
        title: "streaming session",
        updatedAtUnixMs: 1,
        workspaceId: "workspace-1"
      })
    });
    engine.dispatch({ type: "turn/upserted", turn: runningTurn(1) });
    const runtime = {
      getSessionEngine: () => engine
    } as unknown as AgentActivityRuntime;
    let railCommitCount = 0;

    function RailHarness(): React.JSX.Element {
      const railQuery = useAgentGUIConversationRailQuery({
        activeConversationId: "session-1",
        conversationFilter: { kind: "all" },
        conversationQuery: "streaming",
        sectionAgentTargetFallbackId: null,
        userProjects: [],
        workspaceId: "workspace-1"
      });
      const activeConversation = railQuery.runtimeRailConversations[0] ?? null;
      return (
        <Profiler
          id="conversation-rail"
          onRender={() => {
            railCommitCount += 1;
          }}
        >
          <AgentGUIConversationRailPane
            revealRequest={null}
            activeConversation={activeConversation}
            activeConversationId="session-1"
            agentTargets={[]}
            agentTargetsLoading={false}
            conversationFilter={{ kind: "all" }}
            conversationQuery="streaming"
            conversations={railQuery.runtimeRailConversations}
            createConversationDisabled={false}
            isCollapsed={false}
            isDeletingConversation={false}
            isDeletingProjectConversations={false}
            isLoadingConversations={false}
            labels={RAIL_LABELS}
            pendingDeleteConversationId={null}
            railQuery={railQuery}
            sectionAgentTargetFallbackId={null}
            uiLanguage="en"
            userProjects={[]}
            workspaceId="workspace-1"
            workspaceUserProjectI18n={RAIL_PROJECT_I18N}
            onCancelDeleteConversation={() => {}}
            onConfirmDeleteConversation={() => {}}
            onConfirmDeleteConversations={() => {}}
            onConfirmDeleteProjectConversations={async () => []}
            onConversationQueryChange={() => {}}
            onCreateConversation={() => {}}
            onRemoveProject={() => {}}
            onMoveProject={async () => {}}
            onRequestDeleteConversation={() => {}}
            onRequestRenameConversation={() => {}}
            onSelectConversation={() => {}}
            onSelectConversationFilterTarget={() => {}}
            onToggleConversationPinned={() => {}}
            onToggleProjectPinned={async () => {}}
            onMarkConversationUnread={() => {}}
            onUpdateConversationFilter={() => {}}
          />
        </Profiler>
      );
    }

    render(
      <AgentActivityRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <RailHarness />
        </TooltipProvider>
      </AgentActivityRuntimeProvider>
    );
    await screen.findByText("streaming session");
    const previousRailCommitCount = railCommitCount;

    act(() => {
      engine.dispatch({ type: "turn/upserted", turn: runningTurn(2) });
    });

    expect(railCommitCount).toBe(previousRailCommitCount);
  });

  it("keeps preloaded service projects ordered, visible, and draggable during local search fallback", async () => {
    const engine = createTestAgentSessionEngine("workspace-1");
    const runtime = {
      getSessionEngine: () => engine,
      async listSessionSections() {
        throw new Error("section membership unavailable");
      },
      async listSessionSectionPage() {
        throw new Error("section membership unavailable");
      }
    } as unknown as AgentActivityRuntime;
    const userProjectsApi = {
      service: {
        getSnapshot: () => ({
          error: null,
          initialized: true,
          isLoading: false,
          projects: [
            {
              id: "workspace-project",
              label: "Workspace",
              path: "/workspace",
              sectionKey: "project:/workspace",
              createdAtUnixMs: 1,
              updatedAtUnixMs: 1,
              lastUsedAtUnixMs: 1,
              pinnedAtUnixMs: 10
            },
            {
              id: "other-project",
              label: "Other",
              path: "/other",
              sectionKey: "project:/other",
              createdAtUnixMs: 1,
              updatedAtUnixMs: 1,
              lastUsedAtUnixMs: 1,
              pinnedAtUnixMs: 5
            }
          ],
          revision: 1
        })
      }
    } as AgentHostUserProjectsApi;

    function RailHarness(): React.JSX.Element {
      const { userProjects } = useAgentGUILocalState({
        data: { lastActiveAgentSessionId: null } as AgentGUINodeData,
        userProjectsApi
      });
      const railQuery = useAgentGUIConversationRailQuery({
        activeConversationId: null,
        conversationFilter: { kind: "all" },
        conversationQuery: "does-not-match",
        sectionAgentTargetFallbackId: null,
        userProjects,
        workspaceId: "workspace-1"
      });
      return (
        <AgentGUIConversationRailPane
          revealRequest={null}
          activeConversation={null}
          activeConversationId={null}
          agentTargets={[]}
          agentTargetsLoading={false}
          conversationFilter={{ kind: "all" }}
          conversationQuery="does-not-match"
          conversations={[]}
          createConversationDisabled={false}
          isCollapsed={false}
          isDeletingConversation={false}
          isDeletingProjectConversations={false}
          isLoadingConversations={false}
          labels={RAIL_LABELS}
          pendingDeleteConversationId={null}
          railQuery={railQuery}
          sectionAgentTargetFallbackId={null}
          uiLanguage="en"
          userProjects={userProjects}
          workspaceId="workspace-1"
          workspaceUserProjectI18n={RAIL_PROJECT_I18N}
          onCancelDeleteConversation={() => {}}
          onConfirmDeleteConversation={() => {}}
          onConfirmDeleteConversations={() => {}}
          onConfirmDeleteProjectConversations={async () => []}
          onConversationQueryChange={() => {}}
          onCreateConversation={() => {}}
          onRemoveProject={() => {}}
          onMoveProject={async () => {}}
          onRequestDeleteConversation={() => {}}
          onRequestRenameConversation={() => {}}
          onSelectConversation={() => {}}
          onSelectConversationFilterTarget={() => {}}
          onToggleConversationPinned={() => {}}
          onToggleProjectPinned={async () => {}}
          onMarkConversationUnread={() => {}}
          onUpdateConversationFilter={() => {}}
        />
      );
    }

    render(
      <AgentActivityRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <RailHarness />
        </TooltipProvider>
      </AgentActivityRuntimeProvider>
    );

    const workspaceTitle = await screen.findByText("Workspace");
    const otherTitle = screen.getByText("Other");
    const pinnedTitle = screen.getByText("Pinned");
    const projectTitle = screen.getByText("Project");
    expect(
      pinnedTitle.compareDocumentPosition(workspaceTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      workspaceTitle.compareDocumentPosition(otherTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      otherTitle.compareDocumentPosition(projectTitle) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      screen.getByRole("combobox", { name: "Project unavailable" })
    ).toBeInTheDocument();
    const workspaceSection = workspaceTitle.closest("section");
    expect(workspaceSection).toBeTruthy();
    const workspaceHeader = workspaceSection?.firstElementChild;
    expect(workspaceHeader).toBeTruthy();
    expect((workspaceHeader as HTMLElement).draggable).toBe(true);
    expect(screen.queryByText("Conversations")).toBeNull();
    expect(screen.queryByText("Conversation unavailable")).toBeNull();
  });

  it("drags a project header to the end without reordering until drop", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});
    const engine = createTestAgentSessionEngine("workspace-1");
    const runtime = {
      getSessionEngine: () => engine,
      async listSessionSections() {
        throw new Error("section membership unavailable");
      },
      async listSessionSectionPage() {
        throw new Error("section membership unavailable");
      }
    } as unknown as AgentActivityRuntime;
    const userProjects = ["Alpha", "Beta", "Gamma"].map((label) => ({
      createdAtUnixMs: 1,
      id: label.toLowerCase(),
      label,
      lastUsedAtUnixMs: 1,
      path: `/workspace/${label.toLowerCase()}`,
      pinnedAtUnixMs: 0,
      sectionKey: `project:/workspace/${label.toLowerCase()}`,
      updatedAtUnixMs: 1
    }));
    let resolveMoveProject!: () => void;
    const moveProjectPromise = new Promise<void>((resolve) => {
      resolveMoveProject = resolve;
    });
    const moveProject = vi.fn(() => moveProjectPromise);

    function RailHarness({
      isMutationPending = false
    }: {
      isMutationPending?: boolean;
    }): React.JSX.Element {
      const railQuery = useAgentGUIConversationRailQuery({
        activeConversationId: null,
        conversationFilter: { kind: "all" },
        conversationQuery: "",
        sectionAgentTargetFallbackId: null,
        userProjects,
        workspaceId: "workspace-1"
      });
      return (
        <AgentGUIConversationRailPane
          revealRequest={null}
          activeConversation={null}
          activeConversationId={null}
          agentTargets={[]}
          agentTargetsLoading={false}
          conversationFilter={{ kind: "all" }}
          conversationQuery=""
          conversations={[]}
          createConversationDisabled={false}
          isCollapsed={false}
          isDeletingConversation={false}
          isDeletingProjectConversations={false}
          isLoadingConversations={false}
          isUserProjectMutationPending={isMutationPending}
          labels={RAIL_LABELS}
          pendingDeleteConversationId={null}
          railQuery={railQuery}
          sectionAgentTargetFallbackId={null}
          uiLanguage="en"
          userProjects={userProjects}
          workspaceId="workspace-1"
          workspaceUserProjectI18n={RAIL_PROJECT_I18N}
          onCancelDeleteConversation={() => {}}
          onConfirmDeleteConversation={() => {}}
          onConfirmDeleteConversations={() => {}}
          onConfirmDeleteProjectConversations={async () => []}
          onConversationQueryChange={() => {}}
          onCreateConversation={() => {}}
          onMarkConversationUnread={() => {}}
          onMoveProject={moveProject}
          onRemoveProject={() => {}}
          onRequestDeleteConversation={() => {}}
          onRequestRenameConversation={() => {}}
          onSelectConversation={() => {}}
          onSelectConversationFilterTarget={() => {}}
          onToggleConversationPinned={() => {}}
          onToggleProjectPinned={async () => {}}
          onUpdateConversationFilter={() => {}}
        />
      );
    }

    const rendered = render(
      <AgentActivityRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <RailHarness />
        </TooltipProvider>
      </AgentActivityRuntimeProvider>
    );
    const alphaSection = (await screen.findByText("Alpha")).closest("section");
    const gammaSection = screen.getByText("Gamma").closest("section");
    const conversationsSection = screen
      .getByText("Conversations")
      .closest("section");
    const alphaHeader = alphaSection?.firstElementChild as HTMLElement;
    const setDragImage = vi.fn();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      setData() {},
      setDragImage
    };
    expect(
      conversationsSection?.getAttribute("data-project-dragging")
    ).toBeNull();

    const alphaToggle = alphaHeader.querySelector("button") as HTMLElement;
    const moreButton = screen.getAllByRole("button", {
      name: "Project actions"
    })[0] as HTMLElement;
    fireEvent.pointerDown(moreButton, { button: 0, ctrlKey: false });
    const removeMenuItem = await screen.findByText("Remove");
    expect(alphaHeader.draggable).toBe(false);
    fireEvent.click(removeMenuItem);
    await screen.findByText("Remove project?");
    expect(alphaHeader.draggable).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Remove project?")).toBeNull()
    );
    expect(alphaHeader.draggable).toBe(true);

    fireEvent.click(alphaToggle);
    expect(alphaToggle.getAttribute("aria-expanded")).toBe("false");
    const alphaAction = alphaHeader.querySelector(
      "[data-project-drag-block] button"
    ) as HTMLElement;
    fireEvent.dragStart(alphaAction, { dataTransfer });
    expect(alphaSection?.getAttribute("data-project-dragging")).toBeNull();

    fireEvent.dragStart(alphaHeader, { dataTransfer });
    expect(alphaSection?.getAttribute("data-project-dragging")).toBe("true");
    expect(alphaSection?.getAttribute("data-collapsed")).toBe("true");
    const dragImage = setDragImage.mock.calls[0]?.[0] as HTMLElement;
    expect(dragImage.querySelectorAll("svg")).toHaveLength(1);
    expect(dragImage.querySelector("[data-project-drag-icon]")).toBeTruthy();
    expect(dragImage.textContent).toBe("Alpha");
    expect(
      [...document.querySelectorAll('section[data-kind="project"]')].map(
        (section) =>
          section.querySelector("[class*=conversation-section-label]")
            ?.textContent
      )
    ).toEqual(["Alpha", "Beta", "Gamma"]);
    const viewports = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-slot="scroll-area-viewport"]'
      )
    ];
    for (const viewport of viewports) {
      viewport.scrollTop = 100;
      vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
        bottom: 200,
        height: 200,
        left: 0,
        right: 100,
        top: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON: () => ({})
      });
    }
    animationFrames.length = 0;
    fireEvent.dragOver(gammaSection as HTMLElement, {
      clientY: 1,
      dataTransfer
    });
    expect(animationFrames.length).toBeGreaterThan(0);
    expect(projectDragAutoScrollDelta(1, { bottom: 200, top: 0 })).toBeLessThan(
      0
    );
    expect(
      projectDragAutoScrollDelta(199, { bottom: 200, top: 0 })
    ).toBeGreaterThan(0);
    expect(gammaSection?.getAttribute("data-project-drop-indicator")).toBe(
      "after"
    );
    fireEvent.drop(
      gammaSection?.closest(
        '[data-slot="scroll-area-viewport"]'
      ) as HTMLElement,
      { dataTransfer }
    );
    await waitFor(() =>
      expect(moveProject).toHaveBeenCalledWith("alpha", null)
    );
    expect(
      [...document.querySelectorAll('section[data-kind="project"]')].every(
        (section) => !(section.firstElementChild as HTMLElement).draggable
      )
    ).toBe(true);
    resolveMoveProject();
    await waitFor(() => expect(alphaHeader.draggable).toBe(true));
    expect(alphaSection?.getAttribute("data-project-dragging")).toBeNull();
    expect(dragImage.isConnected).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalled();

    fireEvent.dragStart(alphaHeader, { dataTransfer });
    const outsideImage = setDragImage.mock.calls.at(-1)?.[0] as HTMLElement;
    fireEvent.drop(document, { dataTransfer });
    expect(outsideImage.isConnected).toBe(false);

    fireEvent.dragStart(alphaHeader, { dataTransfer });
    const dragEndImage = setDragImage.mock.calls.at(-1)?.[0] as HTMLElement;
    fireEvent.dragEnd(alphaHeader, { dataTransfer });
    expect(dragEndImage.isConnected).toBe(false);

    rendered.rerender(
      <AgentActivityRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <RailHarness isMutationPending />
        </TooltipProvider>
      </AgentActivityRuntimeProvider>
    );
    const lockedHeader = screen.getByText("Alpha").closest("section")
      ?.firstElementChild as HTMLElement;
    expect(lockedHeader.draggable).toBe(false);
    const dragImageCallCount = setDragImage.mock.calls.length;
    fireEvent.dragStart(lockedHeader, { dataTransfer });
    expect(setDragImage).toHaveBeenCalledTimes(dragImageCallCount);

    rendered.rerender(
      <AgentActivityRuntimeProvider runtime={runtime}>
        <TooltipProvider>
          <RailHarness />
        </TooltipProvider>
      </AgentActivityRuntimeProvider>
    );
    const unlockedHeader = screen.getByText("Alpha").closest("section")
      ?.firstElementChild as HTMLElement;
    fireEvent.dragStart(unlockedHeader, { dataTransfer });
    const unmountImage = setDragImage.mock.calls.at(-1)?.[0] as HTMLElement;
    rendered.unmount();
    expect(unmountImage.isConnected).toBe(false);
    requestAnimationFrame.mockRestore();
    cancelAnimationFrame.mockRestore();
  });
});

const RAIL_LABELS = {
  batchDeleteProjectSessions: "Delete conversations",
  cancel: "Cancel",
  conversationUnavailable: "Conversation unavailable",
  conversationsSectionMoreActions: "Conversation actions",
  deleteSession: "Delete",
  deleteSessionConfirm: "Confirm delete",
  emptyProjectConversations: "No conversations",
  fallbackAgentTitle: "Agent",
  loadingConversations: "Loading conversations",
  newConversation: "New conversation",
  noConversations: "No conversations",
  openConversationWindow: "Open in window",
  pinSession: "Pin",
  projectRailCreateProject: "Create project",
  projectRailLinkExistingProject: "Link project",
  projectSectionMoreActions: "Project actions",
  projectSectionViewFiles: "View files",
  pinProject: "Pin project",
  unpinProject: "Unpin project",
  pinnedProjectAccessibleName: (label: string) => `Pinned project: ${label}`,
  renameSession: "Rename",
  removeProject: "Remove",
  removeProjectConfirmDescription: (label: string) => `Remove ${label}`,
  removeProjectConfirmTitle: "Remove project?",
  retrySearch: "Retry",
  searchFailed: "Search failed",
  searchNoConversations: "No search results",
  searchPlaceholder: "Search",
  sectionConversations: "Conversations",
  sectionPinned: "Pinned",
  showLessConversations: "Show less",
  showMoreConversations: "Show more",
  unpinSession: "Unpin"
} as AgentGUIViewLabels;

const RAIL_PROJECT_I18N = createDefaultWorkspaceUserProjectI18nRuntime();

function runningTurn(updatedAtUnixMs: number): AgentActivityTurn {
  return {
    agentSessionId: "session-1",
    origin: "user_prompt",
    phase: "running",
    startedAtUnixMs: 1,
    turnId: "turn-1",
    updatedAtUnixMs
  };
}

function searchSession(
  agentSessionId: string,
  title: string,
  updatedAtUnixMs: number
) {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId,
    agentTargetId: "target-1",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title,
    updatedAtUnixMs,
    workspaceId: "workspace-1"
  });
}
