import {
  useCallback,
  useMemo,
  useRef,
  type Dispatch,
  type FormEvent,
  type RefObject,
  type SetStateAction
} from "react";
import type { AgentSessionCommand } from "../../../shared/agentSessionTypes";
import type {
  AgentComposerDraft,
  AgentComposerDraftFile,
  AgentComposerDraftImage,
  AgentComposerDraftLargeText,
  AgentGUIProviderSkillOption
} from "../model/agentGuiNodeTypes";
import type { AgentRichTextEditorHandle } from "../agentRichText/AgentRichTextEditor";
import type { AgentSlashPaletteEntry } from "../AgentSlashCommandPalette";
import type {
  AgentSlashCommand,
  AgentSlashCommandCapability,
  SlashCommandSelectionEffect
} from "../model/agentSlashCommandProviderPolicy";
import {
  resolveSlashCommandSelectionEffect,
  resolveSlashCommandSubmitEffect,
  resolveTuttiBrowserUseSubmitEffect
} from "../model/agentSlashCommandProviderPolicy";
import {
  draftForProviderSkillTrigger,
  getAgentComposerTriggerQueryMatch
} from "../model/agentComposerTriggerQueries";
import { skillTriggerForPrefix } from "../model/agentSkillOptions";
import { moveSlashCommandHighlight } from "../model/agentSlashCommands";
import {
  agentComposerDraftDisplayPrompt,
  agentComposerDraftHasContent,
  agentComposerDraftToPromptContent,
  emptyAgentComposerDraft,
  textPromptContent
} from "../model/agentComposerDraft";
import { resolvePermissionModeControlsDisabled } from "../model/composerModeSelection";
import { GOAL_MODE_SLASH_COMMAND } from "./AgentComposerChrome";
import type { AgentComposerProps } from "./AgentComposer.types";

type TriggerMatch = ReturnType<typeof getAgentComposerTriggerQueryMatch>;

type Props = Pick<
  AgentComposerProps,
  | "provider"
  | "disabled"
  | "submitDisabled"
  | "canQueueWhileBusy"
  | "isSendingTurn"
  | "isSubmittingPrompt"
  | "showStopButton"
  | "promptImagesSupported"
  | "availableSkills"
  | "composerSettings"
  | "onDraftContentChange"
  | "onSettingsChange"
  | "onSubmit"
  | "onSubmitGuidance"
  | "onCapabilitySettingsRequest"
  | "onSlashStatusOpen"
  | "onPromptImagesUnsupported"
  | "onRequestGitBranches"
>;

interface UseComposerSlashActionsInput extends Props {
  draftContent: AgentComposerDraft;
  selectedProjectPath: string;
  slashStatusAgentSessionId: string | null;
  isSlashStatusPanelOpen: boolean;
  slashCommandPolicy: AgentComposerProps["composerSettings"]["slashCommandPolicy"];
  skillQueryMatch: TriggerMatch;
  promptBeforeSelection: string;
  resolvedSlashCommands: readonly AgentSlashCommand[];
  slashPaletteEntries: readonly AgentSlashPaletteEntry[];
  activeHighlight: number;
  showSlashPalette: boolean;
  showCommandMenuPanel: boolean;
  isSelectedProjectMissing: boolean;
  editorHandleRef: RefObject<AgentRichTextEditorHandle | null>;
  draftPromptRef: RefObject<string>;
  draftImagesRef: RefObject<AgentComposerDraftImage[]>;
  draftFilesRef: RefObject<AgentComposerDraftFile[]>;
  draftLargeTextsRef: RefObject<AgentComposerDraftLargeText[]>;
  setPaletteDraftPrompt: Dispatch<SetStateAction<string>>;
  setIsPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setIsReviewPickerOpen: Dispatch<SetStateAction<boolean>>;
  setIsSlashStatusPanelOpen: Dispatch<SetStateAction<boolean>>;
  setHighlightedIndex: Dispatch<SetStateAction<number>>;
}

function useStableEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  return useCallback((...args: Args) => callbackRef.current(...args), []);
}

