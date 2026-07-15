import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { AgentGUIConversationRailItem } from "./AgentGUIConversationRailItem";

describe("AgentGUIConversationRailItem interaction lock", () => {
  it("blocks the div context-menu trigger while rail reconciliation is pending", () => {
    const onSelectConversation = vi.fn();
    renderRailItem({
      isRailInteractionLocked: () => true,
      onSelectConversation
    });

    const row = screen.getByTestId("agent-gui-conversation-item-session-1");
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: /Session 1/ }));

    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    expect(onSelectConversation).not.toHaveBeenCalled();
  });

  it("blocks actions from an already-open portaled menu after the lock starts", async () => {
    let locked = false;
    const onRequestRenameConversation = vi.fn();
    renderRailItem({
      isRailInteractionLocked: () => locked,
      onRequestRenameConversation
    });

    fireEvent.contextMenu(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    );
    const renameItem = await screen.findByRole("menuitem", { name: "Rename" });
    locked = true;
    fireEvent.pointerUp(renameItem, { button: 0 });

    await waitFor(() =>
      expect(onRequestRenameConversation).not.toHaveBeenCalled()
    );
  });
});

function renderRailItem(overrides: {
  isRailInteractionLocked: () => boolean;
  onRequestRenameConversation?: (
    conversation: AgentGUIConversationSummary
  ) => void;
  onSelectConversation?: (agentSessionId: string) => void;
}) {
  return render(
    <AgentGUIConversationRailItem
      active={false}
      currentTimeMs={1}
      isDeletingConversation={false}
      isPendingDeleteConversation={false}
      isRailInteractionLocked={overrides.isRailInteractionLocked}
      item={{
        cwd: "/workspace",
        id: "session-1",
        provider: "codex",
        status: "ready",
        title: "Session 1",
        updatedAtUnixMs: 1
      }}
      labels={RAIL_ITEM_LABELS}
      previewMode={false}
      registerItemElement={() => {}}
      uiLanguage="en"
      workspaceId="workspace-1"
      onCancelDeleteConversation={() => {}}
      onConfirmDeleteConversation={() => {}}
      onMarkConversationUnread={() => {}}
      onRequestDeleteConversation={() => {}}
      onRequestRenameConversation={
        overrides.onRequestRenameConversation ?? vi.fn()
      }
      onSelectConversation={overrides.onSelectConversation ?? vi.fn()}
      onToggleConversationPinned={() => {}}
    />
  );
}

const RAIL_ITEM_LABELS = {
  copySessionLink: "Copy link",
  deleteSession: "Delete",
  deleteSessionConfirm: "Confirm delete",
  fallbackAgentTitle: "Agent",
  markSessionUnread: "Mark unread",
  openConversationWindow: "Open in window",
  pinSession: "Pin",
  renameSession: "Rename",
  unpinSession: "Unpin"
} as AgentGUIViewLabels;
