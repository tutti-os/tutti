import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  agentComposerDraftPrompt,
  buildAgentComposerDraft,
  emptyAgentComposerDraft
} from "../model/agentComposerDraft";
import { createAgentComposerInputHistoryStore } from "../model/agentComposerInputHistory";
import { useComposerInputHistory } from "./useComposerInputHistory";

describe("useComposerInputHistory", () => {
  it("records submissions and supports repeated navigation before rerender", () => {
    const onDraftContentChange = vi.fn();
    const inputHistoryStore = createAgentComposerInputHistoryStore();
    const draftByScopeKeyRef = {
      current: {
        "session:session-1": buildAgentComposerDraft({
          prompt: "current draft"
        })
      }
    };
    const { result } = renderHook(() =>
      useComposerInputHistory({
        currentDraft: draftByScopeKeyRef.current["session:session-1"],
        draftByScopeKeyRef,
        draftScopeKey: "session:session-1",
        inputHistoryStore,
        onDraftContentChange
      })
    );

    act(() => {
      result.current.recordSubmittedDraft(
        buildAgentComposerDraft({ prompt: "one" })
      );
      result.current.recordSubmittedDraft(
        buildAgentComposerDraft({ prompt: "two" })
      );
      expect(result.current.onHistoryNavigation("older")).toBe(true);
      expect(result.current.onHistoryNavigation("older")).toBe(true);
      expect(result.current.onHistoryNavigation("newer")).toBe(true);
      expect(result.current.onHistoryNavigation("newer")).toBe(true);
    });

    expect(
      onDraftContentChange.mock.calls.map(([draft]) =>
        agentComposerDraftPrompt(draft)
      )
    ).toEqual(["two", "one", "two", "current draft"]);
  });

  it("is inert when the host has not enabled input history", () => {
    const onDraftContentChange = vi.fn();
    const draftByScopeKeyRef = {
      current: { current: emptyAgentComposerDraft() }
    };
    const { result } = renderHook(() =>
      useComposerInputHistory({
        currentDraft: emptyAgentComposerDraft(),
        draftByScopeKeyRef,
        draftScopeKey: "current",
        onDraftContentChange
      })
    );

    act(() => {
      result.current.recordSubmittedDraft(
        buildAgentComposerDraft({ prompt: "one" })
      );
      expect(result.current.onHistoryNavigation("older")).toBe(false);
    });

    expect(onDraftContentChange).not.toHaveBeenCalled();
  });
});
