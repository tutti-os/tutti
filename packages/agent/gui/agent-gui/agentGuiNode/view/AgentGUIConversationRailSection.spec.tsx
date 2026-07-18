import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@tutti-os/ui-system";
import { describe, expect, it, vi } from "vitest";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { AgentGUIConversationRailSection } from "./AgentGUIConversationRailSection";

describe("AgentGUIConversationRailSection project pin presentation", () => {
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
});

function renderProjectSection(input: {
  pinnedAtUnixMs: number;
  searchActive?: boolean;
  projectActionLocked?: boolean;
  onToggleProjectPinned: (projectId: string, pinned: boolean) => Promise<void>;
}) {
  return render(
    <TooltipProvider>
      <AgentGUIConversationRailSection
        activeConversation={null}
        activeConversationCountsTowardTotal={false}
        activeConversationId={null}
        createConversationDisabled={false}
        currentTimeMs={1}
        isConversationSearchActive={input.searchActive ?? false}
        isDeletingConversation={false}
        isDeletingProjectConversations={false}
        isLoadingMoreConversations={false}
        isProjectActionLocked={() => input.projectActionLocked ?? false}
        isRailInteractionLocked={() => false}
        isRequestingBatchDeletion={false}
        isSectionCollapsed={false}
        labels={LABELS}
        pendingDeleteConversationId={null}
        previewMode={false}
        projectDragDisabled={false}
        projectDragging={false}
        projectDropIndicator={null}
        projectLabel="Alpha"
        projectPath="/alpha"
        registerItemElement={() => {}}
        section={{
          id: "project:/alpha",
          items: [],
          kind: "project",
          label: "Alpha",
          project: {
            id: "alpha",
            label: "Alpha",
            path: "/alpha",
            pinnedAtUnixMs: input.pinnedAtUnixMs,
            sectionKey: "project:/alpha"
          }
        }}
        sectionHasMore={false}
        sectionTotalCount={0}
        uiLanguage="en"
        visibleItemLimit={5}
        workspaceId="workspace-1"
        onCancelDeleteConversation={() => {}}
        onConfirmDeleteConversation={() => {}}
        onCreateConversation={() => {}}
        onLoadMoreConversations={() => {}}
        onMarkConversationUnread={() => {}}
        onOpenProjectFiles={() => {}}
        onProjectDragEnd={() => {}}
        onProjectDragOver={() => {}}
        onProjectDragStart={() => {}}
        onProjectDrop={() => {}}
        onProjectMenuOpenChange={() => {}}
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
