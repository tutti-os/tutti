import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivitySnapshot } from "@tutti-os/agent-activity-core";
import {
  AgentGUIRuntimeProvider,
  type AgentGUIRuntime
} from "../../../agentActivityRuntime";
import type { AgentGUIConversationActivityProjection } from "../model/agentGuiConversationActivityView";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationTypes";
import type { AgentGUIConversationRailLabels } from "./agentGUIConversationRailLabels";
import { AgentGUIConversationActivityView } from "./AgentGUIConversationActivityView";

describe("AgentGUIConversationActivityView", () => {
  it("renders Priority, local date buckets, and project context without session content", () => {
    const snapshot = {
      sessionMessagesById: {
        active: [
          {
            agentSessionId: "active",
            kind: "text",
            messageId: "message-1",
            occurredAtUnixMs: 10,
            payload: { text: "Cached agent response" },
            role: "assistant",
            sequence: 1,
            turnId: "turn-1",
            version: 1
          }
        ]
      }
    } as unknown as AgentActivitySnapshot;
    renderActivityView(snapshot);

    expect(screen.getByRole("heading", { name: "Priority" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(screen.queryByText("Cached agent response")).toBeNull();
    expect(screen.getByText("Conversation")).toBeTruthy();
    expect(screen.getAllByText("Project Alpha")).toHaveLength(1);
  });

  it("keeps an explicit empty Priority section", () => {
    renderActivityView(
      {
        sessionMessagesById: {}
      } as unknown as AgentActivitySnapshot,
      {
        priorityIds: [],
        priorityReasonsById: new Map(),
        recentSections: [],
        referenceDayStartUnixMs: localTodayStart()
      }
    );

    expect(screen.getByText("Nothing needs attention")).toBeTruthy();
  });

  it("preserves row DOM identity and keyboard focus when a session moves into Priority", () => {
    const snapshot = {
      sessionMessagesById: {}
    } as unknown as AgentActivitySnapshot;
    const rendered = renderActivityView(snapshot, {
      priorityIds: [],
      priorityReasonsById: new Map(),
      recentSections: [
        {
          dayStartUnixMs: localTodayStart(),
          ids: ["recent"]
        }
      ],
      referenceDayStartUnixMs: localTodayStart()
    });
    const initialButton = screen
      .getByTestId("agent-gui-conversation-item-recent")
      .querySelector("button");
    expect(initialButton).not.toBeNull();
    initialButton?.focus();

    rendered.rerenderActivity({
      priorityIds: ["recent"],
      priorityReasonsById: new Map([["recent", "unread"]]),
      recentSections: [],
      referenceDayStartUnixMs: localTodayStart()
    });

    const promotedButton = screen
      .getByTestId("agent-gui-conversation-item-recent")
      .querySelector("button");
    expect(promotedButton).toBe(initialButton);
    expect(document.activeElement).toBe(initialButton);
  });
});

function renderActivityView(
  snapshot: AgentActivitySnapshot,
  projection: AgentGUIConversationActivityProjection = {
    priorityIds: ["active"],
    priorityReasonsById: new Map([["active", "active" as const]]),
    referenceDayStartUnixMs: localTodayStart(),
    recentSections: [
      {
        dayStartUnixMs: localTodayStart(),
        ids: ["recent"]
      }
    ]
  }
) {
  const conversations = new Map<string, AgentGUIConversationSummary>([
    ["active", conversation("active")],
    [
      "recent",
      {
        ...conversation("recent"),
        project: {
          id: "project-alpha",
          label: "Project Alpha",
          path: "/workspace/project-alpha",
          pinnedAtUnixMs: 0,
          sectionKey: "project:/workspace/project-alpha"
        },
        railSectionKey: "project:/workspace/project-alpha"
      }
    ]
  ]);
  const runtime = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {}
  } as unknown as AgentGUIRuntime;
  const activityView = (
    nextProjection: AgentGUIConversationActivityProjection
  ) => (
    <AgentGUIRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <AgentGUIConversationActivityView
          activeConversationId={null}
          conversationsById={conversations}
          isDeletingConversation={false}
          isRailInteractionLocked={() => false}
          labels={LABELS}
          pendingDeleteConversationId={null}
          projection={nextProjection}
          registerItemElement={() => {}}
          uiLanguage="en"
          workspaceId="workspace-1"
          onCancelDeleteConversation={() => {}}
          onConfirmDeleteConversation={() => {}}
          onMarkConversationUnread={() => {}}
          onRequestDeleteConversation={() => {}}
          onRequestRenameConversation={() => {}}
          onSelectConversation={vi.fn()}
          onToggleConversationPinned={() => {}}
        />
      </TooltipProvider>
    </AgentGUIRuntimeProvider>
  );
  const rendered = render(activityView(projection));
  return {
    ...rendered,
    rerenderActivity: (
      nextProjection: AgentGUIConversationActivityProjection
    ) => rendered.rerender(activityView(nextProjection))
  };
}

function localTodayStart(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function conversation(id: string): AgentGUIConversationSummary {
  return {
    cwd: "/workspace",
    id,
    provider: "codex",
    status: "ready",
    title: id,
    updatedAtUnixMs: 1
  };
}

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
  copiedToClipboard: "Copied",
  copyAsMarkdown: "Copy as Markdown",
  copyAsReference: "Copy as reference",
  copyFailed: "Copy failed",
  conversationCopyFile: "File",
  conversationCopyImage: "Image",
  conversationCopyImagesOmitted: "Images omitted",
  conversationCopyInProgress: "Copying",
  conversationCopyMentionPrefix: "@",
  conversationCopyPreviousMessages: "Previous messages",
  deleteSession: "Delete",
  deleteSessionConfirm: "Confirm delete",
  markSessionUnread: "Mark as unread",
  moreSessionActions: "More actions",
  openConversationWindow: "Open in window",
  pinSession: "Pin",
  relativeTimeDays: (value: number) => `${value} days`,
  relativeTimeHours: (value: number) => `${value} hours`,
  relativeTimeJustNow: "just now",
  relativeTimeMinutes: (value: number) => `${value} minutes`,
  relativeTimeMonths: (value: number) => `${value} months`,
  relativeTimeYears: (value: number) => `${value} years`,
  renameSession: "Rename",
  unpinSession: "Unpin"
} as unknown as AgentGUIConversationRailLabels;
