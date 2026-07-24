import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationSection } from "../agentGuiNodeViewConversation";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { AgentGUIConversationRailSection } from "./AgentGUIConversationRailSection";
import { AgentGUIConversationRailSectionPresentationProvider } from "./agentGUIConversationRailSectionPresentationContext";

const { headerRenderSpy } = vi.hoisted(() => ({
  headerRenderSpy: vi.fn()
}));

vi.mock("./AgentGUIConversationRailSectionHeader", async () => {
  const { memo } = await vi.importActual<typeof import("react")>("react");
  return {
    AgentGUIConversationRailSectionHeader: memo((props: unknown) => {
      headerRenderSpy(props);
      return <div data-testid="section-header" />;
    })
  };
});

vi.mock("./AgentGUIConversationRailItem", () => ({
  AgentGUIConversationRailItem: () => <div data-testid="section-item" />
}));

describe("AgentGUIConversationRailSection render budget", () => {
  afterEach(() => {
    headerRenderSpy.mockReset();
    requestSectionBatchDeletion.mockReset();
  });

  it("does not rerender stable header chrome when item data changes", () => {
    const firstSection = createSection("session-1", "First");
    const nextSection = createSection("session-2", "Second");
    const { rerender } = renderSection(firstSection);
    const retainedHeaderAction = (
      headerRenderSpy.mock.calls[0]![0] as {
        onRequestBatchDeletion: () => void;
      }
    ).onRequestBatchDeletion;

    expect(headerRenderSpy).toHaveBeenCalledTimes(1);
    rerender(renderSectionElement(nextSection));
    retainedHeaderAction();

    expect(headerRenderSpy).toHaveBeenCalledTimes(1);
    expect(requestSectionBatchDeletion).toHaveBeenCalledWith(nextSection);

    rerender(
      renderSectionElement({
        ...nextSection,
        items: []
      })
    );

    expect(headerRenderSpy).toHaveBeenCalledTimes(1);
  });

  it("does not execute item projection when presentation locks change", () => {
    const section = createSection("session-1", "First");
    const filterSpy = vi.spyOn(section.items, "filter");
    const { rerender } = renderSection(section);
    const initialFilterCalls = filterSpy.mock.calls.length;

    rerender(
      renderSectionElement(section, {
        batchDeletionDisabled: true,
        projectActionLocked: true,
        projectDragDisabled: true
      })
    );

    expect(filterSpy).toHaveBeenCalledTimes(initialFilterCalls);
  });
});

function renderSection(section: ConversationSection) {
  return render(renderSectionElement(section));
}

function renderSectionElement(
  section: ConversationSection,
  presentation: {
    batchDeletionDisabled?: boolean;
    projectActionLocked?: boolean;
    projectDragDisabled?: boolean;
  } = {}
) {
  return (
    <AgentGUIConversationRailSectionPresentationProvider
      batchDeletionDisabled={presentation.batchDeletionDisabled ?? false}
      projectActionLocked={presentation.projectActionLocked ?? false}
      projectDragDisabled={presentation.projectDragDisabled ?? false}
    >
      <AgentGUIConversationRailSection
        activeConversation={null}
        activeConversationCountsTowardTotal={false}
        activeConversationId={section.items[0]?.id ?? null}
        createConversationDisabled={false}
        isDeletingConversation={false}
        isLoadingMoreConversations={false}
        isProjectActionLocked={isUnlocked}
        isRailInteractionLocked={isUnlocked}
        isSectionCollapsed={false}
        labels={LABELS}
        pendingDeleteConversationId={null}
        projectDragging={false}
        projectDropIndicator={null}
        projectLabel="Alpha"
        projectPath="/alpha"
        registerItemElement={noop}
        section={section}
        sectionHasMore={false}
        sectionTotalCount={1}
        uiLanguage="en"
        visibleItemLimit={5}
        workspaceId="workspace-1"
        onCancelDeleteConversation={noop}
        onConfirmDeleteConversation={noop}
        onCreateConversation={noop}
        onLoadMoreConversations={noop}
        onMarkConversationUnread={noop}
        onOpenProjectFiles={noop}
        onProjectDragEnd={noop}
        onProjectDragOver={noop}
        onProjectDragStart={noop}
        onProjectMenuOpenChange={noop}
        onRequestDeleteConversation={noop}
        onRequestRenameConversation={noop}
        onRequestSectionBatchDeletion={requestSectionBatchDeletion}
        onSelectConversation={noop}
        onToggleConversationPinned={noop}
        onToggleProjectPinned={toggleProjectPinned}
        onToggleProjectSectionCollapsed={noop}
        onVisibleItemLimitChange={noop}
        setPendingProjectAction={noop}
      />
    </AgentGUIConversationRailSectionPresentationProvider>
  );
}

function createSection(id: string, title: string): ConversationSection {
  return {
    id: "project:/alpha",
    items: [
      {
        cwd: "/alpha",
        id,
        provider: "codex",
        status: "ready",
        title,
        updatedAtUnixMs: 1
      }
    ],
    kind: "project",
    label: "Alpha",
    project: {
      id: "alpha",
      label: "Alpha",
      path: "/alpha",
      pinnedAtUnixMs: 0,
      sectionKey: "project:/alpha"
    }
  };
}

const noop = () => {};
const isUnlocked = () => false;
const requestSectionBatchDeletion = vi.fn();
const toggleProjectPinned = () => Promise.resolve();
const LABELS = {
  emptyProjectConversations: "No sessions",
  newConversation: "New session",
  projectSectionEdit: "New session",
  showLessConversations: "Show less",
  showMoreConversations: "Show more"
} as AgentGUIViewLabels;
