import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentComposerDraft,
  AgentComposerDraftFile,
  AgentComposerDraftImage,
  AgentComposerDraftLargeText
} from "./model/agentGuiNodeTypes";
import { repairMentionPaletteHighlight } from "@tutti-os/ui-rich-text/at-panel";
import { clampSlashCommandHighlight } from "./model/agentSlashCommands";
import type { AgentRichTextEditorHandle } from "./agentRichText/AgentRichTextEditor";
import {
  agentMentionItemKey,
  isAgentMentionItemDisabled
} from "./AgentFileMentionPalette";
import { type AgentFileMentionSuggestionState } from "./agentRichText/agentFileMentionExtension";
import { formatSlashStatusTokenCount } from "./AgentSlashStatusPanel";
import { useOptionalAgentGUIRuntime } from "../../agentActivityRuntime";
import { useComposerDraftAttachments } from "./composer/useComposerDraftAttachments";
import { goalDraftObjectiveFromPrompt } from "./composer/composerDraftUtils";
import {
  INITIAL_DOCK_COMPOSER_METRICS,
  useComposerLayout
} from "./composer/useComposerLayout";
import { useComposerPaletteCatalog } from "./composer/useComposerPaletteCatalog";
import { useMentionPaletteFrame } from "./composer/useMentionPaletteFrame";
import { useComposerSlashActions } from "./composer/useComposerSlashActions";
import { useComposerMentionActions } from "./composer/useComposerMentionActions";
import { useComposerProviderTargets } from "./composer/useComposerProviderTargets";
import { useComposerFocusAndDrop } from "./composer/useComposerFocusAndDrop";
import { useComposerPresentation } from "./composer/useComposerPresentation";
import { AgentComposerView } from "./composer/AgentComposerView";
import {
  EMPTY_PROMPT_TIPS,
  EMPTY_PROVIDER_SKILLS
} from "./composer/AgentComposerChrome";
import { useAgentMentionSearchController } from "./composer/useAgentMentionSearchController";
import { useAgentQuickPromptLibrary } from "./composer/quickPrompts/useAgentQuickPromptLibrary";
import { useScopedProjectMissingState } from "./composer/useScopedProjectMissingState";
import type { AgentComposerProps } from "./composer/AgentComposer.types";
import { withAgentComposerTuttiModeSnapshot } from "./composer/agentComposerSubmitOptions";
import {
  agentComposerDraftAttachmentProjection,
  agentComposerDraftFiles,
  agentComposerDraftImages,
  agentComposerDraftLargeTexts,
  agentComposerDraftHasContent,
  agentComposerDraftPrompt
} from "./model/agentComposerDraft";
import type { AgentGUIComposerContentType } from "./engagement/agentGUIEngagement.types";
import { projectAgentGUIComposerGateControls } from "./model/agentGuiComposerGate";
import {
  groupAgentExternalPromptEntryInsertions,
  resolveAgentExternalPromptEntries
} from "./model/agentExternalPromptEntries";
import { useComposerInputHistory } from "./composer/useComposerInputHistory";

export { formatSlashStatusTokenCount };

/**
 * 引用 picker 的确认结果:松散文件按 file mention 插入;mentionItems(如文件夹 bundle)
 * 作为整体节点插入。两者各走各的插入路径,composer 不需要理解 bundle 内部结构。
 */
export type { WorkspaceReferencePickResult } from "./composer/useComposerDraftAttachments";
export type {
  AgentComposerCapabilityMenuState,
  AgentComposerCapabilitySettingsTarget,
  AgentComposerComputerUseAuthorizationState,
  AgentComposerGitBranchLoader,
  AgentComposerGitBranches,
  AgentComposerPromptTip,
  AgentComposerReferenceProvenanceFilter,
  AgentComposerReferenceProvenanceFilters,
  AgentComposerProps,
  AgentComposerSlashStatus,
  AgentComposerSlashStatusLimit,
  AgentComposerSubmitOptions,
  AgentComposerTuttiModeSubmitSnapshot,
  AgentComposerUsage
} from "./composer/AgentComposer.types";
import { useSessionWorktreeLaunch } from "./composer/useSessionWorktreeLaunch";

