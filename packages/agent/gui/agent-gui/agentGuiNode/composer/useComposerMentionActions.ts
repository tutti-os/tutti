import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from "react";
import {
  createMentionPaletteStateAdapter,
  makeAtPanelKeyDown
} from "@tutti-os/ui-rich-text/at-panel";
import type {
  AgentComposerDraft,
  AgentGUIComposerSettingsVM
} from "../model/agentGuiNodeTypes";
import type { AgentRichTextEditorHandle } from "../agentRichText/AgentRichTextEditor";
import {
  exitAgentFileMentionSuggestion,
  type AgentContextMentionItem,
  type AgentFileMentionSuggestionState
} from "../agentRichText/agentFileMentionExtension";
import { isAgentRichTextImeComposing } from "../agentRichText/agentRichTextIme";
import { AGENT_MENTION_FILTER_TAB_ORDER } from "../agentMentionSearchHelpers";
import { agentMentionItemKey } from "../AgentFileMentionPalette";
import { MENTION_PALETTE_DISMISS_INTERACTION_SELECTOR } from "./AgentComposerChrome";
import { updateAgentComposerDraft } from "../model/agentComposerDraft";
import {
  type AgentMentionFilterId,
  type AgentMentionGroupId,
  type AgentMentionSearchState,
  AgentMentionSearchController
} from "../AgentMentionSearchController";

interface Input {
  workspaceId: string;
  currentUserId?: string | null;
  selectedProjectPath: string;
  draftContent: AgentComposerDraft;
  fileMentionSuggestion: AgentFileMentionSuggestionState | null;
  setFileMentionSuggestion: Dispatch<
    SetStateAction<AgentFileMentionSuggestionState | null>
  >;
  mentionControllerRef: RefObject<AgentMentionSearchController | null>;
  editorHandleRef: RefObject<AgentRichTextEditorHandle | null>;
  draftPromptRef: RefObject<string>;
  setPaletteDraftPrompt: Dispatch<SetStateAction<string>>;
  setIsPaletteOpen: Dispatch<SetStateAction<boolean>>;
  onDraftContentChange: (draft: AgentComposerDraft) => void;
  showFileMentionPalette: boolean;
  mentionHighlightedKey: string | null;
  mentionSearchState: AgentMentionSearchState;
  setMentionHighlightedKey: Dispatch<SetStateAction<string | null>>;
  setShouldCenterMentionHighlight: Dispatch<SetStateAction<boolean>>;
  setShouldResetMentionHighlightToFilter: Dispatch<SetStateAction<boolean>>;
  autoMentionHighlightedKeyRef: RefObject<string | null>;
  composerSettings: AgentGUIComposerSettingsVM;
  isSendingTurn: boolean;
  isSubmittingPrompt: boolean;
  showStopButton: boolean;
  onSettingsChange: (settings: { planMode?: boolean }) => void;
  handleSlashPaletteKeyDown: (event: KeyboardEvent) => boolean;
  handleSlashCommandMenuKeyDown: (event: KeyboardEvent) => boolean;
  showPalette: boolean;
  workspaceReferencePickerOpen: boolean;
  composerRef: RefObject<HTMLFormElement | null>;
  paletteContentRef: RefObject<HTMLDivElement | null>;
  shouldCenterMentionHighlight: boolean;
}

function useStableEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

