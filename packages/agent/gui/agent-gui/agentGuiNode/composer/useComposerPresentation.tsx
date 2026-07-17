import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import { Spinner } from "@tutti-os/ui-system";
import { cn } from "../../../app/renderer/lib/utils";
import type { AgentConversationPromptVM } from "../../../shared/agentConversation/contracts/agentConversationVM";
import {
  agentComposerDraftFiles,
  agentComposerDraftHasContent,
  agentComposerDraftImages,
  agentComposerDraftLargeTexts
} from "../model/agentComposerDraft";
import type { AgentComposerDraft } from "../model/agentGuiNodeTypes";
import type { AgentFileMentionSuggestionState } from "../agentRichText/agentFileMentionExtension";
import type { AgentMentionSearchController } from "../AgentMentionSearchController";
import styles from "../AgentGUINode.styles";
import type {
  AgentComposerPromptTip,
  AgentComposerProps
} from "./AgentComposer.types";
import { SendFilledIcon } from "./AgentComposerDraftPreview";
import { useOptionalAgentActivityRuntime } from "../../../agentActivityRuntime";
import { reportAgentComposerDiagnostic } from "./agentComposerDiagnostics";

interface Input {
  draftContent: AgentComposerDraft;
  canQueueWhileBusy: boolean;
  showStopButton: boolean;
  isInterrupting: boolean;
  isSendingTurn: boolean;
  activePrompt: AgentConversationPromptVM | null;
  disabledReason?: string | null;
  placeholder: string;
  selectedProjectPath: string;
  selectedProjectSectionKey: string;
  previousSelectedProjectPathRef: RefObject<string>;
  setIsSelectedProjectMissing: (value: boolean) => void;
  fileMentionSuggestion: AgentFileMentionSuggestionState | null;
  mentionControllerRef: RefObject<AgentMentionSearchController | null>;
  workspaceId: string;
  currentUserId?: string | null;
  onSubmitInteractivePrompt: AgentComposerProps["onSubmitInteractivePrompt"];
  onInterruptCurrentTurn: () => void;
  isSelectedProjectMissing: boolean;
  submitDisabled: boolean;
  /** Keeps the send button live on an empty draft (empty-send override). */
  allowEmptySubmit: boolean;
  labels: AgentComposerProps["labels"];
  activePromptTip: AgentComposerPromptTip | null;
  promptTipRef: RefObject<HTMLSpanElement | null>;
  promptTips: readonly AgentComposerPromptTip[];
  promptTipStyle?: CSSProperties;
  rotatingPromptTips: readonly AgentComposerPromptTip[];
  fileDropOverlayHost: HTMLElement | null;
  fileDropOverlayActive: boolean;
  canUploadAttachment: boolean;
  promptImagesSupported: boolean;
}

