import { useEffect, useRef, useState, type HTMLAttributes } from "react";
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
  AgentMentionSearchController,
  type AgentMentionSearchState
} from "./AgentMentionSearchController";
import {
  agentMentionItemKey,
  isAgentMentionItemDisabled
} from "./AgentFileMentionPalette";
import { DEFAULT_AGENT_MENTION_FILTER } from "./agentMentionSearchHelpers";
import { type AgentFileMentionSuggestionState } from "./agentRichText/agentFileMentionExtension";
import { formatSlashStatusTokenCount } from "./AgentSlashStatusPanel";
import { useOptionalAgentActivityRuntime } from "../../agentActivityRuntime";
import { useOptionalAgentHostApi } from "../../agentActivityHost";
import { useComposerDraftAttachments } from "./composer/useComposerDraftAttachments";
import { goalDraftObjectiveFromPrompt } from "./composer/composerDraftUtils";
import { useComposerLayout } from "./composer/useComposerLayout";
import { useComposerPaletteCatalog } from "./composer/useComposerPaletteCatalog";
import { useMentionPaletteFrame } from "./composer/useMentionPaletteFrame";
import { useComposerSlashActions } from "./composer/useComposerSlashActions";
import { useComposerMentionActions } from "./composer/useComposerMentionActions";
import { useComposerProviderTargets } from "./composer/useComposerProviderTargets";
import { useComposerFocusAndDrop } from "./composer/useComposerFocusAndDrop";
import { useComposerPresentation } from "./composer/useComposerPresentation";
import { AgentComposerView } from "./composer/AgentComposerView";
import {
  EMPTY_CONTEXT_MENTION_PROVIDERS,
  EMPTY_PROMPT_TIPS,
  EMPTY_PROVIDER_SKILLS
} from "./composer/AgentComposerChrome";
import type { AgentComposerProps } from "./composer/AgentComposer.types";
import {
  agentComposerDraftAttachmentProjection,
  agentComposerDraftFiles,
  agentComposerDraftImages,
  agentComposerDraftLargeTexts,
  agentComposerDraftHasContent,
  agentComposerDraftPrompt
} from "./model/agentComposerDraft";
import type { AgentGUIComposerContentType } from "./engagement/agentGUIEngagement.types";

export { formatSlashStatusTokenCount };

type DotLottieElementProps = HTMLAttributes<HTMLElement> & {
  autoplay?: boolean;
  loop?: boolean;
  src?: string;
};

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "dotlottie-wc": DotLottieElementProps;
    }
  }
}

const DOCK_COMPOSER_INPUT_MIN_HEIGHT = 56;
const DOCK_COMPOSER_TEXT_LINE_HEIGHT = 24;
const DOCK_COMPOSER_MAX_VISIBLE_TEXT_LINES = 3.5;
const DOCK_COMPOSER_INPUT_TEXT_CHROME_HEIGHT = 26;
const DOCK_COMPOSER_TEXT_VIEWPORT_MAX_HEIGHT =
  DOCK_COMPOSER_TEXT_LINE_HEIGHT * DOCK_COMPOSER_MAX_VISIBLE_TEXT_LINES;
const DOCK_COMPOSER_INPUT_MAX_HEIGHT =
  DOCK_COMPOSER_INPUT_TEXT_CHROME_HEIGHT +
  DOCK_COMPOSER_TEXT_VIEWPORT_MAX_HEIGHT;
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
  AgentComposerProps,
  AgentComposerSlashStatus,
  AgentComposerSlashStatusLimit,
  AgentComposerSubmitOptions,
  AgentComposerUsage
} from "./composer/AgentComposer.types";

