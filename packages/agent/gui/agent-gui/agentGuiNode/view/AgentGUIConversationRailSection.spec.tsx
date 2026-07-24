import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { AgentGUIConversationRailSection } from "./AgentGUIConversationRailSection";
import { AgentGUIConversationRailSectionPresentationProvider } from "./agentGUIConversationRailSectionPresentationContext";

describe("AgentGUIConversationRailSection project pin presentation", () => {
  it("requests an explicit no-project scope from the conversations section", () => {
    const onCreateConversation = vi.fn();
    renderProjectSection({
      onCreateConversation,
      pinnedAtUnixMs: 0,
      sectionKind: "conversations",
      onToggleProjectPinned: vi.fn(() => Promise.resolve())
    });

    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(onCreateConversation).toHaveBeenCalledWith({
      projectPath: null,
      source: "unscoped_section"
    });
  });

  it("renders pinned accessibility, empty state, ordered menu, and unpin action", async () => {
    const onToggleProjectPinned = vi.fn(() => Promise.resolve());
    renderProjectSection({
      pinnedAtUnixMs: 10,
      onToggleProjectPinned
    });

    expect(
      screen.getByRole("button", { name: "Pinned project: Alpha" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("No sessions")).toBeInTheDocument();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Project actions" }),
      { button: 0, ctrlKey: false }
    );
    const menuItems = await screen.findAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Open folder",
      "Unpin project",
      "Delete sessions",
      "Remove project"
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin project" }));
    expect(onToggleProjectPinned).toHaveBeenCalledWith("alpha", false);
  });

  it("offers pin for an ordinary project", async () => {
    const onToggleProjectPinned = vi.fn(() => Promise.resolve());
    renderProjectSection({
      pinnedAtUnixMs: 0,
      searchActive: true,
      onToggleProjectPinned
    });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Project actions" }),
      { button: 0, ctrlKey: false }
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Pin project" })
    );
    expect(onToggleProjectPinned).toHaveBeenCalledWith("alpha", true);
  });

  it("locks the project menu for a shared user-project mutation", () => {
    renderProjectSection({
      pinnedAtUnixMs: 0,
      projectActionLocked: true,
      onToggleProjectPinned: vi.fn(() => Promise.resolve())
    });

    expect(
      screen.getByRole("button", { name: "Project actions" })
    ).toBeDisabled();
  });

  it("mounts project menu content only while open", async () => {
    const onProjectMenuOpenChange = vi.fn();
    renderProjectSection({
      pinnedAtUnixMs: 0,
      onProjectMenuOpenChange,
      onToggleProjectPinned: vi.fn(() => Promise.resolve())
    });

    expect(screen.queryByRole("menuitem")).toBeNull();
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Project actions" }),
      { button: 0, ctrlKey: false }
    );
    expect(
      await screen.findByRole("menuitem", { name: "Open folder" })
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    expect(onProjectMenuOpenChange).toHaveBeenNthCalledWith(1, true);
    expect(onProjectMenuOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("updates only open menu availability when section locks change", async () => {
    const onToggleProjectPinned = vi.fn(() => Promise.resolve());
    const initialInput = {
      hasMore: true,
      pinnedAtUnixMs: 0,
      onToggleProjectPinned
    };
    const { rerender } = renderProjectSection(initialInput);
    const projectActionsButton = screen.getByRole("button", {
      name: "Project actions"
    });

    fireEvent.pointerDown(projectActionsButton, { button: 0, ctrlKey: false });
    const deleteItem = await screen.findByRole("menuitem", {
      name: "Delete sessions"
    });
    expect(deleteItem).not.toHaveAttribute("data-disabled");

    rerender(
      renderProjectSectionElement({
        ...initialInput,
        projectActionLocked: true,
        searchActive: true
      })
    );

    expect(projectActionsButton).toBeDisabled();
    expect(deleteItem).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitem", { name: "Pin project" })
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("menuitem", { name: "Remove project" })
    ).toHaveAttribute("data-disabled");
    expect(projectActionsButton).toBeDisabled();
    expect(projectActionsButton.isConnected).toBe(true);
  });

  it("restores native dragging after the presentation lock clears", () => {
    const onProjectDragStart = vi.fn();
    const initialInput = {
      pinnedAtUnixMs: 0,
      projectDragDisabled: true,
      onProjectDragStart,
      onToggleProjectPinned: vi.fn(() => Promise.resolve())
    };
    const { rerender } = renderProjectSection(initialInput);
    const section = screen.getByText("Alpha").closest("section");
    const header = section?.firstElementChild as HTMLElement;

    expect(header.draggable).toBe(false);
    rerender(
      renderProjectSectionElement({
        ...initialInput,
        projectDragDisabled: false
      })
    );

    const unlockedHeader = screen.getByText("Alpha").closest("section")
      ?.firstElementChild as HTMLElement;
    expect(unlockedHeader).toBe(header);
    expect(unlockedHeader.draggable).toBe(true);
    fireEvent.dragStart(unlockedHeader);
    expect(onProjectDragStart).toHaveBeenCalledTimes(1);
  });
});

function renderProjectSection(input: {
  hasMore?: boolean;
  pinnedAtUnixMs: number;
  searchActive?: boolean;
  sectionKind?: "conversations" | "project";
  projectActionLocked?: boolean;
  projectDragDisabled?: boolean;
  onCreateConversation?: (options?: {
    projectPath?: string | null;
    source?: string;
  }) => void;
  onProjectDragStart?: (event: React.DragEvent<HTMLElement>) => void;
  onProjectMenuOpenChange?: (open: boolean) => void;
  onToggleProjectPinned: (projectId: string, pinned: boolean) => Promise<void>;
}) {
  return render(renderProjectSectionElement(input));
}

function renderProjectSectionElement(input: {
  hasMore?: boolean;
  pinnedAtUnixMs: number;
  searchActive?: boolean;
  sectionKind?: "conversations" | "project";
  projectActionLocked?: boolean;
  projectDragDisabled?: boolean;
  onCreateConversation?: (options?: {
    projectPath?: string | null;
    source?: string;
  }) => void;
  onProjectDragStart?: (event: React.DragEvent<HTMLElement>) => void;
  onProjectMenuOpenChange?: (open: boolean) => void;
  onToggleProjectPinned: (projectId: string, pinned: boolean) => Promise<void>;
}) {
  return (
    <TooltipProvider>
      <AgentGUIConversationRailSectionPresentationProvider
        batchDeletionDisabled={
          (input.searchActive ?? false) || !(input.hasMore ?? false)
        }
        projectActionLocked={input.projectActionLocked ?? false}
        projectDragDisabled={input.projectDragDisabled ?? false}
      >
        <AgentGUIConversationRailSection
          activeConversation={null}
          activeConversationCountsTowardTotal={false}
          activeConversationId={null}
          createConversationDisabled={false}
          isDeletingConversation={false}
          isLoadingMoreConversations={false}
          isProjectActionLocked={() => input.projectActionLocked ?? false}
          isRailInteractionLocked={() => false}
          isSectionCollapsed={false}
          labels={LABELS}
          pendingDeleteConversationId={null}
          projectDragging={false}
          projectDropIndicator={null}
          projectLabel={input.sectionKind === "conversations" ? "" : "Alpha"}
          projectPath={input.sectionKind === "conversations" ? "" : "/alpha"}
          registerItemElement={() => {}}
          section={{
            id:
              input.sectionKind === "conversations"
                ? "conversations"
                : "project:/alpha",
            items: [],
            kind: input.sectionKind ?? "project",
            label:
              input.sectionKind === "conversations" ? "Conversations" : "Alpha",
            project:
              input.sectionKind === "conversations"
                ? null
                : {
                    id: "alpha",
                    label: "Alpha",
                    path: "/alpha",
                    pinnedAtUnixMs: input.pinnedAtUnixMs,
                    sectionKey: "project:/alpha"
                  }
          }}
          sectionHasMore={input.hasMore ?? false}
          sectionTotalCount={input.hasMore ? 1 : 0}
          uiLanguage="en"
          visibleItemLimit={5}
          workspaceId="workspace-1"
          onCancelDeleteConversation={() => {}}
          onConfirmDeleteConversation={() => {}}
          onCreateConversation={input.onCreateConversation ?? (() => {})}
          onLoadMoreConversations={() => {}}
          onMarkConversationUnread={() => {}}
          onOpenProjectFiles={() => {}}
          onProjectDragEnd={() => {}}
          onProjectDragOver={() => {}}
          onProjectDragStart={(_, event) => input.onProjectDragStart?.(event)}
          onProjectMenuOpenChange={(_, open) =>
            input.onProjectMenuOpenChange?.(open)
          }
          onRequestDeleteConversation={() => {}}
          onRequestRenameConversation={() => {}}
          onRequestSectionBatchDeletion={() => {}}
          onSelectConversation={() => {}}
          onToggleConversationPinned={() => {}}
          onToggleProjectPinned={input.onToggleProjectPinned}
          onToggleProjectSectionCollapsed={() => {}}
          onVisibleItemLimitChange={() => {}}
          setPendingProjectAction={() => {}}
        />
      </AgentGUIConversationRailSectionPresentationProvider>
    </TooltipProvider>
  );
}

const LABELS = {
  batchDeleteProjectSessions: "Delete sessions",
  emptyProjectConversations: "No sessions",
  newConversation: "New session",
  pinProject: "Pin project",
  pinnedProjectAccessibleName: (label: string) => `Pinned project: ${label}`,
  projectSectionEdit: "New session",
  projectSectionMoreActions: "Project actions",
  projectSectionViewFiles: "Open folder",
  removeProject: "Remove project",
  showLessConversations: "Show less",
  showMoreConversations: "Show more",
  unpinProject: "Unpin project"
} as AgentGUIViewLabels;