export function useComposerPresentation(input: Input) {
  const {
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
    allowEmptySubmit,
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
  } = input;
  const agentActivityRuntime = useOptionalAgentActivityRuntime();
  const draftImages = agentComposerDraftImages(draftContent);
  const draftFiles = agentComposerDraftFiles(draftContent);
  const draftLargeTexts = agentComposerDraftLargeTexts(draftContent);
  const hasDraftContent = agentComposerDraftHasContent(draftContent);
  const hasUploadingDraftImages = draftImages.some((image) => image.uploading);
  const hasFailedDraftImages = draftImages.some((image) => image.uploadError);
  const hasUploadingDraftFiles = draftFiles.some((file) => file.uploading);
  const hasFailedDraftFiles = draftFiles.some((file) => file.uploadError);
  const hasUploadingDraftLargeTexts = draftLargeTexts.some(
    (item) => item.uploading
  );
  const hasFailedDraftLargeTexts = draftLargeTexts.some(
    (item) => item.uploadError
  );
  const isQueueMode = canQueueWhileBusy && hasDraftContent;
  const shouldShowStopButton = showStopButton && !isQueueMode;
  const sendButtonState = isQueueMode
    ? "queue"
    : shouldShowStopButton
      ? isInterrupting
        ? "stopping"
        : "interrupt"
      : isSendingTurn
        ? "loading"
        : "send";
  const sendButtonBusy = isSendingTurn && !isQueueMode;
  const emptyDraftBlocksSend = !hasDraftContent && !allowEmptySubmit;
  const sendDisabledReasons = [
    isSelectedProjectMissing ? "project_missing" : null,
    submitDisabled ? "submit_disabled" : null,
    emptyDraftBlocksSend ? "draft_empty" : null,
    hasUploadingDraftImages ? "image_uploading" : null,
    hasFailedDraftImages ? "image_upload_failed" : null,
    hasUploadingDraftFiles ? "file_uploading" : null,
    hasFailedDraftFiles ? "file_upload_failed" : null,
    hasUploadingDraftLargeTexts ? "large_text_uploading" : null,
    hasFailedDraftLargeTexts ? "large_text_upload_failed" : null,
    sendButtonBusy ? "send_busy" : null
  ].filter((reason): reason is string => reason !== null);
  const sendDisabledReasonKey = sendDisabledReasons.join(",");
  useEffect(() => {
    reportAgentComposerDiagnostic(agentActivityRuntime, {
      details: {
        canUploadAttachment,
        draftFileCount: draftFiles.length,
        draftImageCount: draftImages.length,
        draftLargeTextCount: draftLargeTexts.length,
        hasDraftContent,
        hasFailedDraftFiles,
        hasFailedDraftImages,
        hasFailedDraftLargeTexts,
        hasUploadingDraftFiles,
        hasUploadingDraftImages,
        hasUploadingDraftLargeTexts,
        isSelectedProjectMissing,
        promptImagesSupported,
        sendButtonBusy,
        sendDisabledReason: sendDisabledReasonKey || null,
        submitDisabled,
        uploadFunctionAvailable: Boolean(
          agentActivityRuntime?.uploadPromptContent
        )
      },
      event: "agent.gui.composer.submit_state_changed",
      level: "info",
      source: "agent-gui",
      workspaceId
    });
  }, [
    agentActivityRuntime,
    canUploadAttachment,
    draftFiles.length,
    draftImages.length,
    draftLargeTexts.length,
    hasDraftContent,
    hasFailedDraftFiles,
    hasFailedDraftImages,
    hasFailedDraftLargeTexts,
    hasUploadingDraftFiles,
    hasUploadingDraftImages,
    hasUploadingDraftLargeTexts,
    isSelectedProjectMissing,
    promptImagesSupported,
    sendButtonBusy,
    sendDisabledReasonKey,
    submitDisabled,
    workspaceId
  ]);
  const activePromptRequestId = activePrompt?.requestId ?? null;
  const [dismissedPromptRequestId, setDismissedPromptRequestId] = useState<
    string | null
  >(null);
  const visibleActivePrompt =
    activePrompt && dismissedPromptRequestId !== activePromptRequestId
      ? activePrompt
      : null;
  const disabledReasonText = disabledReason?.trim() ?? "";
  const effectivePlaceholder = disabledReasonText || placeholder;
  const visibleDraftLargeTexts = draftLargeTexts;
  useEffect(() => {
    if (previousSelectedProjectPathRef.current === selectedProjectPath) {
      return;
    }
    previousSelectedProjectPathRef.current = selectedProjectPath;
    setIsSelectedProjectMissing(false);
    if (!fileMentionSuggestion) {
      return;
    }
    mentionControllerRef.current?.updateQuery({
      workspaceId,
      currentUserId,
      query: fileMentionSuggestion.query,
      sectionKey: selectedProjectSectionKey || null,
      sessionCwd: selectedProjectPath || null
    });
  }, [
    currentUserId,
    fileMentionSuggestion,
    selectedProjectPath,
    selectedProjectSectionKey,
    workspaceId
  ]);

  useEffect(() => {
    setDismissedPromptRequestId(null);
  }, [activePromptRequestId]);

  const submitInteractivePromptAndDismiss = useCallback(
    (input: {
      requestId: string;
      action?: string;
      optionId?: string;
      payload?: Record<string, unknown>;
    }) => {
      onSubmitInteractivePrompt(input);
      setDismissedPromptRequestId(input.requestId);
    },
    [onSubmitInteractivePrompt]
  );

  const composerActionButton = shouldShowStopButton ? (
    <button
      type="button"
      className={`${styles.composerStopButton} relative inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-transparent bg-transparent p-0 text-[var(--text-primary)] transition-[color,opacity] duration-150 hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_srgb,var(--text-primary)_34%,transparent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background-panel)] active:bg-transparent disabled:cursor-not-allowed disabled:opacity-45`}
      disabled={isInterrupting}
      aria-label={isInterrupting ? labels.stopping : labels.stop}
      title={isInterrupting ? labels.stopping : labels.stop}
      onClick={onInterruptCurrentTurn}
    >
      <Spinner
        className="size-7 text-[var(--text-primary)]"
        size={28}
        strokeWidth={2}
        trackColor="var(--transparency-hover)"
        testId="agent-gui-composer-stop-spinner"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-[2px] bg-current"
        data-testid="agent-gui-composer-stop-symbol"
      />
    </button>
  ) : (
    <button
      type="submit"
      className={styles.composerSendButton}
      data-state={sendButtonState}
      data-disabled-reason={sendDisabledReasonKey || undefined}
      disabled={
        isSelectedProjectMissing ||
        submitDisabled ||
        emptyDraftBlocksSend ||
        hasUploadingDraftImages ||
        hasFailedDraftImages ||
        hasUploadingDraftFiles ||
        hasFailedDraftFiles ||
        hasUploadingDraftLargeTexts ||
        hasFailedDraftLargeTexts ||
        sendButtonBusy
      }
      aria-label={labels.send}
      title={labels.send}
      aria-busy={sendButtonBusy}
    >
      {sendButtonBusy ? (
        <Spinner
          className="text-[var(--text-primary)]"
          size={16}
          strokeWidth={2.5}
          trackColor="var(--transparency-hover)"
          testId="agent-gui-composer-send-spinner"
        />
      ) : (
        <SendFilledIcon />
      )}
    </button>
  );

  const promptTipNode = activePromptTip ? (
    <span
      key={activePromptTip.id}
      ref={promptTipRef}
      className={styles.composerPromptTip}
      data-rotating={promptTips.length > 1 ? "true" : undefined}
      data-testid="agent-gui-prompt-tip"
      style={promptTipStyle}
    >
      <span className={styles.composerPromptTipTrack}>
        {rotatingPromptTips.map((tip, index) => (
          <span
            key={`${tip.id}:${index}`}
            className={styles.composerPromptTipItem}
            aria-hidden={index >= promptTips.length ? true : undefined}
          >
            <span className={styles.composerPromptTipPrefix}>
              {labels.promptTipsPrefix}
            </span>
            <span className={styles.composerPromptTipLabel}>{tip.label}</span>
            <span className={styles.composerPromptTipText}>
              {" · "}
              {tip.prompt}
            </span>
          </span>
        ))}
      </span>
    </span>
  ) : null;

  const fileDropOverlay =
    fileDropOverlayHost !== null
      ? createPortal(
          <div
            aria-hidden="true"
            data-testid="agent-gui-composer-file-drop-overlay"
            data-active={fileDropOverlayActive ? "true" : "false"}
            className={cn(
              styles.composerFileDropOverlay,
              fileDropOverlayActive && styles.composerFileDropOverlayActive
            )}
          >
            <span className={styles.composerFileDropOverlayCard}>
              {labels.fileDropHint}
            </span>
          </div>,
          fileDropOverlayHost
        )
      : null;

  return {
    composerActionButton,
    disabledReasonText,
    effectivePlaceholder,
    fileDropOverlay,
    promptTipNode,
    submitInteractivePromptAndDismiss,
    visibleActivePrompt,
    visibleDraftLargeTexts
  };
}
