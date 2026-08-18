import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentGUIAgentTarget,
  AgentGUIAgentTargetInfoRenderer
} from "../../../types";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import {
  AgentTargetPresentationProvider,
  type AgentMessageMarkdownAgentTarget
} from "../../../shared/AgentTargetPresentationContext";
import { AgentTargetInfoRendererProvider } from "../../../shared/AgentTargetInfoRendererContext";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { AgentGUIConversationRailItem } from "./AgentGUIConversationRailItem";

describe("AgentGUIConversationRailItem interaction lock", () => {
  it("keeps the provider icon and plain @ title without a task icon", () => {
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
        "[data-agent-gui-conversation-title-mention-icon]"
      )
    ).toBeNull();
    expect(container.textContent).toContain("@看看最新的代码提交 111");
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

  it("renders the Codex-aligned two-line Activity presentation without a timestamp", () => {
    const secondary = "Tutti";
    const { container } = renderRailItem({
      isRailInteractionLocked: () => false,
      item: { status: "working" },
      presentation: {
        kind: "activity",
        priorityReason: "active",
        projectLabel: "Tutti",
        secondary: {
          kind: "project",
          text: secondary
        }
      }
    });

    expect(
      container.querySelector('[data-presentation="activity"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("Session 1Tutti");
    expect(
      container.querySelector(".agent-gui-node__conversation-title-row")
        ?.textContent
    ).toBe("Session 1");
    expect(container.textContent).toContain(secondary);
    expect(
      screen.getByRole("button", { name: "Session 1, Tutti, Working" })
    ).toBeTruthy();
    expect(
      container.querySelector(".agent-gui-node__conversation-time")
    ).toBeNull();
  });

  it("announces a frozen Priority member as recently active after its live state clears", () => {
    renderRailItem({
      isRailInteractionLocked: () => false,
      item: { status: "ready" },
      presentation: {
        kind: "activity",
        priorityReason: "unread",
        projectLabel: null,
        secondary: { kind: "source", text: "Conversation" }
      }
    });

    expect(
      screen.getByRole("button", { name: "Session 1, Recently active" })
    ).toBeTruthy();
  });

  it("renders an open extension target icon through the monochrome mask", () => {
    const iconUrl = "data:image/svg+xml;base64,kilo-colored";
    const maskIconUrl = "data:image/svg+xml;base64,kilo-mask";
    const { container } = renderRailItem({
      agentTargets: [
        {
          agentTargetId: "extension:kilo",
          iconUrl,
          maskIconUrl,
          provider: "acp:kilo",
          workspaceId: "workspace-1"
        }
      ],
      isRailInteractionLocked: () => false,
      item: {
        agentTargetId: "extension:kilo",
        provider: "acp:kilo"
      }
    });

    const icon = container.querySelector<HTMLElement>(
      ".agent-gui-node__conversation-provider-icon"
    );
    expect(icon).not.toBeNull();
    expect(icon?.style.maskImage).toBe(`url("${maskIconUrl}")`);
    expect(
      icon?.style.getPropertyValue("--agent-gui-conversation-provider-icon-url")
    ).toBe("");
  });

  it("renders a target identity image without treating it as a mask", () => {
    const iconUrl = "data:image/png;base64,kilo-colored";
    const { container } = renderRailItem({
      agentTargets: [
        {
          agentTargetId: "extension:kilo",
          iconUrl,
          provider: "acp:kilo",
          workspaceId: "workspace-1"
        }
      ],
      isRailInteractionLocked: () => false,
      item: {
        agentTargetId: "extension:kilo",
        provider: "acp:kilo"
      }
    });

    const image = container.querySelector<HTMLImageElement>(
      ".agent-gui-node__conversation-provider-image"
    );
    expect(image?.src).toBe(iconUrl);
    expect(
      container.querySelector(
        ".agent-gui-node__conversation-provider-mask-icon"
      )
    ).toBeNull();
  });

  it("opens exact Host target information from icon hover and row keyboard focus", async () => {
    const exactTarget: AgentGUIAgentTarget = {
      agentTargetId: "agent:shared",
      iconUrl: "data:image/png;base64,shared",
      label: "Shared Codex",
      ownerDeviceLabel: "Vector's MacBook Pro",
      provider: "codex",
      ref: { kind: "shared", provider: "codex" },
      targetId: "shared:codex"
    };
    const siblingTarget: AgentGUIAgentTarget = {
      ...exactTarget,
      agentTargetId: "agent:sibling",
      label: "Sibling Codex",
      targetId: "shared:sibling"
    };
    const renderAgentTargetInfo = vi.fn(({ surface, target }) => (
      <div>{`${surface}:${target.label}`}</div>
    ));
    const { container } = renderRailItem({
      agentTargets: [
        {
          agentTargetId: exactTarget.agentTargetId!,
          iconUrl: exactTarget.iconUrl,
          provider: exactTarget.provider,
          workspaceId: "workspace-1"
        }
      ],
      isRailInteractionLocked: () => false,
      item: { agentTargetId: exactTarget.agentTargetId },
      renderAgentTargetInfo,
      targetInfoTargets: [siblingTarget, exactTarget]
    });

    expect(renderAgentTargetInfo).not.toHaveBeenCalled();

    fireEvent.pointerMove(
      container.querySelector(".agent-gui-node__conversation-provider-image")!,
      { pointerType: "mouse" }
    );

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "conversation-rail:Shared Codex"
    );
    expect(renderAgentTargetInfo).toHaveBeenLastCalledWith({
      surface: "conversation-rail",
      target: exactTarget
    });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());

    const conversationButton = screen.getByRole("button", {
      name: /Session 1/
    });
    fireEvent.focus(conversationButton);
    const focusTooltip = await screen.findByRole("tooltip");
    expect(focusTooltip).toHaveTextContent("conversation-rail:Shared Codex");
    expect(conversationButton).toHaveAttribute(
      "aria-describedby",
      focusTooltip.id
    );

    fireEvent.blur(conversationButton);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("fails closed when a session target is missing from the exact directory", () => {
    const renderAgentTargetInfo = vi.fn(() => <div>Should not render</div>);
    renderRailItem({
      agentTargets: [
        {
          agentTargetId: "agent:missing",
          iconUrl: "data:image/png;base64,missing",
          provider: "codex",
          workspaceId: "workspace-1"
        }
      ],
      isRailInteractionLocked: () => false,
      item: { agentTargetId: "agent:missing" },
      renderAgentTargetInfo,
      targetInfoTargets: []
    });

    fireEvent.focus(screen.getByRole("button", { name: /Session 1/ }));

    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(renderAgentTargetInfo).not.toHaveBeenCalled();
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

  it("keeps pin and delete as direct row actions outside the menu", () => {
    renderRailItem({ isRailInteractionLocked: () => false });

    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    fireEvent.pointerEnter(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    );
    expect(screen.getByRole("button", { name: "Pin" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("uses the same shared actions for the more button and context menu", async () => {
    renderRailItem({ isRailInteractionLocked: () => false });

    fireEvent.pointerEnter(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "More actions" }),
      { button: 0 }
    );
    for (const label of [
      "Rename",
      "Copy as Markdown",
      "Copy as reference",
      "Mark as unread"
    ]) {
      expect(await screen.findByRole("menuitem", { name: label })).toBeTruthy();
    }
    for (const label of ["Pin", "Delete", "Archive"]) {
      expect(screen.queryByRole("menuitem", { name: label })).toBeNull();
    }
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape"
    });

    fireEvent.contextMenu(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    );
    for (const label of [
      "Rename",
      "Copy as Markdown",
      "Copy as reference",
      "Mark as unread"
    ]) {
      expect(await screen.findByRole("menuitem", { name: label })).toBeTruthy();
    }
    for (const label of ["Pin", "Delete", "Archive"]) {
      expect(screen.queryByRole("menuitem", { name: label })).toBeNull();
    }
  });

  it("keeps the focused trigger mounted and unmounts content after Escape", async () => {
    renderRailItem({ isRailInteractionLocked: () => false });

    expect(screen.queryByRole("menuitem")).toBeNull();
    const trigger = screen.getByTestId("agent-gui-conversation-item-session-1");
    const selectButton = screen.getByRole("button", { name: /Session 1/ });
    selectButton.focus();
    fireEvent.contextMenu(trigger, { button: 0, detail: 0 });
    expect(
      await screen.findByRole("menuitem", { name: "Rename" })
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
  });

  it("mounts row actions before keyboard focus advances past the row", () => {
    renderRailItem({ isRailInteractionLocked: () => false });

    expect(screen.queryByRole("button", { name: "Pin" })).toBeNull();
    fireEvent.focus(screen.getByRole("button", { name: /Session 1/ }));

    expect(screen.getByRole("button", { name: "Pin" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More actions" })
    ).toBeInTheDocument();
  });

  it("runs an unlocked action before lazy menu content unmounts", async () => {
    const onRequestRenameConversation = vi.fn();
    renderRailItem({
      isRailInteractionLocked: () => false,
      onRequestRenameConversation
    });

    fireEvent.contextMenu(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    );
    const renameItem = await screen.findByRole("menuitem", { name: "Rename" });
    fireEvent.pointerUp(renameItem, { button: 0 });

    await waitFor(() =>
      expect(onRequestRenameConversation).toHaveBeenCalledTimes(1)
    );
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("runs the manual unread action with the selected session id", async () => {
    const onMarkConversationUnread = vi.fn();
    renderRailItem({
      isRailInteractionLocked: () => false,
      onMarkConversationUnread
    });

    fireEvent.contextMenu(
      screen.getByTestId("agent-gui-conversation-item-session-1")
    );
    const markUnreadItem = await screen.findByRole("menuitem", {
      name: "Mark as unread"
    });
    fireEvent.pointerUp(markUnreadItem, { button: 0 });

    await waitFor(() =>
      expect(onMarkConversationUnread).toHaveBeenCalledWith("session-1")
    );
  });
});

function renderRailItem(overrides: {
  agentTargets?: readonly AgentMessageMarkdownAgentTarget[];
  isRailInteractionLocked: () => boolean;
  item?: Partial<AgentGUIConversationSummary>;
  onRequestRenameConversation?: (
    conversation: AgentGUIConversationSummary
  ) => void;
  onMarkConversationUnread?: (agentSessionId: string) => void;
  onSelectConversation?: (agentSessionId: string) => void;
  presentation?: React.ComponentProps<
    typeof AgentGUIConversationRailItem
  >["presentation"];
  renderAgentTargetInfo?: AgentGUIAgentTargetInfoRenderer;
  targetInfoTargets?: readonly AgentGUIAgentTarget[];
}) {
  const item = (
    <AgentGUIConversationRailItem
      active={false}
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
      presentation={overrides.presentation}
      registerItemElement={() => {}}
      uiLanguage="en"
      workspaceId="workspace-1"
      onCancelDeleteConversation={() => {}}
      onConfirmDeleteConversation={() => {}}
      onRequestDeleteConversation={() => {}}
      onRequestRenameConversation={
        overrides.onRequestRenameConversation ?? vi.fn()
      }
      onSelectConversation={overrides.onSelectConversation ?? vi.fn()}
      onToggleConversationPinned={() => {}}
      onMarkConversationUnread={overrides.onMarkConversationUnread ?? vi.fn()}
    />
  );
  const withTargetPresentation = overrides.agentTargets ? (
    <AgentTargetPresentationProvider agentTargets={overrides.agentTargets}>
      {item}
    </AgentTargetPresentationProvider>
  ) : (
    item
  );
  return render(
    <TooltipProvider>
      <AgentTargetInfoRendererProvider
        agentTargets={overrides.targetInfoTargets ?? []}
        renderer={overrides.renderAgentTargetInfo}
      >
        {withTargetPresentation}
      </AgentTargetInfoRendererProvider>
    </TooltipProvider>
  );
}

const RAIL_ITEM_LABELS = {
  activityStatusFailed: "Failed",
  activityStatusRecentlyActive: "Recently active",
  activityStatusUnread: "Unread result",
  activityStatusWaiting: "Waiting for you",
  activityStatusWorking: "Working",
  copiedToClipboard: "Copied",
  copyAsMarkdown: "Copy as Markdown",
  copyAsReference: "Copy as reference",
  copyFailed: "Copy failed",
  conversationCopyFile: "File",
  conversationCopyImage: "Image",
  conversationCopyImagesOmitted: "{{count}} image(s) omitted",
  conversationCopyMentionPrefix: "@",
  conversationCopyPreviousMessages: "{{count}} previous messages",
  deleteSession: "Delete",
  deleteSessionConfirm: "Confirm delete",
  fallbackAgentTitle: "Agent",
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
} as unknown as AgentGUIViewLabels;
