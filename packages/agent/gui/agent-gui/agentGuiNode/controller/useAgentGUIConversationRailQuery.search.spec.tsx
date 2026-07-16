import {
  normalizeAgentActivitySession,
  type AgentActivityTurn
} from "@tutti-os/agent-activity-core";
import { TooltipProvider } from "@tutti-os/ui-system";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor
} from "@testing-library/react";
import { Profiler, type PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";
import {
  AgentActivityRuntimeProvider,
  type AgentActivityRuntime,
  type AgentActivityRuntimeListSessionsPageInput
} from "../../../agentActivityRuntime";
import { createTestAgentSessionEngine } from "../../../shared/testing/createTestAgentSessionEngine";
import { useAgentGUIConversationRailQuery } from "./useAgentGUIConversationRailQuery";
import { AgentGUIConversationRailPane } from "../view/AgentGUIConversationRailPane";
import type { AgentGUIViewLabels } from "../view/AgentGUINodeView.types";
import { createDefaultWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";

describe("useAgentGUIConversationRailQuery search", () => {
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
          previewMode: false,
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
          previewMode: false,
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
          previewMode: true,
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
        previewMode: true,
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
            previewMode
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
            onMarkConversationUnread={() => {}}
            onRemoveProject={() => {}}
            onRequestDeleteConversation={() => {}}
            onRequestRenameConversation={() => {}}
            onSelectConversation={() => {}}
            onSelectConversationFilterTarget={() => {}}
            onToggleConversationPinned={() => {}}
            onUpdateConversationFilter={() => {}}
          />
        </Profiler>
      );
    }

    render(
      <AgentActivityRuntimeProvider runtime={runtime}>
        <RailHarness />
      </AgentActivityRuntimeProvider>
    );
    await screen.findByText("streaming session");
    const previousRailCommitCount = railCommitCount;

    act(() => {
      engine.dispatch({ type: "turn/upserted", turn: runningTurn(2) });
    });

    expect(railCommitCount).toBe(previousRailCommitCount);
  });

  it("keeps empty section chrome visible when the first membership request fails", async () => {
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
    const userProjects = [
      {
        id: "workspace-project",
        label: "Workspace",
        path: "/workspace",
        sectionKey: "project:/workspace",
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
        lastUsedAtUnixMs: 1
      }
    ];

    function RailHarness(): React.JSX.Element {
      const railQuery = useAgentGUIConversationRailQuery({
        activeConversationId: null,
        conversationFilter: { kind: "all" },
        conversationQuery: "",
        previewMode: false,
        sectionAgentTargetFallbackId: null,
        userProjects,
        workspaceId: "workspace-1"
      });
      return (
        <AgentGUIConversationRailPane
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
          labels={RAIL_LABELS}
          pendingDeleteConversationId={null}
          previewMode={false}
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
          onRemoveProject={() => {}}
          onRequestDeleteConversation={() => {}}
          onRequestRenameConversation={() => {}}
          onSelectConversation={() => {}}
          onSelectConversationFilterTarget={() => {}}
          onToggleConversationPinned={() => {}}
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

    await screen.findByText("Workspace");
    expect(screen.getByText("Conversations")).toBeTruthy();
    expect(screen.getAllByText("No conversations")).toHaveLength(2);
    expect(screen.queryByText("Conversation unavailable")).toBeNull();
  });
});

const RAIL_LABELS = {
  conversationUnavailable: "Conversation unavailable",
  conversationsSectionMoreActions: "Conversation actions",
  deleteSession: "Delete",
  deleteSessionConfirm: "Confirm delete",
  emptyProjectConversations: "No conversations",
  fallbackAgentTitle: "Agent",
  loadingConversations: "Loading conversations",
  markSessionUnread: "Mark unread",
  newConversation: "New conversation",
  noConversations: "No conversations",
  openConversationWindow: "Open in window",
  pinSession: "Pin",
  projectRailCreateProject: "Create project",
  projectRailLinkExistingProject: "Link project",
  renameSession: "Rename",
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