export function AgentComposer(props: AgentComposerProps): React.JSX.Element {
  "use memo";
  const {
    workspaceId,
    agentSessionId = null,
    workspacePath,
    currentUserId,
    provider,
    slashStatus = null,
    draftContent,
    engagement,
    draftScopeKey = "current",
    inputHistory = [],
    inputHistoryHasOlderPage = false,
    inputHistoryIsLoadingOlderPage = false,
    onRequestOlderInputHistoryPage,
    availableCommands,
    hasCompactableContext = true,
    compactSupported = null,
    availableSkills = EMPTY_PROVIDER_SKILLS,
    gate,
    presentationEditorDisabled,
    disabledReason,
    presentationSubmitDisabled,
    tuttiModeActive = false,
    tuttiModeUpdating = false,
    tuttiModeEffect = 50,
    tuttiModeSpeed = 50,
    placeholder,
    composerSettings,
    selectedAgentTarget = null,
    agentTargets = [],
    handoffAgentTargets,
    providerSelectReadonly = false,
    onHandoffConversation,
    showStopButton,
    activeTurnId = null,
    draftOverridesStopButton = false,
    stopDisabled,
    activePrompt,
    promptTips = EMPTY_PROMPT_TIPS,
    isInterrupting,
    isSendingTurn,
    isSubmittingPrompt,
    projectMissingProbeEnabled = true,
    uiLanguage = "en",
    isActive = true,
    workspaceReferencePickerOpen = false,
    promptImagesSupported = true,
    canGoalControl = true,
    canUploadAttachment = true,
    composerFocusRequestSequence = null,
    layoutMode = "dock",
    menuViewportTopInset = 8,
    handoffLabel,
    handoffMenuLabel,
    labels,
    onDraftContentChange,
    onSettingsChange,
    onTuttiModeChange = () => {},
    onTuttiModeEffectChange = () => {},
    onTuttiModeSpeedChange = () => {},
    capabilityMenuState,
    capabilityControlsReadOnly = false,
    onSubmit,
    onSubmitEmpty,
    emptySubmitLabel,
    onSubmitGuidance,
    onInterruptCurrentTurn,
    onPromptImagesUnsupported,
    onSubmitInteractivePrompt,
    onCapabilitySettingsRequest,
    onRetryComposerOptions,
    onSlashStatusOpen,
    onLinkAction,
    onRequestWorkspaceReferences = null,
    resolveExternalPromptEntries = null,
    prepareExternalPromptFiles = null,
    promptAssetLimit = null,
    onRequestGitBranches = null,
    referenceProvenanceFilters = null
  } = props;
  const capabilitiesRequestedKeyRef = useRef<string | null>(null);
  const requestCapabilitiesForDraft = useCallback(
    (nextDraft: AgentComposerDraft): void => {
      if (!onRetryComposerOptions) {
        return;
      }
      const nextPrompt = agentComposerDraftPrompt(nextDraft).trimStart();
      if (!nextPrompt.startsWith("/")) {
        return;
      }
      const requestKey = `${provider}:${agentSessionId ?? "draft"}`;
      if (capabilitiesRequestedKeyRef.current === requestKey) {
        return;
      }
      capabilitiesRequestedKeyRef.current = requestKey;
      onRetryComposerOptions({ section: "capabilities" });
    },
    [agentSessionId, onRetryComposerOptions, provider]
  );
  const handleDraftContentChange: AgentComposerProps["onDraftContentChange"] =
    useCallback(
      (nextDraft, sourceScopeKey) => {
        requestCapabilitiesForDraft(nextDraft);
        onDraftContentChange(nextDraft, sourceScopeKey);
      },
      [onDraftContentChange, requestCapabilitiesForDraft]
    );
  const {
    canQueueWhileBusy,
    editorDisabled: disabled,
    submissionDisabled: submitDisabled
  } = projectAgentGUIComposerGateControls({
    gate,
    presentationEditorDisabled,
    presentationSubmitDisabled
  });
  const draftPrompt = agentComposerDraftPrompt(draftContent);
  const goalDraftObjective = canGoalControl
    ? goalDraftObjectiveFromPrompt(draftPrompt)
    : null;
  const isGoalModeActive = goalDraftObjective !== null;
  const {
    images: draftImages,
    files: draftFiles,
    largeTexts: draftLargeTexts
  } = agentComposerDraftAttachmentProjection(draftContent);
  const agentActivityRuntime = useOptionalAgentGUIRuntime();
  const promptFilesSupported = Boolean(
    canUploadAttachment && prepareExternalPromptFiles
  );
  const externalPromptEntriesSupported = Boolean(
    resolveExternalPromptEntries || promptFilesSupported
  );
  const pastedTextStagingSupported = Boolean(
    canUploadAttachment && agentActivityRuntime?.stagePastedText
  );
  const reportContentEntered = (
    contentType: AgentGUIComposerContentType
  ): void => {
    engagement?.contentEntered({
      contentType,
      hadPrefill: agentComposerDraftHasContent(draftContent)
    });
  };
  const [isPaletteOpen, setIsPaletteOpen] = useState(true);
  const [isReviewPickerOpen, setIsReviewPickerOpen] = useState(false);
  const submitGuidanceWithComposerModifiers: NonNullable<
    AgentComposerProps["onSubmitGuidance"]
  > = (content, displayPrompt) => {
    onSubmitGuidance?.(
      content,
      displayPrompt,
      tuttiModeActive
        ? {
            capabilityRefs: [{ capability: "tutti", source: "slash_command" }]
          }
        : undefined
    );
  };
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [mentionHighlightedKey, setMentionHighlightedKey] = useState<
    string | null
  >(null);
  const [shouldCenterMentionHighlight, setShouldCenterMentionHighlight] =
    useState(false);
  const [
    shouldResetMentionHighlightToFilter,
    setShouldResetMentionHighlightToFilter
  ] = useState(false);
  const [paletteDraftPrompt, setPaletteDraftPrompt] = useState(
    goalDraftObjective ?? draftPrompt
  );
  const [fileMentionSuggestion, setFileMentionSuggestion] =
    useState<AgentFileMentionSuggestionState | null>(null);
  const selectedProjectPath =
    composerSettings.selectedProjectPath?.trim() ?? "";
  const [isSelectedProjectMissing, setIsSelectedProjectMissing] =
    useScopedProjectMissingState(selectedProjectPath);
  const [isSlashStatusPanelOpen, setIsSlashStatusPanelOpen] = useState(false);
  const selectedProjectSectionKey =
    composerSettings.selectedProjectSectionKey?.trim() ?? "";
  const sessionWorktreeLaunch = useSessionWorktreeLaunch({
    agentSessionId: props.agentSessionId,
    enabled:
      props.sessionWorktreeEnabled &&
      Boolean(
        props.labels.sessionLaunchModeLabel &&
        props.labels.sessionLaunchModeLocal &&
        props.labels.sessionLaunchModeWorktree
      ),
    mode: props.sessionLaunchMode,
    onModeChange: props.onSessionLaunchModeChange,
    projectSectionKey: selectedProjectSectionKey,
    selectedAgentTarget: props.selectedAgentTarget,
    selectedProjectPath
  });
  const submitWithComposerModifiers: AgentComposerProps["onSubmit"] = (
    content,
    displayPrompt,
    options
  ) => {
    onSubmit(
      content,
      displayPrompt,
      withAgentComposerTuttiModeSnapshot({
        options:
          sessionWorktreeLaunch.mode === "worktree"
            ? { ...options, isolation: "worktree" }
            : options,
        active: tuttiModeActive,
        effect: tuttiModeEffect,
        speed: tuttiModeSpeed
      })
    );
  };
  const slashStatusAgentSessionId = slashStatus?.agentSessionId ?? null;
  const previousSlashStatusAgentSessionIdRef = useRef<string | null>(
    slashStatusAgentSessionId
  );
  const previousSelectedProjectPathRef = useRef(selectedProjectPath);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const inputShellRef = useRef<HTMLDivElement | null>(null);
  const promptInputAreaRef = useRef<HTMLDivElement | null>(null);
  const paletteContentRef = useRef<HTMLDivElement | null>(null);
  const draftPromptRef = useRef(draftPrompt);
  const draftImagesRef = useRef<AgentComposerDraftImage[]>(draftImages);
  const draftFilesRef = useRef<AgentComposerDraftFile[]>(draftFiles);
  const draftLargeTextsRef =
    useRef<AgentComposerDraftLargeText[]>(draftLargeTexts);
  const draftByScopeKeyRef = useRef<Record<string, AgentComposerDraft>>({
    [draftScopeKey]: draftContent
  });
  draftByScopeKeyRef.current[draftScopeKey] = draftContent;
  const {
    disposeInputHistory,
    onHistoryNavigation,
    settlePendingInputHistory
  } = useComposerInputHistory({
    agentSessionId,
    currentDraft: draftContent,
    draftByScopeKeyRef,
    draftScopeKey,
    entries: inputHistory,
    hasOlderPage: inputHistoryHasOlderPage,
    isLoadingOlderPage: inputHistoryIsLoadingOlderPage,
    onDraftContentChange: handleDraftContentChange,
    onRequestOlderPage: onRequestOlderInputHistoryPage,
    runtime: agentActivityRuntime,
    workspaceId
  });
  const promptTipRef = useRef<HTMLSpanElement | null>(null);
  const { mentionControllerRef, mentionSearchState } =
    useAgentMentionSearchController(referenceProvenanceFilters);
  const editorHandleRef = useRef<AgentRichTextEditorHandle | null>(null);
  const wasActiveRef = useRef(isActive);
  const lastComposerFocusRequestRef = useRef<number | null>(null);
  const autoMentionHighlightedKeyRef = useRef<string | null>(null);
  const [isPromptTipOverflowing, setIsPromptTipOverflowing] = useState(false);
  const [dockComposerMetrics, setDockComposerMetrics] = useState(
    INITIAL_DOCK_COMPOSER_METRICS
  );
  const paletteCatalog = useComposerPaletteCatalog({
    provider,
    isGoalModeActive,
    goalSupported: canGoalControl,
    paletteDraftPrompt,
    availableCommands,
    availableSkills,
    hasCompactableContext,
    compactSupported,
    composerSettings,
    capabilityMenuState,
    capabilityControlsReadOnly,
    labels,
    uiLanguage,
    editorHandleRef
  });
  const {
    filteredSkills,
    resolvedSlashCommands,
    skillQueryMatch,
    slashPaletteEntries,
    slashQuery,
    slashCommandPolicy,
    promptBeforeSelection
  } = paletteCatalog;
  const showFileMentionPalette =
    !disabled && isActive && isPaletteOpen && fileMentionSuggestion !== null;
  const showSlashPalette =
    !showFileMentionPalette &&
    !disabled &&
    isActive &&
    isPaletteOpen &&
    ((slashQuery !== null &&
      (slashPaletteEntries.length > 0 ||
        composerSettings.isCapabilityOptionsLoading === true)) ||
      (slashQuery === null &&
        skillQueryMatch !== null &&
        filteredSkills.length > 0));
  const showPalette = showFileMentionPalette || showSlashPalette;
  const showCommandMenuPanel = isSlashStatusPanelOpen || isReviewPickerOpen;
  const showFloatingCommandMenu = showSlashPalette || showCommandMenuPanel;
  const activeHighlight = clampSlashCommandHighlight(
    highlightedIndex,
    slashPaletteEntries.length
  );
  const mentionFrame = useMentionPaletteFrame(
    inputShellRef,
    showFileMentionPalette,
    menuViewportTopInset
  );

  useEffect(() => {
    setHighlightedIndex(0);
  }, [skillQueryMatch?.prefix, skillQueryMatch?.query, slashQuery]);

  useEffect(() => {
    const preferredKey =
      shouldResetMentionHighlightToFilter &&
      mentionSearchState.mode === "browse"
        ? `category:${mentionSearchState.filter}`
        : null;
    if (shouldResetMentionHighlightToFilter) {
      const nextKey = repairMentionPaletteHighlight({
        state: mentionSearchState,
        currentKey: null,
        preferredKey,
        getItemKey: agentMentionItemKey,
        isItemDisabled: isAgentMentionItemDisabled
      });
      autoMentionHighlightedKeyRef.current = nextKey;
      setMentionHighlightedKey(nextKey);
      setShouldResetMentionHighlightToFilter(false);
      return;
    }
    setMentionHighlightedKey((current) => {
      const nextKey = repairMentionPaletteHighlight({
        state: mentionSearchState,
        currentKey: current,
        getItemKey: agentMentionItemKey,
        isItemDisabled: isAgentMentionItemDisabled
      });
      if (
        nextKey === current &&
        current !== autoMentionHighlightedKeyRef.current
      ) {
        return current;
      }
      autoMentionHighlightedKeyRef.current = nextKey;
      return nextKey;
    });
  }, [
    mentionSearchState.filter,
    mentionSearchState.mode,
    mentionSearchState,
    shouldResetMentionHighlightToFilter
  ]);

  useEffect(() => {
    draftImagesRef.current = agentComposerDraftImages(draftContent);
    draftFilesRef.current = agentComposerDraftFiles(draftContent);
    draftLargeTextsRef.current = agentComposerDraftLargeTexts(draftContent);
    const isExternalDraftReplacement = draftPromptRef.current !== draftPrompt;
    draftPromptRef.current = draftPrompt;
    setPaletteDraftPrompt(goalDraftObjective ?? draftPrompt);
    settlePendingInputHistory();
    if (isExternalDraftReplacement && draftPrompt) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          // Prefer end so continued typing (and shared home drafts after a
          // project switch) keep the caret after the text, not at the start.
          editorHandleRef.current?.focusAtEnd();
        });
      });
    }
  }, [
    draftContent,
    draftPrompt,
    goalDraftObjective,
    settlePendingInputHistory
  ]);

  useEffect(() => {
    if (
      previousSlashStatusAgentSessionIdRef.current === slashStatusAgentSessionId
    ) {
      return disposeInputHistory;
    }
    previousSlashStatusAgentSessionIdRef.current = slashStatusAgentSessionId;
    setIsSlashStatusPanelOpen(false);
    return disposeInputHistory;
  }, [disposeInputHistory, draftScopeKey, slashStatusAgentSessionId]);

  const slashActions = useComposerSlashActions({
    workspaceId,
    provider,
    disabled,
    submitDisabled,
    canQueueWhileBusy,
    isSendingTurn,
    isSubmittingPrompt,
    showStopButton,
    promptImagesSupported: canUploadAttachment && promptImagesSupported,
    availableSkills,
    composerSettings,
    // Host-gated product capability: omit or enabled:false must hide /tutti.
    // Fail closed like other unsupported host capabilities — do not treat a
    // missing flag as enabled.
    tuttiModeSupported: capabilityMenuState?.tuttiMode?.enabled === true,
    capabilityControlsReadOnly,
    onDraftContentChange: handleDraftContentChange,
    onSettingsChange,
    onSubmit: submitWithComposerModifiers,
    onSubmitEmpty,
    onSubmitGuidance: submitGuidanceWithComposerModifiers,
    onCapabilitySettingsRequest,
    onSlashStatusOpen,
    onPromptImagesUnsupported,
    onRequestGitBranches,
    onTuttiModeActivate: () => onTuttiModeChange(true),
    draftContent,
    selectedProjectPath,
    slashStatusAgentSessionId,
    isSlashStatusPanelOpen,
    slashCommandPolicy,
    skillQueryMatch,
    promptBeforeSelection,
    resolvedSlashCommands,
    slashPaletteEntries,
    activeHighlight,
    showSlashPalette,
    showCommandMenuPanel,
    isSelectedProjectMissing,
    editorHandleRef,
    draftPromptRef,
    draftImagesRef,
    draftFilesRef,
    draftLargeTextsRef,
    setPaletteDraftPrompt,
    setIsPaletteOpen,
    setIsReviewPickerOpen,
    setIsSlashStatusPanelOpen,
    setHighlightedIndex
  });
  const {
    composerControlsHardDisabled,
    handleSlashCommandMenuKeyDown,
    handleSlashPaletteKeyDown
  } = slashActions;
  const mentionActions = useComposerMentionActions({
    workspaceId,
    currentUserId,
    selectedProjectPath,
    selectedProjectSectionKey,
    draftContent,
    fileMentionSuggestion,
    setFileMentionSuggestion,
    mentionControllerRef,
    editorHandleRef,
    draftPromptRef,
    setPaletteDraftPrompt,
    setIsPaletteOpen,
    onDraftContentChange: handleDraftContentChange,
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
    isActive,
    onSettingsChange,
    handleSlashPaletteKeyDown,
    handleSlashCommandMenuKeyDown,
    showPalette,
    workspaceReferencePickerOpen,
    composerRef,
    paletteContentRef,
    shouldCenterMentionHighlight
  });
  const { clearActiveFileMentionTrigger } = mentionActions;

  const attachments = useComposerDraftAttachments({
    workspaceId,
    workspacePath,
    draftContent,
    draftScopeKey,
    draftByScopeKeyRef,
    goalDraftObjective,
    isGoalModeActive,
    promptImagesSupported: canUploadAttachment && promptImagesSupported,
    promptFilesSupported,
    promptAssetLimit,
    pastedTextStagingSupported,
    editorHandleRef,
    draftPromptRef,
    draftImagesRef,
    draftFilesRef,
    draftLargeTextsRef,
    setPaletteDraftPrompt,
    setIsPaletteOpen,
    clearActiveFileMentionTrigger,
    onDraftContentChange: handleDraftContentChange,
    onPromptImagesUnsupported,
    onContentEntered: reportContentEntered,
    onRequestWorkspaceReferences,
    prepareExternalPromptFiles,
    onLinkAction
  });
  const { addDraftFiles, addDraftImages } = attachments;
  const addExternalPromptEntries = useCallback(
    (files: readonly File[]): void => {
      const entries = resolveAgentExternalPromptEntries(
        files,
        resolveExternalPromptEntries
      );
      for (const insertion of groupAgentExternalPromptEntryInsertions(
        entries
      )) {
        if (insertion.disposition === "prepare") {
          addDraftFiles(insertion.files);
        } else {
          editorHandleRef.current?.insertWorkspaceReferences([
            insertion.reference
          ]);
        }
      }
    },
    [addDraftFiles, editorHandleRef, resolveExternalPromptEntries]
  );

  const providerState = useComposerProviderTargets({
    layoutMode,
    provider,
    agentTargets,
    handoffAgentTargets,
    selectedAgentTarget,
    providerSelectReadonly,
    composerControlsHardDisabled,
    isSelectedProjectMissing,
    disabled,
    onHandoffConversation,
    handoffLabel,
    handoffMenuLabel,
    defaultHandoffLabel: labels.handoffConversation,
    defaultHandoffMenuLabel: labels.handoffConversationMenu
  });
  const { inputDisabled, isHeroLayout } = providerState;
  const closeQuickPromptCompetingDisclosure = useCallback((): void => {
    mentionActions.closeFileMentionPalette();
    slashActions.closeSlashFloatingMenu();
  }, [mentionActions, slashActions]);
  const insertQuickPrompt = useCallback((content: string): boolean => {
    return editorHandleRef.current?.insertPlainTextAtSelection(content) != null;
  }, []);
  const quickPromptLibrary = useAgentQuickPromptLibrary({
    disabled: composerControlsHardDisabled || inputDisabled,
    labels: labels.quickPrompts,
    onBeforeOpen: closeQuickPromptCompetingDisclosure,
    onInsertPrompt: insertQuickPrompt,
    onQuickPromptPanelOpened: () => engagement?.quickPromptPanelOpened?.(),
    onQuickPromptUsed: (promptType) => engagement?.quickPromptUsed?.(promptType)
  });
  const restoreComposerCaretAfterProjectMenu = (event: Event): void => {
    event.preventDefault();
    if (inputDisabled) {
      return;
    }
    editorHandleRef.current?.focusAtEnd();
  };
  const focusAndDrop = useComposerFocusAndDrop({
    composerControlsHardDisabled,
    inputDisabled,
    editorHandleRef,
    composerRef,
    wasActiveRef,
    lastComposerFocusRequestRef,
    isActive,
    composerFocusRequestSequence,
    promptFilesSupported: externalPromptEntriesSupported,
    promptImagesSupported: canUploadAttachment && promptImagesSupported,
    addDraftImages,
    addDraftFiles: addExternalPromptEntries,
    onPromptImagesUnsupported
  });
  const { fileDropOverlayActive, fileDropOverlayHost } = focusAndDrop;
  const layout = useComposerLayout({
    isActive,
    isDockLayout: layoutMode === "dock",
    isHeroLayout,
    inputDisabled,
    projectMissingProbeEnabled,
    showFileMentionPalette,
    showFloatingCommandMenu,
    promptTips,
    promptTipsPrefix: labels.promptTipsPrefix,
    composerSettings,
    selectedProjectPath,
    promptTipRef,
    promptInputAreaRef,
    setIsPromptTipOverflowing,
    dockComposerMetrics,
    setDockComposerMetrics,
    draftImages,
    draftLargeTexts
  });
  const { activePromptTip, promptTipStyle, rotatingPromptTips } = layout;
  const presentation = useComposerPresentation({
    draftContent,
    canQueueWhileBusy,
    showStopButton,
    activeTurnId,
    draftOverridesStopButton,
    stopDisabled,
    isInterrupting,
    isSendingTurn,
    activePrompt,
    disabledReason,
    placeholder,
    selectedProjectPath,
    selectedProjectSectionKey,
    previousSelectedProjectPathRef,
    setIsSelectedProjectMissing,
    fileMentionSuggestion,
    mentionControllerRef,
    workspaceId,
    currentUserId,
    onSubmitInteractivePrompt,
    onInterruptCurrentTurn,
    isSelectedProjectMissing,
    submitDisabled,
    allowEmptySubmit: onSubmitEmpty !== undefined,
    emptySubmitLabel,
    labels,
    activePromptTip,
    promptTipRef,
    promptTips,
    promptTipStyle,
    rotatingPromptTips,
    fileDropOverlayHost,
    fileDropOverlayActive,
    canUploadAttachment,
    promptImagesSupported
  });
  return (
    <AgentComposerView
      props={props}
      paletteCatalog={paletteCatalog}
      mentionFrame={mentionFrame}
      slashActions={slashActions}
      mentionActions={mentionActions}
      attachments={attachments}
      providerState={providerState}
      focusAndDrop={focusAndDrop}
      layout={layout}
      presentation={presentation}
      composerRef={composerRef}
      inputShellRef={inputShellRef}
      promptInputAreaRef={promptInputAreaRef}
      paletteContentRef={paletteContentRef}
      promptTipRef={promptTipRef}
      editorHandleRef={editorHandleRef}
      mentionControllerRef={mentionControllerRef}
      externalPromptEntriesSupported={externalPromptEntriesSupported}
      addExternalPromptEntries={addExternalPromptEntries}
      onDismissProjectMenuAutoFocus={restoreComposerCaretAfterProjectMenu}
      paletteDraftPrompt={paletteDraftPrompt}
      showFileMentionPalette={showFileMentionPalette}
      showSlashPalette={showSlashPalette}
      activeHighlight={activeHighlight}
      mentionSearchState={mentionSearchState}
      quickPromptLibrary={quickPromptLibrary}
      mentionHighlightedKey={mentionHighlightedKey}
      shouldCenterMentionHighlight={shouldCenterMentionHighlight}
      isSlashStatusPanelOpen={isSlashStatusPanelOpen}
      isReviewPickerOpen={isReviewPickerOpen}
      isSelectedProjectMissing={isSelectedProjectMissing}
      setIsSelectedProjectMissing={setIsSelectedProjectMissing}
      setIsPaletteOpen={setIsPaletteOpen}
      setHighlightedIndex={setHighlightedIndex}
      isGoalModeActive={isGoalModeActive}
      isPlanModeActive={composerSettings.draftSettings.planMode}
      isTuttiModeActive={tuttiModeActive}
      isTuttiModeUpdating={tuttiModeUpdating}
      tuttiModeEffect={tuttiModeEffect}
      tuttiModeSpeed={tuttiModeSpeed}
      onClearPlanMode={() => onSettingsChange({ planMode: false })}
      onClearTuttiMode={() => onTuttiModeChange(false)}
      onTuttiModeEffectChange={onTuttiModeEffectChange}
      onTuttiModeSpeedChange={onTuttiModeSpeedChange}
      isPromptTipOverflowing={isPromptTipOverflowing}
      onHistoryNavigation={onHistoryNavigation}
      sessionWorktreeLaunch={sessionWorktreeLaunch}
    />
  );
}
