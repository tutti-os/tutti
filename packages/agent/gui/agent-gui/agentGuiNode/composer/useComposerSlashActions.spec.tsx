import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  agentComposerDraftPrompt,
  buildAgentComposerDraft,
  emptyAgentComposerDraft
} from "../model/agentComposerDraft";
import type { AgentComposerProps } from "./AgentComposer.types";
import { useComposerSlashActions } from "./useComposerSlashActions";

describe("useComposerSlashActions input history resend", () => {
  it("submits the edited draft after a historical prompt was recalled", () => {
    const onSubmit = vi.fn();
    const draftPromptRef = { current: "old prompt" };
    const originalDraft = buildAgentComposerDraft({ prompt: "old prompt" });
    const editedDraft = buildAgentComposerDraft({
      prompt: "edited prompt"
    });
    const commonInput = createInput({
      draftPromptRef,
      onSubmit
    });
    const { result, rerender } = renderHook(
      ({ draftContent }) =>
        useComposerSlashActions({
          ...commonInput,
          draftContent
        }),
      { initialProps: { draftContent: originalDraft } }
    );

    act(() => {
      draftPromptRef.current = "edited prompt";
      rerender({ draftContent: editedDraft });
      result.current.submitCurrentPrompt();
    });

    expect(onSubmit).toHaveBeenCalledOnce();
    const [content, displayPrompt, options] = onSubmit.mock.calls[0]!;
    expect(content).toEqual([{ type: "text", text: "edited prompt" }]);
    expect(displayPrompt).toBeUndefined();
    const submittedDraft = options?.submittedDraft;
    if (!submittedDraft) {
      throw new Error("submit payload did not include the submitted draft");
    }
    expect(agentComposerDraftPrompt(submittedDraft)).toBe("edited prompt");
  });
});

function createInput(input: {
  draftPromptRef: { current: string };
  onSubmit: AgentComposerProps["onSubmit"];
}) {
  return {
    workspaceId: "workspace-1",
    provider: "codex",
    draftContent: emptyAgentComposerDraft(),
    disabled: false,
    submitDisabled: false,
    canQueueWhileBusy: false,
    isSendingTurn: false,
    isSubmittingPrompt: false,
    showStopButton: false,
    promptImagesSupported: true,
    availableSkills: [],
    composerSettings: {
      sessionSettings: null,
      draftSettings: {
        model: null,
        reasoningEffort: null,
        speed: null,
        planMode: false
      },
      supportsModel: false,
      supportsReasoningEffort: false,
      supportsSpeed: false,
      supportsPlanMode: false,
      isSettingsLoading: false,
      modelUnavailable: false,
      reasoningUnavailable: false,
      speedUnavailable: false,
      slashCommandPolicy: null
    } as AgentComposerProps["composerSettings"],
    tuttiModeSupported: false,
    capabilityControlsReadOnly: false,
    onDraftContentChange: vi.fn(),
    onSettingsChange: vi.fn(),
    onSubmit: input.onSubmit,
    onSubmitEmpty: vi.fn(),
    onSubmitGuidance: vi.fn(),
    onCapabilitySettingsRequest: vi.fn(),
    onTuttiModeActivate: vi.fn(),
    onSlashStatusOpen: vi.fn(),
    onSlashStatusClose: vi.fn(),
    onPromptImagesUnsupported: vi.fn(),
    onRequestGitBranches: vi.fn(),
    selectedProjectPath: "",
    slashStatusAgentSessionId: null,
    isSlashStatusPanelOpen: false,
    slashCommandPolicy: null,
    skillQueryMatch: null,
    promptBeforeSelection: "",
    resolvedSlashCommands: [],
    slashPaletteEntries: [],
    activeHighlight: 0,
    showSlashPalette: false,
    showCommandMenuPanel: false,
    isSelectedProjectMissing: false,
    editorHandleRef: { current: null },
    draftPromptRef: input.draftPromptRef,
    draftImagesRef: { current: [] },
    draftFilesRef: { current: [] },
    draftLargeTextsRef: { current: [] },
    setPaletteDraftPrompt: vi.fn(),
    setIsPaletteOpen: vi.fn(),
    setIsReviewPickerOpen: vi.fn(),
    setIsSlashStatusPanelOpen: vi.fn(),
    setHighlightedIndex: vi.fn()
  } as Parameters<typeof useComposerSlashActions>[0];
}