export function useComposerMentionActions(input: Input) {
  const {
    workspaceId,
    currentUserId,
    selectedProjectPath,
    draftContent,
    fileMentionSuggestion,
    setFileMentionSuggestion,
    mentionControllerRef,
    editorHandleRef,
    draftPromptRef,
    setPaletteDraftPrompt,
    setIsPaletteOpen,
    onDraftContentChange,
    showFileMentionPalette,
    mentionHighlightedKey,
    mentionSearchState,
    setMentionHighlightedKey,
    setShouldCenterMentionHighlight,
    setShouldResetMentionHighlightToFilter,
    autoMentionHighlightedKeyRef,
    composerSettings,
    isSendingTurn,
    isSubmittingPrompt,
    showStopButton,
    onSettingsChange,
    handleSlashPaletteKeyDown,
    handleSlashCommandMenuKeyDown,
    showPalette,
    workspaceReferencePickerOpen,
    composerRef,
    paletteContentRef,
    shouldCenterMentionHighlight
  } = input;
  const selectFileMention = useCallback(
    (entry: AgentContextMentionItem): void => {
      if (
        entry.kind === "file" &&
        entry.mentionNavigation === "agent-generated-folder-back" &&
        mentionControllerRef.current?.selectAgentGeneratedMentionItem(entry)
      ) {
        return;
      }
      fileMentionSuggestion?.command(entry);
      if (fileMentionSuggestion) {
        exitAgentFileMentionSuggestion(fileMentionSuggestion.editor);
      }
      mentionControllerRef.current?.close();
      setFileMentionSuggestion(null);
      setIsPaletteOpen(false);
    },
    [fileMentionSuggestion]
  );

  const closeFileMentionPalette = useCallback((): void => {
    if (fileMentionSuggestion) {
      exitAgentFileMentionSuggestion(fileMentionSuggestion.editor);
    }
    mentionControllerRef.current?.close();
    setFileMentionSuggestion(null);
    setIsPaletteOpen(false);
  }, [fileMentionSuggestion]);

  const clearActiveFileMentionTrigger = useCallback((): void => {
    if (!fileMentionSuggestion) {
      return;
    }
    const triggerLength = Math.max(
      fileMentionSuggestion.range.to - fileMentionSuggestion.range.from,
      fileMentionSuggestion.text.length
    );
    const nextDraft =
      triggerLength > 0
        ? editorHandleRef.current?.replaceTextBeforeSelection(triggerLength, "")
        : null;
    if (nextDraft === null || nextDraft === undefined) {
      return;
    }
    draftPromptRef.current = nextDraft;
    setPaletteDraftPrompt(nextDraft);
    onDraftContentChange(
      updateAgentComposerDraft(draftContent, { prompt: nextDraft })
    );
  }, [draftContent, fileMentionSuggestion, onDraftContentChange]);
  const closeOpenPalette = useCallback((): void => {
    if (showFileMentionPalette) {
      closeFileMentionPalette();
      return;
    }
    setIsPaletteOpen(false);
  }, [closeFileMentionPalette, showFileMentionPalette]);

  const createFileMentionPaletteAdapter = useCallback(
    (highlightedKey: string | null = mentionHighlightedKey) =>
      createMentionPaletteStateAdapter({
        state: mentionSearchState,
        highlightedKey,
        categoryCycleOrder:
          mentionSearchState.mode === "browse"
            ? mentionSearchState.categories
            : AGENT_MENTION_FILTER_TAB_ORDER,
        getItemKey: agentMentionItemKey,
        callbacks: {
          onHighlightChange: (key) => {
            setShouldCenterMentionHighlight(true);
            autoMentionHighlightedKeyRef.current = null;
            setMentionHighlightedKey(key);
          },
          onActiveCategoryIdChange: (categoryId) => {
            mentionControllerRef.current?.setFilter(
              categoryId as AgentMentionFilterId
            );
            setShouldResetMentionHighlightToFilter(true);
            setShouldCenterMentionHighlight(false);
          },
          onExpandGroup: (groupId) => {
            mentionControllerRef.current?.expandGroup(
              groupId as AgentMentionGroupId
            );
          },
          onSelectItem: selectFileMention
        }
      }),
    [mentionHighlightedKey, mentionSearchState, selectFileMention]
  );

  const moveFileMentionSelection = useCallback(
    (delta: 1 | -1): void => {
      createFileMentionPaletteAdapter().moveSelection(delta);
    },
    [createFileMentionPaletteAdapter]
  );

  const handleMentionHighlightChange = useCallback((key: string): void => {
    autoMentionHighlightedKeyRef.current = null;
    setMentionHighlightedKey(key);
  }, []);

  const cycleFileMentionFilter = useCallback(
    (delta: 1 | -1 = 1): void => {
      createFileMentionPaletteAdapter().cycleCategory(delta);
    },
    [createFileMentionPaletteAdapter]
  );

  const navigateFileMentionHierarchy = useCallback(
    (delta: 1 | -1): boolean => {
      if (delta === -1) {
        return (
          mentionControllerRef.current?.exitAgentGeneratedBrowse() ?? false
        );
      }
      const item = createFileMentionPaletteAdapter().selectedItem;
      if (!item || item.kind !== "file") {
        return false;
      }
      if (item.mentionNavigation !== "agent-generated-folder") {
        return false;
      }
      return (
        mentionControllerRef.current?.selectAgentGeneratedMentionItem(item) ??
        false
      );
    },
    [createFileMentionPaletteAdapter]
  );

  const navigateIntoFileMentionItem = useCallback(
    (item: AgentContextMentionItem): void => {
      mentionControllerRef.current?.selectAgentGeneratedMentionItem(item);
    },
    []
  );

  const handleFileMentionKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!showFileMentionPalette) {
        return false;
      }
      return makeAtPanelKeyDown({
        close: closeFileMentionPalette,
        commitSelection: () => {
          // No highlighted/committable entry (e.g. the search has zero
          // results): Enter has nothing to select, so treat it as
          // dismissing the empty panel instead of a silent no-op. This
          // matches Escape's behavior and mirrors the "clear the active
          // mention context" contract — a second Enter afterwards then
          // falls through to the normal submit handler.
          const result = createFileMentionPaletteAdapter().commitHighlighted();
          if (result.type === "none") {
            closeFileMentionPalette();
          }
        },
        cycleFilter: cycleFileMentionFilter,
        moveSelection: moveFileMentionSelection,
        navigateHierarchy: navigateFileMentionHierarchy
      })(event);
    },
    [
      closeFileMentionPalette,
      createFileMentionPaletteAdapter,
      cycleFileMentionFilter,
      moveFileMentionSelection,
      navigateFileMentionHierarchy,
      showFileMentionPalette
    ]
  );

  // Shift+Tab toggles descriptor-advertised plan mode.
  const handlePlanModeToggleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (
        event.key !== "Tab" ||
        !event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return false;
      }
      if (
        !composerSettings.supportsPlanMode ||
        isSendingTurn ||
        isSubmittingPrompt ||
        showStopButton ||
        composerSettings.isSettingsLoading
      ) {
        return false;
      }
      event.preventDefault();
      onSettingsChange({ planMode: !composerSettings.draftSettings.planMode });
      return true;
    },
    [
      composerSettings.draftSettings.planMode,
      composerSettings.isSettingsLoading,
      composerSettings.supportsPlanMode,
      onSettingsChange,
      isSendingTurn,
      isSubmittingPrompt,
      showStopButton
    ]
  );

  const handlePaletteKeyDown = useStableEventCallback(
    (event: KeyboardEvent): boolean =>
      handleFileMentionKeyDown(event) ||
      handleSlashPaletteKeyDown(event) ||
      handleSlashCommandMenuKeyDown(event) ||
      handlePlanModeToggleKeyDown(event)
  );

  useEffect(() => {
    if (!showPalette || workspaceReferencePickerOpen) {
      return;
    }
    const handleDocumentKeyDown = (event: KeyboardEvent): void => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof Node)) {
        return;
      }
      const isComposerEvent =
        composerRef.current?.contains(eventTarget) ?? false;
      const isPaletteEvent =
        paletteContentRef.current?.contains(eventTarget) ?? false;
      if (!isComposerEvent && !isPaletteEvent) {
        return;
      }
      if (isAgentRichTextImeComposing(event)) {
        return;
      }
      if (handlePaletteKeyDown(event)) {
        event.stopPropagation();
      }
    };

    document.addEventListener("keydown", handleDocumentKeyDown, {
      capture: true
    });
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown, {
        capture: true
      });
    };
  }, [handlePaletteKeyDown, showPalette, workspaceReferencePickerOpen]);

  const handleFileMentionSuggestionChange = useCallback(
    (state: AgentFileMentionSuggestionState | null): void => {
      setFileMentionSuggestion(state);
      if (!state) {
        mentionControllerRef.current?.close();
        return;
      }
      setIsPaletteOpen(true);
      mentionControllerRef.current?.updateQuery({
        workspaceId,
        currentUserId,
        query: state.query,
        sessionCwd: selectedProjectPath || null
      });
    },
    [currentUserId, selectedProjectPath, workspaceId]
  );

  useEffect(() => {
    if (!showFileMentionPalette && shouldCenterMentionHighlight) {
      setShouldCenterMentionHighlight(false);
    }
  }, [shouldCenterMentionHighlight, showFileMentionPalette]);

  useEffect(() => {
    if (!showFileMentionPalette) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (target.closest(MENTION_PALETTE_DISMISS_INTERACTION_SELECTOR)) {
        closeOpenPalette();
      }
    };
    const handleWindowResize = (): void => {
      closeOpenPalette();
    };

    document.addEventListener("pointerdown", handlePointerDown, {
      capture: true
    });
    window.addEventListener("resize", handleWindowResize);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, {
        capture: true
      });
      window.removeEventListener("resize", handleWindowResize);
    };
  }, [closeOpenPalette, showFileMentionPalette]);

  return {
    clearActiveFileMentionTrigger,
    closeFileMentionPalette,
    cycleFileMentionFilter,
    handleFileMentionSuggestionChange,
    handleFileMentionKeyDown,
    handlePaletteKeyDown,
    handleMentionHighlightChange,
    moveFileMentionSelection,
    navigateFileMentionHierarchy,
    navigateIntoFileMentionItem,
    selectFileMention
  };
}