export function useComposerSlashActions(input: UseComposerSlashActionsInput) {
  const {
    provider,
    disabled,
    submitDisabled,
    canQueueWhileBusy,
    isSendingTurn,
    isSubmittingPrompt,
    showStopButton,
    promptImagesSupported,
    availableSkills = [],
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
  } = input;
  const clearSlashCommandDraft = useCallback((): void => {
    draftPromptRef.current = "";
    setPaletteDraftPrompt("");
    setIsPaletteOpen(false);
    onDraftContentChange(emptyAgentComposerDraft());
  }, [onDraftContentChange]);

  const closeSlashStatusPanel = useCallback((): void => {
    setIsSlashStatusPanelOpen(false);
  }, []);

  const settingsControlsDisabled =
    isSendingTurn || isSubmittingPrompt || showStopButton;
  const permissionModeControlsDisabled = resolvePermissionModeControlsDisabled({
    changeDuringTurnSupported: composerSettings.permissionModeChangeDuringTurn,
    isSendingTurn,
    isSubmittingPrompt,
    showStopButton
  });
  const composerControlsHardDisabled =
    isSelectedProjectMissing ||
    isSubmittingPrompt ||
    (disabled && !isSendingTurn && !showStopButton);

  const closeReviewPicker = useCallback((): void => {
    setIsReviewPickerOpen(false);
  }, []);

  const closeSlashFloatingMenu = useCallback((): void => {
    setIsSlashStatusPanelOpen(false);
    setIsReviewPickerOpen(false);
    setIsPaletteOpen(false);
  }, []);

  const submitReviewCommand = useCallback(
    (command: string): void => {
      setIsReviewPickerOpen(false);
      clearSlashCommandDraft();
      onSubmit(textPromptContent(command));
    },
    [clearSlashCommandDraft, onSubmit]
  );

  // Bind the branch loader to this composer's session so the picker can fetch
  // branches without the caller having to know the active agent session id.
  const reviewBranchLoader = useMemo(() => {
    if (!onRequestGitBranches) {
      return null;
    }
    // Prefer the live agent session (its daemon-resolved cwd); fall back to the
    // selected project path so the review picker still lists branches in the
    // empty-hero composer before any session exists.
    if (slashStatusAgentSessionId) {
      return () =>
        onRequestGitBranches({ agentSessionId: slashStatusAgentSessionId });
    }
    if (selectedProjectPath) {
      return () =>
        onRequestGitBranches({ workingDirectory: selectedProjectPath });
    }
    return null;
  }, [onRequestGitBranches, selectedProjectPath, slashStatusAgentSessionId]);

  const executeSlashCommandEffect = useCallback(
    (effect: SlashCommandSelectionEffect): void => {
      if (effect.kind === "submitPrompt") {
        clearSlashCommandDraft();
        if (effect.enableBrowserUse && !settingsControlsDisabled) {
          onSettingsChange({ browserUse: true });
        }
        if (effect.displayPrompt) {
          onSubmit(textPromptContent(effect.prompt), effect.displayPrompt);
        } else {
          onSubmit(textPromptContent(effect.prompt));
        }
        return;
      }
      if (effect.kind === "showStatus") {
        clearSlashCommandDraft();
        setIsReviewPickerOpen(false);
        if (!isSlashStatusPanelOpen) {
          onSlashStatusOpen?.();
        }
        setIsSlashStatusPanelOpen((current) => !current);
        return;
      }
      if (effect.kind === "showReviewPicker") {
        clearSlashCommandDraft();
        setIsSlashStatusPanelOpen(false);
        setIsReviewPickerOpen(true);
        return;
      }
      if (effect.kind === "activateGoalMode") {
        draftPromptRef.current = GOAL_MODE_SLASH_COMMAND;
        setPaletteDraftPrompt("");
        setIsSlashStatusPanelOpen(false);
        setIsReviewPickerOpen(false);
        setIsPaletteOpen(false);
        onDraftContentChange({
          ...draftContent,
          prompt: GOAL_MODE_SLASH_COMMAND
        });
        return;
      }
      if (effect.kind === "togglePlanMode") {
        clearSlashCommandDraft();
        onSettingsChange({
          planMode: !composerSettings.draftSettings.planMode
        });
        return;
      }
      if (effect.kind === "enableBrowserUse") {
        const nextDraft = effect.draft;
        draftPromptRef.current = nextDraft;
        setPaletteDraftPrompt(nextDraft);
        onDraftContentChange({ ...draftContent, prompt: nextDraft });
        setIsPaletteOpen(false);
        if (!settingsControlsDisabled) {
          onSettingsChange({ browserUse: true });
        }
        return;
      }
      if (effect.kind === "enableComputerUse") {
        const nextDraft = effect.draft;
        draftPromptRef.current = nextDraft;
        setPaletteDraftPrompt(nextDraft);
        onDraftContentChange({ ...draftContent, prompt: nextDraft });
        setIsPaletteOpen(false);
        if (!settingsControlsDisabled) {
          onSettingsChange({ computerUse: true });
        }
        return;
      }
      if (effect.kind === "toggleSpeed") {
        clearSlashCommandDraft();
        if (composerSettings.supportsSpeed) {
          const currentSpeed =
            composerSettings.selectedSpeedValue ??
            composerSettings.draftSettings.speed ??
            "standard";
          onSettingsChange({
            speed: currentSpeed === "fast" ? "standard" : "fast"
          });
        }
        return;
      }
      const nextDraft = effect.draft;
      draftPromptRef.current = nextDraft;
      setPaletteDraftPrompt(nextDraft);
      onDraftContentChange({ ...draftContent, prompt: nextDraft });
      setIsPaletteOpen(false);
    },
    [
      clearSlashCommandDraft,
      composerSettings.draftSettings.planMode,
      composerSettings.draftSettings.speed,
      composerSettings.selectedSpeedValue,
      composerSettings.supportsSpeed,
      draftContent,
      isSlashStatusPanelOpen,
      onDraftContentChange,
      onSlashStatusOpen,
      onSettingsChange,
      onSubmit,
      settingsControlsDisabled
    ]
  );

  const selectCommand = useCallback(
    (command: AgentSessionCommand): void => {
      const selectionEffect = resolveSlashCommandSelectionEffect({
        provider,
        policy: slashCommandPolicy,
        command,
        currentDraft: draftPromptRef.current
      });
      if (selectionEffect) {
        executeSlashCommandEffect(selectionEffect);
      }
    },
    [executeSlashCommandEffect, provider, slashCommandPolicy]
  );

  const selectCapability = useCallback(
    (capability: AgentSlashCommandCapability): void => {
      const selectionEffect = resolveSlashCommandSelectionEffect({
        provider,
        policy: slashCommandPolicy,
        command: capability,
        currentDraft: draftPromptRef.current
      });
      if (selectionEffect) {
        executeSlashCommandEffect(selectionEffect);
      }
    },
    [executeSlashCommandEffect, provider, slashCommandPolicy]
  );

  const selectCapabilitySettings = useCallback(
    (capability: AgentSlashCommandCapability): void => {
      onCapabilitySettingsRequest?.(capability.capability);
      setIsPaletteOpen(false);
    },
    [onCapabilitySettingsRequest]
  );

  const selectSkill = useCallback(
    (skill: AgentGUIProviderSkillOption): void => {
      const trigger = skillTriggerForPrefix(skill, skillQueryMatch?.prefix);
      const replacedDraft =
        trigger && skillQueryMatch && promptBeforeSelection !== ""
          ? editorHandleRef.current?.replaceTextBeforeSelection(
              skillQueryMatch.end - skillQueryMatch.start,
              `${trigger} `
            )
          : null;
      const nextDraft =
        replacedDraft ??
        draftForProviderSkillTrigger({
          skill,
          currentDraft: draftPromptRef.current,
          match: skillQueryMatch
        });
      draftPromptRef.current = nextDraft;
      setPaletteDraftPrompt(nextDraft);
      onDraftContentChange({ ...draftContent, prompt: nextDraft });
      setIsPaletteOpen(false);
    },
    [draftContent, onDraftContentChange, promptBeforeSelection, skillQueryMatch]
  );

  const submitCurrentPrompt = useStableEventCallback(
    (options?: { guidance?: boolean }): void => {
      const canSubmitWhileSending = canQueueWhileBusy && isSendingTurn;
      const currentDraftImages = draftImagesRef.current;
      const currentDraftFiles = draftFilesRef.current;
      const currentDraftLargeTexts = draftLargeTextsRef.current;
      const hasUploadingImages = currentDraftImages.some(
        (image) => image.uploading
      );
      const hasFailedImages = currentDraftImages.some(
        (image) => image.uploadError
      );
      const hasUploadingFiles = currentDraftFiles.some(
        (file) => file.uploading
      );
      const hasFailedFiles = currentDraftFiles.some((file) => file.uploadError);
      const hasUploadingLargeTexts = currentDraftLargeTexts.some(
        (item) => item.uploading
      );
      const hasFailedLargeTexts = currentDraftLargeTexts.some(
        (item) => item.uploadError
      );
      if (
        isSelectedProjectMissing ||
        submitDisabled ||
        hasUploadingImages ||
        hasFailedImages ||
        hasUploadingFiles ||
        hasFailedFiles ||
        hasUploadingLargeTexts ||
        hasFailedLargeTexts ||
        (disabled && !canQueueWhileBusy) ||
        (isSendingTurn && !canSubmitWhileSending)
      ) {
        return;
      }
      const nextPrompt = draftPromptRef.current;
      const nextDraftContent = {
        ...draftContent,
        prompt: nextPrompt,
        images: currentDraftImages,
        files: currentDraftFiles,
        largeTexts: currentDraftLargeTexts
      };
      if (!agentComposerDraftHasContent(nextDraftContent)) {
        return;
      }
      if (currentDraftImages.length > 0 && !promptImagesSupported) {
        onPromptImagesUnsupported?.();
        return;
      }
      if (options?.guidance !== true) {
        const browserUseEffect = resolveTuttiBrowserUseSubmitEffect({
          browserSupported: Boolean(composerSettings.supportsBrowser),
          commands: resolvedSlashCommands,
          draft: nextPrompt
        });
        if (browserUseEffect) {
          executeSlashCommandEffect(browserUseEffect);
          return;
        }
        const slashCommandEffect = resolveSlashCommandSubmitEffect({
          provider,
          policy: slashCommandPolicy,
          commands: resolvedSlashCommands,
          draft: nextPrompt
        });
        if (slashCommandEffect) {
          executeSlashCommandEffect(slashCommandEffect);
          return;
        }
      }
      setIsPaletteOpen(false);
      // workspace-reference 保持为单条 mention，由 skill+CLI 按需解析。
      const submitContent = agentComposerDraftToPromptContent({
        draft: nextDraftContent,
        skills: availableSkills
      });
      const submitDisplayPrompt =
        agentComposerDraftDisplayPrompt(nextDraftContent);
      if (options?.guidance === true) {
        if (!onSubmitGuidance) {
          return;
        }
        if (submitDisplayPrompt) {
          onSubmitGuidance(submitContent, submitDisplayPrompt);
        } else {
          onSubmitGuidance(submitContent);
        }
      } else {
        if (submitDisplayPrompt) {
          onSubmit(submitContent, submitDisplayPrompt);
        } else {
          onSubmit(submitContent);
        }
      }
      // Submission acknowledgment is asynchronous. The controller owns draft
      // clearing after the engine accepts or confirms this exact content, so a
      // rejected send cannot erase the user's prompt and a later edit cannot
      // be overwritten by an in-flight submission.
    }
  );

  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      submitCurrentPrompt();
    },
    [submitCurrentPrompt]
  );

  const handleSlashPaletteKeyDown = useStableEventCallback(
    (event: KeyboardEvent): boolean => {
      if (!showSlashPalette) {
        return false;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((current) =>
          moveSlashCommandHighlight(current, slashPaletteEntries.length, 1)
        );
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((current) =>
          moveSlashCommandHighlight(current, slashPaletteEntries.length, -1)
        );
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setIsPaletteOpen(false);
        return true;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        const activeEntry = slashPaletteEntries[activeHighlight];
        if (activeEntry?.type === "command") {
          selectCommand(activeEntry.command);
        } else if (activeEntry?.type === "capability") {
          if (activeEntry.selectAction === "settings") {
            selectCapabilitySettings(activeEntry.capability);
          } else {
            selectCapability(activeEntry.capability);
          }
        } else if (activeEntry?.type === "skill") {
          selectSkill(activeEntry.skill);
        }
        return true;
      }
      return false;
    }
  );

  const handleSlashCommandMenuKeyDown = useStableEventCallback(
    (event: KeyboardEvent): boolean => {
      if (!showCommandMenuPanel || event.key !== "Escape") {
        return false;
      }
      event.preventDefault();
      closeSlashFloatingMenu();
      return true;
    }
  );

  return {
    clearSlashCommandDraft,
    closeReviewPicker,
    closeSlashFloatingMenu,
    closeSlashStatusPanel,
    composerControlsHardDisabled,
    executeSlashCommandEffect,
    handleSlashCommandMenuKeyDown,
    handleSlashPaletteKeyDown,
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
  };
}