export function AgentComposer(props: AgentComposerProps): React.JSX.Element {
  "use memo";
  const {
    workspaceId,
    workspacePath,
    currentUserId,
    provider,
    slashStatus = null,
    draftContent,
    engagement,
    draftScopeKey = "current",
    availableCommands,
    hasCompactableContext = true,
    compactSupported = null,
    availableSkills = EMPTY_PROVIDER_SKILLS,
    disabled,
    disabledReason,
    submitDisabled,
    placeholder,
    composerSettings,
    selectedAgentTarget = null,
    agentTargets = [],
    handoffAgentTargets,
    providerSelectReadonly = false,
    onHandoffConversation,
    canQueueWhileBusy,
    showStopButton,
    activePrompt,
    promptTips = EMPTY_PROMPT_TIPS,
    isInterrupting,
    isSendingTurn,
    isSubmittingPrompt,
    uiLanguage = "en",
    isActive = true,
    previewMode = false,
    workspaceReferencePickerOpen = false,
    promptImagesSupported = true,
    canGoalControl = true,
    canUploadAttachment = true,
    composerFocusRequestSequence = null,
    layoutMode = "dock",
    handoffLabel,
    handoffMenuLabel,
    labels,
    onDraftContentChange,
    onSettingsChange,
    capabilityMenuState,
    onSubmit,
    onSubmitGuidance,
    onInterruptCurrentTurn,
    onPromptImagesUnsupported,
    onSubmitInteractivePrompt,
    onCapabilitySettingsRequest,
    onSlashStatusOpen,
    onLinkAction,
    onRequestWorkspaceReferences = null,
    resolveDroppedFileReferences = null,
    onRequestGitBranches = null,
    contextMentionProviders = EMPTY_CONTEXT_MENTION_PROVIDERS,
    referenceProvenanceFilter = null
  } = props;
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
  const agentActivityRuntime = useOptionalAgentActivityRuntime();
  const agentHostApi = useOptionalAgentHostApi();
  const getReferenceForFile = agentHostApi?.workspace.getReferenceForFile;
  const promptFileUploadSupported = Boolean(
    canUploadAttachment &&
    agentActivityRuntime?.uploadPromptContent &&
    (agentActivityRuntime.promptContentUploadSupport?.file ?? true)
  );
  const promptFilesSupported = Boolean(
    resolveDroppedFileReferences && promptFileUploadSupported
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
  const [isHandoffIconPlaying, setIsHandoffIconPlaying] = useState(false);
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
  const [isSelectedProjectMissing, setIsSelectedProjectMissing] =
    useState(false);
  const [isSlashStatusPanelOpen, setIsSlashStatusPanelOpen] = useState(false);
  const slashStatusAgentSessionId = slashStatus?.agentSessionId ?? null;
  const previousSlashStatusAgentSessionIdRef = useRef<string | null>(
    slashStatusAgentSessionId
  );
  const selectedProjectPath =
    composerSettings.selectedProjectPath?.trim() ?? "";
  const selectedProjectSectionKey =
    composerSettings.selectedProjectSectionKey?.trim() ?? "";
  const previousSelectedProjectPathRef = useRef(selectedProjectPath);
  const [mentionSearchState, setMentionSearchState] =
    useState<AgentMentionSearchState>({
      status: "idle",
      query: "",
      mode: "browse",
      filter: DEFAULT_AGENT_MENTION_FILTER,
      categories: [],
      groups: [],
      error: null
    });
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
  const promptTipRef = useRef<HTMLSpanElement | null>(null);
  const mentionControllerRef = useRef<AgentMentionSearchController | null>(
    null
  );
  const editorHandleRef = useRef<AgentRichTextEditorHandle | null>(null);
  const wasActiveRef = useRef(isActive);
  const lastComposerFocusRequestRef = useRef<number | null>(null);
  const autoMentionHighlightedKeyRef = useRef<string | null>(null);
  const [isPromptTipOverflowing, setIsPromptTipOverflowing] = useState(false);
  const [dockComposerInputHeight, setDockComposerInputHeight] = useState(
    DOCK_COMPOSER_INPUT_MIN_HEIGHT
  );
  const [dockComposerInputMaxHeight, setDockComposerInputMaxHeight] = useState(
    DOCK_COMPOSER_INPUT_MAX_HEIGHT
  );
  const [dockComposerAttachmentHeight, setDockComposerAttachmentHeight] =
    useState(0);
  const [dockComposerTextHeight, setDockComposerTextHeight] = useState(
    DOCK_COMPOSER_INPUT_MIN_HEIGHT
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
    !disabled && isPaletteOpen && fileMentionSuggestion !== null;
  const showSlashPalette =
    !showFileMentionPalette &&
    !disabled &&
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
    showFileMentionPalette
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
    const controller = new AgentMentionSearchController({
      contextMentionProviders
    });
    controller.setProvenanceCatalog(
      referenceProvenanceFilter?.snapshot.catalog ?? null
    );
    // A provider replacement creates a fresh controller, so seed it with the
    // filter captured by the same render before exposing it through the ref.
    controller.setProvenanceFilter(
      referenceProvenanceFilter?.snapshot.value ?? null
    );
    mentionControllerRef.current = controller;
    const unsubscribe = controller.subscribe(setMentionSearchState);
    return () => {
      unsubscribe();
      controller.dispose();
      mentionControllerRef.current = null;
    };
  }, [contextMentionProviders]);

  useEffect(() => {
    draftImagesRef.current = agentComposerDraftImages(draftContent);
    draftFilesRef.current = agentComposerDraftFiles(draftContent);
    draftLargeTextsRef.current = agentComposerDraftLargeTexts(draftContent);
    const isExternalDraftReplacement = draftPromptRef.current !== draftPrompt;
    draftPromptRef.current = draftPrompt;
    setPaletteDraftPrompt(goalDraftObjective ?? draftPrompt);
    if (isExternalDraftReplacement && draftPrompt) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          // Prefer end so continued typing (and shared home drafts after a
          // project switch) keep the caret after the text, not at the start.
          editorHandleRef.current?.focusAtEnd();
        });
      });
    }
  }, [draftContent, draftPrompt, goalDraftObjective]);

  useEffect(() => {
    mentionControllerRef.current?.setProvenanceCatalog(
      referenceProvenanceFilter?.snapshot.catalog ?? null
    );
    mentionControllerRef.current?.setProvenanceFilter(
      referenceProvenanceFilter?.snapshot.value ?? null
    );
  }, [
    referenceProvenanceFilter?.snapshot.catalog,
    referenceProvenanceFilter?.snapshot.value
  ]);

  useEffect(() => {
    if (
      previousSlashStatusAgentSessionIdRef.current === slashStatusAgentSessionId
    ) {
      return;
    }
    previousSlashStatusAgentSessionIdRef.current = slashStatusAgentSessionId;
    setIsSlashStatusPanelOpen(false);
  }, [slashStatusAgentSessionId]);

  const slashActions = useComposerSlashActions({
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
    onDraftContentChange,
    onSettingsChange,
    onSubmit,
    onSubmitGuidance,
    onCapabilitySettingsRequest,
    onSlashStatusOpen,
    onPromptImagesUnsupported,
    onRequestGitBranches,
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
    promptFileUploadSupported,
    promptFilesSupported,
    pastedTextStagingSupported,
    editorHandleRef,
    draftPromptRef,
    draftImagesRef,
    draftFilesRef,
    draftLargeTextsRef,
    setPaletteDraftPrompt,
    setIsPaletteOpen,
    clearActiveFileMentionTrigger,
    onDraftContentChange,
    onPromptImagesUnsupported,
    onContentEntered: reportContentEntered,
    onRequestWorkspaceReferences,
    resolveDroppedFileReferences,
    onLinkAction
  });
  const { addDraftImages, applyDroppedFileReferences } = attachments;

  const providerState = useComposerProviderTargets({
    layoutMode,
    previewMode,
    provider,
    agentTargets,
    handoffAgentTargets,
    selectedAgentTarget,
    providerSelectReadonly,
    composerControlsHardDisabled,
    isSelectedProjectMissing,
    disabled,
    canQueueWhileBusy,
    onHandoffConversation,
    handoffLabel,
    handoffMenuLabel,
    defaultHandoffLabel: labels.handoffConversation,
    defaultHandoffMenuLabel: labels.handoffConversationMenu
  });
  const { inputDisabled, isHeroLayout } = providerState;
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
    promptFilesSupported,
    promptImagesSupported: canUploadAttachment && promptImagesSupported,
    addDraftImages,
    applyDroppedFileReferences,
    onPromptImagesUnsupported
  });
  const { fileDropOverlayActive, fileDropOverlayHost } = focusAndDrop;
  const layout = useComposerLayout({
    isHeroLayout,
    inputDisabled,
    paletteDraftPrompt,
    showFileMentionPalette,
    showFloatingCommandMenu,
    previewMode,
    promptTips,
    promptTipsPrefix: labels.promptTipsPrefix,
    composerSettings,
    selectedProjectPath,
    promptTipRef,
    promptInputAreaRef,
    isPromptTipOverflowing,
    setIsPromptTipOverflowing,
    dockComposerInputHeight,
    setDockComposerInputHeight,
    dockComposerInputMaxHeight,
    setDockComposerInputMaxHeight,
    dockComposerAttachmentHeight,
    setDockComposerAttachmentHeight,
    dockComposerTextHeight,
    setDockComposerTextHeight,
    draftImages,
    draftFiles,
    draftLargeTexts
  });
  const { activePromptTip, promptTipStyle, rotatingPromptTips } = layout;
  const presentation = useComposerPresentation({
    draftContent,
    canQueueWhileBusy,
    showStopButton,
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
      getReferenceForFile={getReferenceForFile}
      promptFilesSupported={promptFilesSupported}
      onDismissProjectMenuAutoFocus={restoreComposerCaretAfterProjectMenu}
      paletteDraftPrompt={paletteDraftPrompt}
      showFileMentionPalette={showFileMentionPalette}
      showSlashPalette={showSlashPalette}
      activeHighlight={activeHighlight}
      mentionSearchState={mentionSearchState}
      mentionHighlightedKey={mentionHighlightedKey}
      shouldCenterMentionHighlight={shouldCenterMentionHighlight}
      isSlashStatusPanelOpen={isSlashStatusPanelOpen}
      isReviewPickerOpen={isReviewPickerOpen}
      isSelectedProjectMissing={isSelectedProjectMissing}
      setIsSelectedProjectMissing={setIsSelectedProjectMissing}
      setIsPaletteOpen={setIsPaletteOpen}
      setHighlightedIndex={setHighlightedIndex}
      isHandoffIconPlaying={isHandoffIconPlaying}
      setIsHandoffIconPlaying={setIsHandoffIconPlaying}
      isGoalModeActive={isGoalModeActive}
      isPromptTipOverflowing={isPromptTipOverflowing}
    />
  );
}
