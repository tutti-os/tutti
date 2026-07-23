import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from "react";
import { createPortal } from "react-dom";
import {
  Popover,
  PopoverAnchor,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@tutti-os/ui-system";
import { cn } from "../../../app/renderer/lib/utils";
import styles from "../AgentGUINode.styles";
import { AgentInteractivePromptSurface } from "../AgentInteractivePromptSurface";
import { AgentQueuedPromptPanel } from "../AgentQueuedPromptPanel";
import {
  AgentProjectDropdown,
  AgentProjectMissingStatusProbe
} from "../AgentComposerSettingsMenus";
import { AgentChromeNotice } from "../AgentSessionChrome";
import { AgentFullAccessRestoredWarning } from "../AgentFullAccessRestoredWarning";
import {
  AgentRichTextEditor,
  type AgentRichTextEditorHandle
} from "../agentRichText/AgentRichTextEditor";
import { AgentFileMentionPalette } from "../AgentFileMentionPalette";
import { AgentReferenceProvenanceFilterControl } from "../AgentReferenceProvenanceFilterControl";
import type { AgentMentionSearchController } from "../AgentMentionSearchController";
import { AgentSlashCommandPalette } from "../AgentSlashCommandPalette";
import { AgentSlashStatusPanel } from "../AgentSlashStatusPanel";
import { AgentReviewPickerPanel } from "../AgentReviewPickerPanel";
import { ComposerFloatingMenuSurface } from "../composerFloatingMenu/ComposerFloatingMenuSurface";
import type { AgentComposerProps } from "./AgentComposer.types";
import {
  EMPTY_PROVIDER_SKILLS,
  EMPTY_WORKSPACE_APP_ICONS,
  SLASH_PALETTE_HEIGHT_PX,
  composerStyles
} from "./AgentComposerChrome";
import { ComposerDraftAttachments } from "./ComposerDraftAttachments";
import { ComposerFooter } from "./ComposerFooter";
import type { useComposerDraftAttachments } from "./useComposerDraftAttachments";
import type { useComposerFocusAndDrop } from "./useComposerFocusAndDrop";
import type { useComposerLayout } from "./useComposerLayout";
import type { useComposerMentionActions } from "./useComposerMentionActions";
import type { useComposerPaletteCatalog } from "./useComposerPaletteCatalog";
import type { useComposerPresentation } from "./useComposerPresentation";
import type { useComposerProviderTargets } from "./useComposerProviderTargets";
import type { useComposerSlashActions } from "./useComposerSlashActions";
import type { useMentionPaletteFrame } from "./useMentionPaletteFrame";
import { AgentQuickPromptPopover } from "./quickPrompts/AgentQuickPromptPopover";
import type { useAgentQuickPromptLibrary } from "./quickPrompts/useAgentQuickPromptLibrary";
import {
  agentComposerDraftHasContent,
  agentComposerDraftImages,
  agentComposerDraftPrompt,
  updateAgentComposerDraft
} from "../model/agentComposerDraft";

interface Props {
  props: AgentComposerProps;
  paletteCatalog: ReturnType<typeof useComposerPaletteCatalog>;
  mentionFrame: ReturnType<typeof useMentionPaletteFrame>;
  slashActions: ReturnType<typeof useComposerSlashActions>;
  mentionActions: ReturnType<typeof useComposerMentionActions>;
  attachments: ReturnType<typeof useComposerDraftAttachments>;
  providerState: ReturnType<typeof useComposerProviderTargets>;
  focusAndDrop: ReturnType<typeof useComposerFocusAndDrop>;
  layout: ReturnType<typeof useComposerLayout>;
  presentation: ReturnType<typeof useComposerPresentation>;
  composerRef: RefObject<HTMLFormElement | null>;
  inputShellRef: RefObject<HTMLDivElement | null>;
  promptInputAreaRef: RefObject<HTMLDivElement | null>;
  paletteContentRef: RefObject<HTMLDivElement | null>;
  promptTipRef: RefObject<HTMLSpanElement | null>;
  editorHandleRef: RefObject<AgentRichTextEditorHandle | null>;
  mentionControllerRef: MutableRefObject<AgentMentionSearchController | null>;
  externalPromptEntriesSupported: boolean;
  addExternalPromptEntries: (files: readonly File[]) => void;
  onDismissProjectMenuAutoFocus?: (event: Event) => void;
  paletteDraftPrompt: string;
  showFileMentionPalette: boolean;
  showSlashPalette: boolean;
  activeHighlight: number;
  mentionSearchState: Parameters<typeof AgentFileMentionPalette>[0]["state"];
  quickPromptLibrary: ReturnType<typeof useAgentQuickPromptLibrary>;
  mentionHighlightedKey: string | null;
  shouldCenterMentionHighlight: boolean;
  isSlashStatusPanelOpen: boolean;
  isReviewPickerOpen: boolean;
  isSelectedProjectMissing: boolean;
  setIsSelectedProjectMissing: (value: boolean) => void;
  setIsPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setHighlightedIndex: Dispatch<SetStateAction<number>>;
  isGoalModeActive: boolean;
  isPlanModeActive: boolean;
  isTuttiModeActive: boolean;
  isTuttiModeUpdating: boolean;
  tuttiModeOrchestrationIntensity: number;
  onClearPlanMode: () => void;
  onClearTuttiMode: () => void;
  onTuttiModeOrchestrationIntensityChange: (value: number) => void;
  isPromptTipOverflowing: boolean;
}

export function AgentComposerView(input: Props): React.JSX.Element {
  const {
    provider,
    slashStatus = null,
    usage = null,
    draftContent,
    engagement,
    availableSkills = EMPTY_PROVIDER_SKILLS,
    composerSettings,
    workspaceId,
    queueStatus = "active",
    queuedPrompts,
    drainingQueuedPromptId,
    workspaceAppIcons = EMPTY_WORKSPACE_APP_ICONS,
    activePromptKeyboardShortcutsEnabled = true,
    promptImagesSupported = true,
    previewMode = false,
    layoutMode = "dock",
    providerSelectLabel = "",
    labels,
    workspaceUserProjectI18n,
    isSubmittingPrompt,
    onSendQueuedPromptNext,
    onRemoveQueuedPrompt,
    onEditQueuedPrompt,
    onPromptImagesUnsupported,
    onRequestWorkspaceReferences,
    referenceProvenanceFilter,
    selectProjectDirectory,
    onProjectPathChange = () => {},
    onSettingsChange,
    onLinkAction,
    onSubmit,
    onProviderSelect,
    onHandoffConversation,
    onSlashStatusRefresh,
    compactSupported = null,
    hasCompactableContext = true
  } = input.props;
  const draftImages = agentComposerDraftImages(draftContent);
  const slashStatusAgentSessionId = slashStatus?.agentSessionId ?? null;
  const draftPrompt = agentComposerDraftPrompt(draftContent);
  const { availableCapabilities, slashPaletteEntries, slashQuery } =
    input.paletteCatalog;
  const { mentionPaletteFrame, mentionPaletteHeightPx, mentionPaletteStyle } =
    input.mentionFrame;
  const {
    closeReviewPicker,
    closeSlashFloatingMenu,
    closeSlashStatusPanel,
    composerControlsHardDisabled,
    permissionModeControlsDisabled,
    reviewBranchLoader,
    selectCapability,
    selectCapabilitySettings,
    selectCommand,
    selectSkill,
    settingsControlsDisabled,
    submit,
    submitCurrentPrompt,
    submitReviewCommand
  } = input.slashActions;
  const {
    handleFileMentionSuggestionChange,
    handleFileMentionKeyDown,
    handlePaletteKeyDown,
    handleMentionHighlightChange,
    navigateFileMentionHierarchy,
    navigateIntoFileMentionItem,
    selectFileMention
  } = input.mentionActions;
  const {
    clearGoalModeBadge,
    expandDraftLargeTextToPrompt,
    handleDraftChange,
    handleLinkClick,
    handleOpenReferencesForEntity,
    handlePastedLargeText,
    handleWorkspaceReferencePicker,
    removeDraftImage,
    removeDraftLargeText
  } = input.attachments;
  const {
    composerClassName,
    effectiveHandoffLabel,
    effectiveHandoffMenuLabel,
    handoffDisabled,
    handoffMenuTargets,
    inputDisabled,
    inputShellClassName,
    isHeroLayout,
    providerMenuTargets,
    providerSelectDisabled,
    selectedProviderLabel,
    selectedProviderSwitchTarget,
    showHandoffSelect,
    showProviderSelect
  } = input.providerState;
  const { handleMentionPaletteButton, handlePastedImages } = input.focusAndDrop;
  const {
    activePromptTip,
    activePromptTipText,
    composerStyle,
    inputShellStyle,
    promptInputAreaStyle,
    showEdgeGlow,
    showHeroProjectSelector,
    showProjectMissingProbe,
    showProjectRow
  } = input.layout;
  const {
    composerActionButton,
    disabledReasonText,
    effectivePlaceholder,
    fileDropOverlay,
    promptTipNode,
    submitInteractivePromptAndDismiss,
    visibleActivePrompt,
    visibleDraftLargeTexts
  } = input.presentation;

  return (
    <form
      ref={input.composerRef}
      className={composerClassName}
      data-layout={layoutMode}
      style={composerStyle}
      onSubmit={submit}
    >
      {fileDropOverlay}
      {visibleActivePrompt ? (
        <div
          className={styles.composerFloatingPrompt}
          data-testid="agent-gui-composer-floating-prompt"
        >
          <AgentInteractivePromptSurface
            prompt={visibleActivePrompt}
            embedded={true}
            edgeGlow={true}
            keyboardShortcuts={activePromptKeyboardShortcutsEnabled}
            previewMode={previewMode}
            isSubmitting={isSubmittingPrompt}
            onSubmit={submitInteractivePromptAndDismiss}
            labels={{
              approvalLead: labels.approvalLead,
              fileChangeApprovalLead: labels.fileChangeApprovalLead,
              planLead: labels.planLead,
              planModes: labels.planModes,
              stayInPlan: labels.stayInPlan,
              sendFeedback: labels.sendFeedback,
              feedbackPlaceholder: labels.feedbackPlaceholder,
              previousQuestion: labels.previousQuestion,
              nextQuestion: labels.nextQuestion,
              submitAnswers: labels.submitAnswers,
              answerPlaceholder: labels.answerPlaceholder,
              waitingForAnswer: labels.waitingForAnswer,
              planImplementationLead: labels.planImplementationLead,
              planImplementationConfirm: labels.planImplementationConfirm,
              planImplementationFeedbackPlaceholder:
                labels.planImplementationFeedbackPlaceholder,
              planImplementationSend: labels.planImplementationSend,
              planImplementationSkip: labels.planImplementationSkip
            }}
          />
        </div>
      ) : null}
      {queuedPrompts.length > 0 ? (
        <div
          className={cn(
            styles.composerFloatingPrompt,
            styles.composerQueuedPromptFloating
          )}
          data-testid="agent-gui-composer-queued-prompts"
        >
          <AgentQueuedPromptPanel
            queueStatus={queueStatus}
            queuedPrompts={queuedPrompts}
            drainingQueuedPromptId={drainingQueuedPromptId}
            labels={{
              queuedLabel: labels.queuedLabel,
              queuePausedByUserLabel: labels.queuePausedByUserLabel,
              sendQueuedPromptNext: labels.sendQueuedPromptNext,
              editQueuedPrompt: labels.editQueuedPrompt,
              deleteQueuedPrompt: labels.deleteQueuedPrompt,
              queuedPromptMoreActions: labels.queuedPromptMoreActions
            }}
            onSendQueuedPromptNext={onSendQueuedPromptNext}
            onRemoveQueuedPrompt={onRemoveQueuedPrompt}
            onEditQueuedPrompt={onEditQueuedPrompt}
            agentSessionId={slashStatusAgentSessionId}
            onLinkClick={handleLinkClick}
            workspaceId={workspaceId}
            workspaceAppIcons={workspaceAppIcons}
          />
        </div>
      ) : null}
      {showProjectMissingProbe ? (
        <AgentProjectMissingStatusProbe
          composerSettings={composerSettings}
          onProjectMissingChange={input.setIsSelectedProjectMissing}
        />
      ) : null}
      <AgentFullAccessRestoredWarning
        isSettingsLoading={composerSettings.isSettingsLoading}
        permissionModeId={
          composerSettings.selectedPermissionModeValue ??
          composerSettings.draftSettings.permissionModeId
        }
        previewMode={previewMode}
        provider={provider}
        visibleOnHome={isHeroLayout}
      />
      <div
        className={cn(
          styles.composerInputGroup,
          layoutMode === "hero" && styles.composerInputGroupHero
        )}
        data-edge-glow={showEdgeGlow ? "true" : undefined}
      >
        {input.isSelectedProjectMissing ? (
          <AgentChromeNotice
            tone="danger"
            role="alert"
            testId="agent-gui-missing-project-notice"
            title={workspaceUserProjectI18n.tFirst([
              "projectSelect.projectMissingTitle"
            ])}
            description={labels.projectMissingDescription}
          />
        ) : null}
        <div
          ref={input.inputShellRef}
          className={cn(inputShellClassName, "relative")}
          data-testid="agent-gui-composer-input-shell"
          data-input-disabled={inputDisabled ? "true" : undefined}
          title={
            inputDisabled && disabledReasonText ? disabledReasonText : undefined
          }
          style={inputShellStyle}
        >
          <Popover
            open={input.showFileMentionPalette}
            onOpenChange={input.setIsPaletteOpen}
            modal={false}
          >
            <PopoverAnchor asChild>
              <div
                ref={input.promptInputAreaRef}
                className={cn(
                  "w-full min-w-0 self-start",
                  !isHeroLayout && "agent-gui-node__composer-prompt-input-area",
                  isHeroLayout &&
                    "agent-gui-node__composer-hero-prompt-input-area"
                )}
                data-has-draft-images={
                  draftImages.length > 0 ? "true" : undefined
                }
                style={promptInputAreaStyle}
              >
                <ComposerDraftAttachments
                  draftImages={draftImages}
                  draftLargeTexts={visibleDraftLargeTexts}
                  removeLabel={labels.removeMention}
                  onRemoveImage={removeDraftImage}
                  onRemoveLargeText={removeDraftLargeText}
                  onExpandLargeText={expandDraftLargeTextToPrompt}
                />
                <div
                  className={cn(
                    "w-full min-w-0 self-start",
                    !isHeroLayout &&
                      "agent-gui-node__composer-prompt-input-line"
                  )}
                >
                  <AgentRichTextEditor
                    ref={input.editorHandleRef}
                    value={input.paletteDraftPrompt}
                    placeholder={effectivePlaceholder}
                    disabled={inputDisabled}
                    className={styles.composerTextarea}
                    onChange={handleDraftChange}
                    onContentLayoutInvalidated={
                      input.layout.invalidateComposerMeasurement
                    }
                    onFocus={(method) => engagement?.focused(method)}
                    onUserContentChange={(nextPrompt) => {
                      if (
                        agentComposerDraftHasContent(
                          updateAgentComposerDraft(draftContent, {
                            prompt: nextPrompt
                          })
                        )
                      ) {
                        engagement?.contentEntered({
                          contentType: "text",
                          hadPrefill: agentComposerDraftHasContent(draftContent)
                        });
                      }
                    }}
                    onSubmit={submitCurrentPrompt}
                    onSubmitGuidance={() =>
                      submitCurrentPrompt({ guidance: true })
                    }
                    availableSkills={availableSkills}
                    availableCapabilities={availableCapabilities}
                    removeMentionLabel={labels.removeMention}
                    onKeyDownForPalette={handlePaletteKeyDown}
                    onFileMentionSuggestionChange={
                      handleFileMentionSuggestionChange
                    }
                    onFileMentionSuggestionKeyDown={handleFileMentionKeyDown}
                    onLinkClick={handleLinkClick}
                    promptImagesSupported={promptImagesSupported}
                    onPromptImagesUnsupported={onPromptImagesUnsupported}
                    onPasteImages={handlePastedImages}
                    onPasteLargeText={handlePastedLargeText}
                    onPasteFiles={
                      input.externalPromptEntriesSupported
                        ? input.addExternalPromptEntries
                        : undefined
                    }
                    onDropFiles={
                      input.externalPromptEntriesSupported
                        ? input.addExternalPromptEntries
                        : undefined
                    }
                  />
                  {!isHeroLayout ? composerActionButton : null}
                </div>
              </div>
            </PopoverAnchor>
            {input.showFileMentionPalette && mentionPaletteFrame
              ? createPortal(
                  <div
                    data-testid="agent-gui-mention-palette-surface"
                    ref={input.paletteContentRef}
                    className={cn(
                      composerStyles.dropdownSurface,
                      "max-h-[320px] overflow-hidden border-[var(--line-1)] p-0"
                    )}
                    style={mentionPaletteStyle}
                  >
                    <AgentFileMentionPalette
                      state={input.mentionSearchState}
                      highlightedKey={input.mentionHighlightedKey}
                      label={labels.fileMentionPalette}
                      loadingLabel={labels.fileMentionLoading}
                      emptyLabel={labels.fileMentionEmpty}
                      errorLabel={labels.fileMentionError}
                      tabHintLabel={labels.fileMentionTabHint}
                      maxHeightPx={mentionPaletteHeightPx}
                      shouldCenterHighlightedItem={
                        input.shouldCenterMentionHighlight
                      }
                      onHighlightChange={handleMentionHighlightChange}
                      onSelectItem={selectFileMention}
                      onSelectCategory={(filter) =>
                        input.mentionControllerRef.current?.setFilter(filter)
                      }
                      onSelectFilter={(filter) =>
                        input.mentionControllerRef.current?.setFilter(filter)
                      }
                      onExpandGroup={(groupId) =>
                        input.mentionControllerRef.current?.expandGroup(groupId)
                      }
                      onNavigateHierarchy={navigateFileMentionHierarchy}
                      onNavigateIntoItem={navigateIntoFileMentionItem}
                      onOpenReferences={
                        onRequestWorkspaceReferences
                          ? handleOpenReferencesForEntity
                          : undefined
                      }
                      provenanceFilterControl={
                        referenceProvenanceFilter ? (
                          <AgentReferenceProvenanceFilterControl
                            filter={referenceProvenanceFilter}
                          />
                        ) : undefined
                      }
                    />
                  </div>,
                  mentionPaletteFrame.portalTarget
                )
              : null}
            <ComposerFloatingMenuSurface
              anchorRef={input.inputShellRef}
              className={cn(
                composerStyles.dropdownSurface,
                "max-h-[320px] overflow-hidden border-[var(--line-1)] p-0"
              )}
              contentClassName="h-full min-h-0"
              dismissBoundaryRef={input.promptInputAreaRef}
              maxHeight={SLASH_PALETTE_HEIGHT_PX}
              onDismiss={closeSlashFloatingMenu}
              open={input.showSlashPalette}
              placement="fixed-height"
              surfaceRef={input.paletteContentRef}
              testId="agent-gui-slash-palette-surface"
            >
              <AgentSlashCommandPalette
                entries={slashPaletteEntries}
                highlightedIndex={input.activeHighlight}
                label={
                  slashQuery === null
                    ? labels.skillPickerPalette
                    : labels.slashCommandPalette
                }
                commandsGroupLabel={labels.slashPaletteCommandsGroup}
                capabilitiesGroupLabel={labels.slashPaletteCapabilitiesGroup}
                capabilitiesLoading={
                  composerSettings.isCapabilityOptionsLoading === true
                }
                capabilitiesLoadingLabel={
                  labels.slashPaletteCapabilitiesLoading
                }
                skillsGroupLabel={labels.slashPaletteSkillsGroup}
                pluginsGroupLabel={labels.slashPalettePluginsGroup}
                connectorsGroupLabel={labels.slashPaletteConnectorsGroup}
                mcpGroupLabel={labels.slashPaletteMcpGroup}
                onHighlightChange={input.setHighlightedIndex}
                onSelect={selectCommand}
                onSelectCapability={selectCapability}
                onSelectCapabilitySettings={selectCapabilitySettings}
                onSelectSkill={selectSkill}
              />
            </ComposerFloatingMenuSurface>
            <ComposerFloatingMenuSurface
              anchorRef={input.inputShellRef}
              className="border-0 p-0"
              dismissBoundaryRef={input.promptInputAreaRef}
              maxHeight={SLASH_PALETTE_HEIGHT_PX}
              onDismiss={closeSlashFloatingMenu}
              open={input.isSlashStatusPanelOpen}
              placement="dynamic-above"
              surfaceRef={input.paletteContentRef}
              testId="agent-gui-command-menu-surface"
            >
              <AgentSlashStatusPanel
                status={slashStatus}
                labels={{
                  slashStatusTitle: labels.slashStatusTitle,
                  slashStatusSession: labels.slashStatusSession,
                  slashStatusBaseUrl: labels.slashStatusBaseUrl,
                  slashStatusContext: labels.slashStatusContext,
                  slashStatusLimits: labels.slashStatusLimits,
                  slashStatusClose: labels.slashStatusClose,
                  slashStatusContextValue: labels.slashStatusContextValue,
                  slashStatusContextUnavailable:
                    labels.slashStatusContextUnavailable,
                  slashStatusLimitsUnavailable:
                    labels.slashStatusLimitsUnavailable,
                  slashStatusEmptyValue: labels.slashStatusEmptyValue,
                  slashStatusUsageJustUpdated:
                    labels.slashStatusUsageJustUpdated,
                  slashStatusUsageMinutesAgo: labels.slashStatusUsageMinutesAgo,
                  slashStatusUsageHoursAgo: labels.slashStatusUsageHoursAgo,
                  slashStatusUsageUpdating: labels.slashStatusUsageUpdating,
                  slashStatusUsageRefreshFailed:
                    labels.slashStatusUsageRefreshFailed,
                  slashStatusUsageRefreshAria:
                    labels.slashStatusUsageRefreshAria
                }}
                onClose={closeSlashStatusPanel}
                onRefresh={onSlashStatusRefresh}
              />
            </ComposerFloatingMenuSurface>
            <ComposerFloatingMenuSurface
              anchorRef={input.inputShellRef}
              className="border-0 p-0"
              dismissBoundaryRef={input.promptInputAreaRef}
              maxHeight={SLASH_PALETTE_HEIGHT_PX}
              onDismiss={closeSlashFloatingMenu}
              open={input.isReviewPickerOpen}
              placement="dynamic-above"
              surfaceRef={input.paletteContentRef}
              testId="agent-gui-command-menu-surface"
            >
              <AgentReviewPickerPanel
                labels={labels.reviewPicker}
                onRequestGitBranches={reviewBranchLoader}
                onSubmitReview={submitReviewCommand}
                onClose={closeReviewPicker}
              />
            </ComposerFloatingMenuSurface>
          </Popover>
          <ComposerFooter
            workspaceId={workspaceId}
            labels={labels}
            provider={provider}
            composerSettings={composerSettings}
            usage={usage}
            previewMode={previewMode}
            compactSupported={compactSupported}
            hasCompactableContext={hasCompactableContext}
            composerControlsHardDisabled={composerControlsHardDisabled}
            inputDisabled={inputDisabled}
            settingsControlsDisabled={settingsControlsDisabled}
            permissionModeControlsDisabled={permissionModeControlsDisabled}
            isSendingTurn={input.props.isSendingTurn}
            isHeroLayout={isHeroLayout}
            isGoalModeActive={input.isGoalModeActive}
            isPlanModeActive={input.isPlanModeActive}
            isTuttiModeActive={input.isTuttiModeActive}
            isTuttiModeUpdating={input.isTuttiModeUpdating}
            tuttiModeOrchestrationIntensity={
              input.tuttiModeOrchestrationIntensity
            }
            onClearPlanMode={input.onClearPlanMode}
            onClearTuttiMode={input.onClearTuttiMode}
            onTuttiModeOrchestrationIntensityChange={
              input.onTuttiModeOrchestrationIntensityChange
            }
            composerActionButton={composerActionButton}
            quickPromptControl={
              <AgentQuickPromptPopover
                controller={input.quickPromptLibrary}
                disabled={composerControlsHardDisabled || inputDisabled}
              />
            }
            showHandoffSelect={showHandoffSelect}
            handoffDisabled={handoffDisabled}
            effectiveHandoffLabel={effectiveHandoffLabel}
            effectiveHandoffMenuLabel={effectiveHandoffMenuLabel}
            handoffMenuTargets={handoffMenuTargets}
            onHandoffConversation={onHandoffConversation}
            showProviderSelect={showProviderSelect}
            selectedProviderSwitchTarget={selectedProviderSwitchTarget}
            providerSelectDisabled={providerSelectDisabled}
            providerSelectLabel={providerSelectLabel}
            selectedProviderLabel={selectedProviderLabel}
            providerMenuTargets={providerMenuTargets}
            onProviderSelect={onProviderSelect}
            onLinkAction={onLinkAction}
            onRequestWorkspaceReferences={onRequestWorkspaceReferences}
            onWorkspaceReferencePicker={handleWorkspaceReferencePicker}
            onMentionPaletteButton={handleMentionPaletteButton}
            onSettingsChange={onSettingsChange}
            onSubmit={onSubmit}
            onClearGoalMode={clearGoalModeBadge}
            draftPrompt={draftPrompt}
          />
        </div>
        {showProjectRow ? (
          <div
            className={styles.composerProjectRow}
            data-project-missing={
              input.isSelectedProjectMissing ? "true" : undefined
            }
          >
            {showHeroProjectSelector ? (
              <AgentProjectDropdown
                composerSettings={composerSettings}
                i18n={workspaceUserProjectI18n}
                previewMode={previewMode}
                labels={{
                  projectLocked: labels.projectLocked,
                  projectMissingDescription: labels.projectMissingDescription
                }}
                selectProjectDirectory={selectProjectDirectory}
                onDismissAutoFocus={input.onDismissProjectMenuAutoFocus}
                onProjectMissingChange={input.setIsSelectedProjectMissing}
                onProjectPathChange={onProjectPathChange}
              />
            ) : null}
            {activePromptTip ? (
              <div
                className={styles.composerPromptTips}
                data-testid="agent-gui-prompt-tips"
              >
                {!previewMode &&
                input.isPromptTipOverflowing &&
                promptTipNode ? (
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>{promptTipNode}</TooltipTrigger>
                      <TooltipContent
                        align="end"
                        className={styles.composerPromptTipTooltip}
                        side="bottom"
                      >
                        {activePromptTipText}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  promptTipNode
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </form>
  );
}
