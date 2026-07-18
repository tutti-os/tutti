import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { AgentGUIConversationRailItem } from "./AgentGUIConversationRailItem";

describe("AgentGUIConversationRailItem interaction lock", () => {
  it("keeps the provider icon and plain title while adding a monochrome task icon", () => {
    const { container } = renderRailItem({
      isRailInteractionLocked: () => false,
      item: {
        title: "@看看最新的代码提交 111",
        titleLeadingMentionKind: "task"
      }
    });

    expect(
      container.querySelector(".agent-gui-node__conversation-provider-icon")
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-agent-gui-conversation-title-mention-icon="task"]'
      )
    ).not.toBeNull();
    expect(container.textContent).toContain("看看最新的代码提交 111");
    expect(container.textContent).not.toContain("@看看最新的代码提交 111");
    expect(container.querySelector(".agent-rich-text-readonly")).toBeNull();
  });

  it("keeps a projected session reference as @ text without a mention icon", () => {
    const { container } = renderRailItem({
      isRailInteractionLocked: () => false,
      item: {
        title: "@读一下我本地的桌面",
        titleLeadingMentionKind: "session"
      }
    });

    expect(
      container.querySelector(
        '[data-agent-gui-conversation-title-mention-icon="session"]'
      )
    ).toBeNull();
    expect(
      container.querySelectorAll(
        "[data-agent-gui-conversation-title-mention-icon]"
      )
    ).toHaveLength(0);
    expect(container.textContent).toContain("@读一下我本地的桌面");
  });

  it.each(["app", "agent"] as const)(
    "keeps a projected %s reference as @ text without a mention icon",
    (kind) => {
      const { container } = renderRailItem({
        isRailInteractionLocked: () => false,
        item: {
          title: "@Inspect reference",
          titleLeadingMentionKind: kind
        }
      });

      expect(
        container.querySelector(
          `[data-agent-gui-conversation-title-mention-icon="${kind}"]`
        )
      ).toBeNull();
      expect(container.textContent).toContain("@Inspect reference");
    }
  );

  it("keeps a projected file reference as @ text without a mention icon", () => {
    const { container } = renderRailItem({
      isRailInteractionLocked: () => false,
      item: {
        title: "@notes.md inspect",
        titleLeadingMentionKind: "file"
      }
    });

    expect(
      container.querySelector(
        '[data-agent-gui-conversation-title-mention-icon="file"]'
      )
    ).toBeNull();
    expect(
      container.querySelectorAll(
        "[data-agent-gui-conversation-title-mention-icon]"
      )
    ).toHaveLength(0);
    expect(container.textContent).toContain("@notes.md inspect");
  });

  it("leaves an ordinary conversation row unchanged", () => {
    const { container } = renderRailItem({
      isRailInteractionLocked: () => false
    });

    expect(
      container.querySelector(".agent-gui-node__conversation-provider-icon")
    ).not.toBeNull();
    expect(
      container.querySelector(
        "[data-agent-gui-conversation-title-mention-icon]"
      )
    ).toBeNull();
    expect(container.textContent).toContain("Session 1");
  });

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
  item?: Partial<AgentGUIConversationSummary>;
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
        updatedAtUnixMs: 1,
        ...overrides.item
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
