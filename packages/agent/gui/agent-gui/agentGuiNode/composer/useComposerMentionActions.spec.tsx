import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerMentionActions } from "./useComposerMentionActions";
import { emptyAgentComposerDraft } from "../model/agentComposerDraft";
import type { AgentGUIComposerSettingsVM } from "../model/agentGuiNodeTypes";
import type { AgentMentionSearchState } from "../AgentMentionSearchController";

type MentionActionsInput = Parameters<typeof useComposerMentionActions>[0];

const idleSearchState: AgentMentionSearchState = {
  status: "idle",
  query: "",
  mode: "browse",
  filter: "session",
  categories: [],
  groups: [],
  error: null
};

const composerSettings = {
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
  availableModels: [],
  availableReasoningEfforts: [],
  availableSpeeds: [],
  projectLocked: false,
  projectPathIsRemote: false
} as unknown as AgentGUIComposerSettingsVM;

function createMentionActionsInput(
  overrides: Partial<MentionActionsInput>
): MentionActionsInput {
  return {
    workspaceId: "ws-1",
    currentUserId: "user-1",
    selectedProjectPath: "",
    selectedProjectSectionKey: "",
    draftContent: emptyAgentComposerDraft(),
    fileMentionSuggestion: null,
    setFileMentionSuggestion: vi.fn(),
    mentionControllerRef: { current: null },
    editorHandleRef: { current: null },
    draftPromptRef: { current: "" },
    setPaletteDraftPrompt: vi.fn(),
    setIsPaletteOpen: vi.fn(),
    onDraftContentChange: vi.fn(),
    showFileMentionPalette: true,
    mentionHighlightedKey: null,
    mentionSearchState: idleSearchState,
    setMentionHighlightedKey: vi.fn(),
    setShouldCenterMentionHighlight: vi.fn(),
    setShouldResetMentionHighlightToFilter: vi.fn(),
    autoMentionHighlightedKeyRef: { current: null },
    composerSettings,
    isSendingTurn: false,
    isSubmittingPrompt: false,
    showStopButton: false,
    onSettingsChange: vi.fn(),
    handleSlashPaletteKeyDown: vi.fn(() => false),
    handleSlashCommandMenuKeyDown: vi.fn(() => false),
    showPalette: true,
    workspaceReferencePickerOpen: false,
    composerRef: { current: null },
    paletteContentRef: { current: null },
    promptInputAreaRef: { current: null },
    shouldCenterMentionHighlight: false,
    ...overrides
  };
}

function createDismissHarness() {
  const promptInputArea = document.createElement("div");
  const paletteSurface = document.createElement("div");
  const outside = document.createElement("div");
  document.body.append(promptInputArea, paletteSurface, outside);
  const setIsPaletteOpen = vi.fn();
  const input = createMentionActionsInput({
    paletteContentRef: { current: paletteSurface },
    promptInputAreaRef: { current: promptInputArea },
    setIsPaletteOpen
  });
  return { input, outside, paletteSurface, promptInputArea, setIsPaletteOpen };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("useComposerMentionActions palette dismissal", () => {
  it("closes the palette on pointerdown outside the composer surfaces", () => {
    const harness = createDismissHarness();
    renderHook(() => useComposerMentionActions(harness.input));

    fireEvent.pointerDown(harness.outside);

    expect(harness.setIsPaletteOpen).toHaveBeenCalledWith(false);
  });

  it("keeps the palette open for pointerdown inside the palette surface", () => {
    const harness = createDismissHarness();
    renderHook(() => useComposerMentionActions(harness.input));

    fireEvent.pointerDown(harness.paletteSurface);

    expect(harness.setIsPaletteOpen).not.toHaveBeenCalled();
  });

  it("keeps the palette open for pointerdown inside the prompt input area", () => {
    const harness = createDismissHarness();
    renderHook(() => useComposerMentionActions(harness.input));

    fireEvent.pointerDown(harness.promptInputArea);

    expect(harness.setIsPaletteOpen).not.toHaveBeenCalled();
  });

  it("does not listen for outside pointerdown while the palette is hidden", () => {
    const harness = createDismissHarness();
    renderHook(() =>
      useComposerMentionActions({
        ...harness.input,
        showFileMentionPalette: false
      })
    );

    fireEvent.pointerDown(harness.outside);

    expect(harness.setIsPaletteOpen).not.toHaveBeenCalled();
  });

  it("still closes the palette when the window resizes", () => {
    const harness = createDismissHarness();
    renderHook(() => useComposerMentionActions(harness.input));

    fireEvent.resize(window);

    expect(harness.setIsPaletteOpen).toHaveBeenCalledWith(false);
  });
});
