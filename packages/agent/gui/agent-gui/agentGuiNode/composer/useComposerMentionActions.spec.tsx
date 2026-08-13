import { act, renderHook } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import type { AgentRichTextEditorHandle } from "../agentRichText/AgentRichTextEditor";
import type { AgentContextMentionItem } from "../agentRichText/agentFileMentionExtension";
import { buildAgentComposerDraft } from "../model/agentComposerDraft";
import { useComposerMentionActions } from "./useComposerMentionActions";

describe("useComposerMentionActions directory navigation", () => {
  it("clears the editor query before entering a searched workspace folder", () => {
    const calls: string[] = [];
    const replaceTextBeforeSelection = vi.fn(() => {
      calls.push("replace");
      return "@";
    });
    const updateQuery = vi.fn(() => calls.push("update"));
    const selectFileMentionNavigationItem = vi.fn(() => {
      calls.push("select");
      return true;
    });
    const input = createInput({
      replaceTextBeforeSelection,
      selectFileMentionNavigationItem,
      updateQuery
    });
    const { result } = renderHook(() => useComposerMentionActions(input));

    act(() => {
      expect(result.current.navigateIntoFileMentionItem(folderItem)).toBe(true);
    });

    expect(replaceTextBeforeSelection).toHaveBeenCalledWith(4, "@");
    expect(updateQuery).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      currentUserId: "user-1",
      query: "",
      sectionKey: "section-1",
      sessionCwd: "C:/workspace"
    });
    expect(selectFileMentionNavigationItem).toHaveBeenCalledWith(folderItem);
    expect(calls).toEqual(["replace", "update", "select"]);
  });

  it("does not navigate when the active editor query cannot be replaced", () => {
    const selectFileMentionNavigationItem = vi.fn(() => true);
    const updateQuery = vi.fn();
    const input = createInput({
      replaceTextBeforeSelection: vi.fn(() => null),
      selectFileMentionNavigationItem,
      updateQuery
    });
    const { result } = renderHook(() => useComposerMentionActions(input));

    act(() => {
      expect(result.current.navigateIntoFileMentionItem(folderItem)).toBe(
        false
      );
    });

    expect(updateQuery).not.toHaveBeenCalled();
    expect(selectFileMentionNavigationItem).not.toHaveBeenCalled();
  });
});

const folderItem: AgentContextMentionItem = {
  kind: "file",
  path: "/workspace/src",
  href: "/workspace/src",
  name: "src",
  entryKind: "directory",
  directoryPath: "/workspace",
  mentionNavigation: "workspace-folder"
};

function createInput(mocks: {
  replaceTextBeforeSelection: AgentRichTextEditorHandle["replaceTextBeforeSelection"];
  selectFileMentionNavigationItem: (item: AgentContextMentionItem) => boolean;
  updateQuery: (input: unknown) => void;
}): Parameters<typeof useComposerMentionActions>[0] {
  const draftContent = buildAgentComposerDraft({ prompt: "@src" });
  return {
    workspaceId: "workspace-1",
    currentUserId: "user-1",
    selectedProjectPath: "C:/workspace",
    selectedProjectSectionKey: "section-1",
    draftContent,
    fileMentionSuggestion: {
      editor: {} as Editor,
      range: { from: 1, to: 5 },
      query: "src",
      text: "@src",
      command: vi.fn()
    },
    setFileMentionSuggestion: vi.fn(),
    mentionControllerRef: {
      current: {
        updateQuery: mocks.updateQuery,
        selectFileMentionNavigationItem: mocks.selectFileMentionNavigationItem
      }
    },
    editorHandleRef: {
      current: {
        replaceTextBeforeSelection: mocks.replaceTextBeforeSelection
      } as AgentRichTextEditorHandle
    },
    draftPromptRef: { current: "@src" },
    setPaletteDraftPrompt: vi.fn(),
    setIsPaletteOpen: vi.fn(),
    onDraftContentChange: vi.fn(),
    showFileMentionPalette: false,
    mentionHighlightedKey: null,
    mentionSearchState: {
      status: "ready",
      query: "src",
      mode: "results",
      filter: "file",
      categories: [],
      groups: [],
      error: null
    },
    setMentionHighlightedKey: vi.fn(),
    setShouldCenterMentionHighlight: vi.fn(),
    setShouldResetMentionHighlightToFilter: vi.fn(),
    autoMentionHighlightedKeyRef: { current: null },
    composerSettings: {
      draftSettings: { planMode: false },
      supportsPlanMode: false,
      isSettingsLoading: false
    } as unknown as Parameters<
      typeof useComposerMentionActions
    >[0]["composerSettings"],
    isSendingTurn: false,
    isSubmittingPrompt: false,
    showStopButton: false,
    onSettingsChange: vi.fn(),
    handleSlashPaletteKeyDown: vi.fn(() => false),
    handleSlashCommandMenuKeyDown: vi.fn(() => false),
    showPalette: false,
    workspaceReferencePickerOpen: false,
    composerRef: { current: null },
    paletteContentRef: { current: null },
    shouldCenterMentionHighlight: false
  } as unknown as Parameters<typeof useComposerMentionActions>[0];
}
