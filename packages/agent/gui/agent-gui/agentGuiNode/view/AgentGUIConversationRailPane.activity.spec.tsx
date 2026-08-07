import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import {
  AgentGUIRuntimeProvider,
  type AgentGUIRuntime
} from "../../../agentActivityRuntime";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationTypes";
import type { useAgentGUIConversationRailQuery } from "../controller/useAgentGUIConversationRailQuery";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import { AgentGUIConversationRailPane } from "./AgentGUIConversationRailPane";
import { createAgentGUIConversationActivityController } from "../controller/agentGUIConversationActivityController";

describe("AgentGUIConversationRailPane Activity capability", () => {
  it("fails closed when the host does not opt in", () => {
    renderPane({ capability: false });

    expect(screen.queryByTestId("agent-gui-activity-view-toggle")).toBeNull();
  });

  it("toggles an in-memory Activity View without requesting another page", () => {
    const listPage = vi.fn();
    renderPane({ capability: true, listPage });

    const toggle = screen.getByTestId("agent-gui-activity-view-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAccessibleName("Turn off activity view");
    expect(screen.getByRole("heading", { name: "Priority" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(screen.getByText("Nothing needs attention")).toBeTruthy();
    expect(listPage).not.toHaveBeenCalled();

    const search = screen.getByPlaceholderText("Search sessions");
    fireEvent.change(search, { target: { value: "Session" } });
    expect(screen.queryByRole("heading", { name: "Priority" })).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByRole("heading", { name: "Priority" })).toBeTruthy();
    expect(listPage).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("heading", { name: "Priority" })).toBeNull();
  });

  it("places the Activity toggle immediately after New session", () => {
    renderPane({ capability: true });

    const newConversation = screen.getByTestId("agent-gui-new-conversation");
    const activityToggle = screen.getByTestId("agent-gui-activity-view-toggle");

    expect(
      newConversation.compareDocumentPosition(activityToggle) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("announces attention on the inactive toggle", () => {
    renderPane({ capability: true, hasUnreadCompletion: true });

    expect(
      screen.getByRole("button", {
        name: "View activity, attention needed"
      })
    ).toBeTruthy();
  });

  it("uses only canonical in-memory conversations instead of stale rail projections", () => {
    renderPane({
      capability: true,
      runtimeRailConversations: [
        {
          cwd: "/workspace",
          id: "stale-session",
          provider: "codex",
          sortTimeUnixMs: Date.now(),
          status: "working",
          title: "Stale Session",
          updatedAtUnixMs: Date.now()
        }
      ]
    });

    fireEvent.click(screen.getByTestId("agent-gui-activity-view-toggle"));

    expect(screen.queryByText("Stale Session")).toBeNull();
    expect(
      screen.queryByTestId("agent-gui-conversation-item-stale-session")
    ).toBeNull();
    expect(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    ).toBeTruthy();
  });

  it("does not admit a detail-only transient rail overlay", () => {
    const transient = {
      ...conversationFixture(),
      id: "selected-history",
      isTransient: true,
      status: "ready" as const,
      title: "Selected history"
    };
    renderPane({
      capability: true,
      activityConversations: [conversationFixture()],
      conversations: [conversationFixture(), transient]
    });

    fireEvent.click(screen.getByTestId("agent-gui-activity-view-toggle"));

    expect(screen.queryByText("Selected history")).toBeNull();
  });
});

function renderPane({
  capability,
  hasUnreadCompletion = false,
  listPage = vi.fn(),
  runtimeRailConversations = [],
  activityConversations: requestedActivityConversations,
  conversations: requestedConversations
}: {
  capability: boolean;
  hasUnreadCompletion?: boolean;
  listPage?: ReturnType<typeof vi.fn>;
  runtimeRailConversations?: AgentGUIConversationSummary[];
  activityConversations?: AgentGUIConversationSummary[];
  conversations?: AgentGUIConversationSummary[];
}) {
  const conversation = conversationFixture({ hasUnreadCompletion });
  const activityConversations = requestedActivityConversations ?? [
    conversation
  ];
  const conversations = requestedConversations ?? activityConversations;
  const activityController = createAgentGUIConversationActivityController();
  activityController.configure({
    available: capability,
    conversations: activityConversations,
    identityKey: "workspace-1",
    scopeKey: "workspace-1"
  });
  const snapshot = {
    sessionMessagesById: {}
  } as unknown as AgentActivitySnapshot;
  const runtime = {
    conversationActivityViewEnabled: capability,
    getSnapshot: () => snapshot,
    listSessionsPage: listPage,
    subscribe: () => () => {}
  } as unknown as AgentGUIRuntime;
  function PaneHarness(): React.JSX.Element {
    const [conversationQuery, setConversationQuery] = useState("");
    return (
      <AgentGUIConversationRailPane
        activeConversation={null}
        activeConversationId={null}
        agentTargets={[]}
        agentTargetsLoading={false}
        conversationFilter={{ kind: "all" }}
        conversationQuery={conversationQuery}
        conversations={conversations}
        createConversationDisabled={false}
        isCollapsed={false}
        isDeletingConversation={false}
        isDeletingProjectConversations={false}
        isLoadingConversations={false}
        labels={LABELS}
        pendingDeleteConversationId={null}
        railQuery={{
          ...RAIL_QUERY,
          activityController,
          activityConversations,
          runtimeRailConversations
        }}
        revealRequest={null}
        uiLanguage="en"
        userProjects={[]}
        workspaceId="workspace-1"
        workspaceUserProjectI18n={PROJECT_I18N}
        onCancelDeleteConversation={() => {}}
        onConfirmDeleteConversation={() => {}}
        onConfirmDeleteConversations={() => {}}
        onConfirmDeleteProjectConversations={async () => []}
        onConversationQueryChange={setConversationQuery}
        onCreateConversation={() => {}}
        onMarkConversationUnread={() => {}}
        onMoveProject={async () => {}}
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
  return render(
    <AgentGUIRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <PaneHarness />
      </TooltipProvider>
    </AgentGUIRuntimeProvider>
  );
}

function conversationFixture(
  overrides: Pick<AgentGUIConversationSummary, "hasUnreadCompletion"> = {}
): AgentGUIConversationSummary {
  return {
    cwd: "/workspace",
    hasUnreadCompletion: overrides.hasUnreadCompletion,
    id: "session-1",
    provider: "codex",
    sortTimeUnixMs: Date.now(),
    status: "ready",
    title: "Session 1",
    updatedAtUnixMs: Date.now()
  };
}

const RAIL_QUERY = {
  activityConversations: [conversationFixture()],
  activityRootFacts: new Map(),
  batchDeletionAvailable: false,
  isInteractionLocked: () => false,
  loadMoreSectionConversations: () => {},
  railSearch: {
    enabled: false,
    failed: false,
    hasMore: false,
    loadMore: () => {},
    loadingMore: false,
    pending: false,
    retry: () => {},
    sessionIds: []
  },
  runtimeRailConversations: [],
  runtimeRailMemberships: null,
  runtimeRailReconcilingSessionIds: new Set<string>(),
  runtimeRailScopeResolved: true,
  runtimeRailSectionsPending: false,
  runtimeSectionsEnabled: false,
  sectionPageStates: new Map()
} as unknown as ReturnType<typeof useAgentGUIConversationRailQuery>;

const PROJECT_I18N = {
  t: (key: string) => key,
  tFirst: () => "Projects"
} as never;

const LABELS = {
  activityConversationSource: "Conversation",
  activityNothingNeedsAttention: "Nothing needs attention",
  activityPriority: "Priority",
  activityStatusFailed: "Failed",
  activityStatusRecentlyActive: "Recently active",
  activityStatusUnread: "Unread result",
  activityStatusWaiting: "Waiting for you",
  activityStatusWorking: "Working",
  activityToday: "Today",
  activityYesterday: "Yesterday",
  conversationUnavailable: "Session unavailable",
  loadingConversations: "Loading sessions",
  newConversation: "New session",
  noConversations: "No sessions",
  projectRailCreateProject: "New project",
  projectRailLinkExistingProject: "Link project",
  retrySearch: "Retry",
  searchFailed: "Search failed",
  searchNoConversations: "No results",
  searchPlaceholder: "Search sessions",
  sectionConversations: "Chats",
  sectionPinned: "Pinned",
  turnOffActivityView: "Turn off activity view",
  viewActivity: "View activity",
  viewActivityNeedsAttention: "View activity, attention needed"
} as unknown as AgentGUIConversationRailLabels;
