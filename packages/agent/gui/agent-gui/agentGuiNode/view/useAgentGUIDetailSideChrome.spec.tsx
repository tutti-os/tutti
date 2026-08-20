// @vitest-environment jsdom

import { act, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentComposerProps } from "../AgentComposer";
import { createAgentGUISideConversationPresentation } from "../../../agentSideConversationPresentation";
import {
  agentComposerDraftQuotes,
  emptyAgentComposerDraft
} from "../model/agentComposerDraft";
import { useAgentGUIDetailSideChrome } from "./useAgentGUIDetailSideChrome";
import type { useAgentGUIDetailSideConversation } from "./useAgentGUIDetailSideConversation";

describe("useAgentGUIDetailSideChrome", () => {
  it("stages a selected transcript quote in the main draft without submitting", () => {
    const onDraftContentChange = vi.fn();
    const onSubmit = vi.fn();
    const onRequestComposerFocus = vi.fn();
    const baseComposerProps = {
      agentSessionId: "main-session",
      composerSettings: {
        draftSettings: {},
        sessionSettings: {}
      },
      draftContent: emptyAgentComposerDraft(),
      isActive: true,
      isSendingTurn: false,
      isSubmittingPrompt: false,
      onDraftContentChange,
      onSubmit,
      selectedAgentTarget: null
    } as unknown as AgentComposerProps;
    const controller = {
      active: null,
      canOpen: true,
      close: vi.fn(),
      draftContent: emptyAgentComposerDraft(),
      entryError: null,
      focused: false,
      focusRequestSequence: null,
      interactionSubmitting: false,
      interactivePrompt: null,
      interrupt: vi.fn(),
      setDraftContent: vi.fn(),
      setFocused: vi.fn(),
      sourceAgentSessionId: "main-session",
      stageSelection: vi.fn(async () => {}),
      submitInteraction: vi.fn(async () => {}),
      submitSide: vi.fn()
    } as unknown as ReturnType<typeof useAgentGUIDetailSideConversation>;

    const rendered = renderHook(() =>
      useAgentGUIDetailSideChrome({
        availableSkills: [],
        baseComposerProps,
        controller,
        conversationFlowLabels: {} as never,
        isVisible: true,
        textSelectionActionsEnabled: true,
        onRequestComposerFocus,
        renderComposerFooterAccessory: undefined
      })
    );

    act(() => {
      rendered.result.current.selectionProps.onAddSelectionToConversation(
        "Selected main answer"
      );
    });

    expect(onDraftContentChange).toHaveBeenCalledOnce();
    expect(
      agentComposerDraftQuotes(onDraftContentChange.mock.calls[0]?.[0])
    ).toEqual([
      expect.objectContaining({
        type: "quote",
        text: "Selected main answer"
      })
    ]);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onRequestComposerFocus).toHaveBeenCalledOnce();
  });

  it("publishes Side externally and closes it when the canonical Session changes", () => {
    const presentation = createAgentGUISideConversationPresentation();
    const close = vi.fn(async () => {});
    const baseComposerProps = {
      agentSessionId: "main-session",
      composerSettings: {
        draftSettings: {},
        sessionSettings: {}
      },
      draftContent: emptyAgentComposerDraft(),
      isActive: true,
      isSendingTurn: false,
      isSubmittingPrompt: false,
      labels: {},
      onDraftContentChange: vi.fn(),
      onSubmit: vi.fn(),
      selectedAgentTarget: null,
      workspaceId: "workspace-1"
    } as unknown as AgentComposerProps;
    const controller = {
      active: {
        activeTurnId: null,
        conversation: null,
        error: null,
        pendingInteraction: null,
        sideAgentSessionId: "side-session",
        sourceAgentSessionId: "main-session",
        status: "idle"
      },
      canOpen: true,
      close,
      draftContent: emptyAgentComposerDraft(),
      entryError: null,
      focused: false,
      focusRequestSequence: null,
      interactionSubmitting: false,
      interactivePrompt: null,
      interrupt: vi.fn(),
      setDraftContent: vi.fn(),
      setFocused: vi.fn(),
      sourceAgentSessionId: "main-session",
      stageSelection: vi.fn(async () => {}),
      submitInteraction: vi.fn(async () => {}),
      submitSide: vi.fn()
    } as unknown as ReturnType<typeof useAgentGUIDetailSideConversation>;

    function SideChromeHarness({
      sourceAgentSessionId
    }: {
      sourceAgentSessionId: string;
    }) {
      return useAgentGUIDetailSideChrome({
        availableSkills: [],
        baseComposerProps,
        controller: {
          ...controller,
          sourceAgentSessionId
        },
        conversationFlowLabels: {} as never,
        isVisible: true,
        presentation,
        textSelectionActionsEnabled: true,
        onRequestComposerFocus: vi.fn(),
        renderComposerFooterAccessory: undefined
      }).sidePane;
    }
    const rendered = render(
      <SideChromeHarness sourceAgentSessionId="main-session" />
    );

    expect(presentation.getSnapshot()).toMatchObject({
      sideAgentSessionId: "side-session",
      sourceAgentSessionId: "main-session",
      surfaceProps: {
        composerProps: {
          // The editor must be active before its first focus event; focus is
          // an outcome of clicking the editor, not a prerequisite for it.
          isActive: true
        }
      }
    });

    rendered.rerender(
      <SideChromeHarness sourceAgentSessionId="other-session" />
    );

    expect(close).toHaveBeenCalledOnce();
    expect(presentation.getSnapshot()).toBeNull();

    rendered.unmount();
    expect(presentation.getSnapshot()).toBeNull();
  });
});
