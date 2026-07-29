import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildAgentComposerDraft,
  emptyAgentComposerDraft
} from "../model/agentComposerDraft";
import type { AgentComposerInputHistoryEntry } from "../model/agentComposerInputHistory";
import { useComposerInputHistory } from "./useComposerInputHistory";

describe("useComposerInputHistory", () => {
  it("supports repeated Up presses before the controlled draft rerenders", () => {
    const onDraftContentChange = vi.fn();
    const entries = historyEntries("one", "two");
    const draftByScopeKeyRef = {
      current: { "session:session-1": emptyAgentComposerDraft() }
    };
    const { result } = renderHook(() =>
      useComposerInputHistory({
        agentSessionId: "session-1",
        currentDraft: emptyAgentComposerDraft(),
        draftByScopeKeyRef,
        draftScopeKey: "session:session-1",
        entries,
        hasOlderPage: false,
        isLoadingOlderPage: false,
        onDraftContentChange,
        runtime: null,
        workspaceId: "workspace-1"
      })
    );

    act(() => {
      expect(result.current.onHistoryNavigation("older")).toBe(true);
      expect(result.current.onHistoryNavigation("older")).toBe(true);
    });

    expect(onDraftContentChange).toHaveBeenNthCalledWith(
      1,
      entries[1]!.draft,
      "session:session-1"
    );
    expect(onDraftContentChange).toHaveBeenNthCalledWith(
      2,
      entries[0]!.draft,
      "session:session-1"
    );
  });

  it("recalls the next older entry after an older page is prepended", () => {
    const onDraftContentChange = vi.fn();
    const onRequestOlderPage = vi.fn();
    const current = historyEntries("current")[0]!;
    const older = historyEntries("older")[0]!;
    const draftByScopeKeyRef = {
      current: { "session:session-1": emptyAgentComposerDraft() }
    };
    const { result, rerender } = renderHook(
      ({ currentDraft, entries }) => {
        draftByScopeKeyRef.current["session:session-1"] = currentDraft;
        return useComposerInputHistory({
          agentSessionId: "session-1",
          currentDraft,
          draftByScopeKeyRef,
          draftScopeKey: "session:session-1",
          entries,
          hasOlderPage: true,
          isLoadingOlderPage: false,
          onDraftContentChange,
          onRequestOlderPage,
          runtime: null,
          workspaceId: "workspace-1"
        });
      },
      {
        initialProps: {
          currentDraft: emptyAgentComposerDraft(),
          entries: [current]
        }
      }
    );

    act(() => {
      result.current.onHistoryNavigation("older");
      result.current.onHistoryNavigation("older");
    });
    expect(onRequestOlderPage).toHaveBeenCalledOnce();

    rerender({
      currentDraft: current.draft,
      entries: [older, current]
    });
    act(() => {
      result.current.settlePendingInputHistory();
    });

    expect(onDraftContentChange).toHaveBeenLastCalledWith(
      older.draft,
      "session:session-1"
    );
  });

  it("does not overwrite edits made while an older page is loading", () => {
    const onDraftContentChange = vi.fn();
    const onRequestOlderPage = vi.fn();
    const current = historyEntries("current")[0]!;
    const older = historyEntries("older")[0]!;
    const editedDraft = buildAgentComposerDraft({ prompt: "edited" });
    const draftByScopeKeyRef = {
      current: { "session:session-1": emptyAgentComposerDraft() }
    };
    const { result, rerender } = renderHook(
      ({ currentDraft, entries, isLoadingOlderPage }) => {
        draftByScopeKeyRef.current["session:session-1"] = currentDraft;
        return useComposerInputHistory({
          agentSessionId: "session-1",
          currentDraft,
          draftByScopeKeyRef,
          draftScopeKey: "session:session-1",
          entries,
          hasOlderPage: true,
          isLoadingOlderPage,
          onDraftContentChange,
          onRequestOlderPage,
          runtime: null,
          workspaceId: "workspace-1"
        });
      },
      {
        initialProps: {
          currentDraft: emptyAgentComposerDraft(),
          entries: [current],
          isLoadingOlderPage: false
        }
      }
    );

    act(() => {
      result.current.onHistoryNavigation("older");
      result.current.onHistoryNavigation("older");
    });
    rerender({
      currentDraft: editedDraft,
      entries: [current],
      isLoadingOlderPage: true
    });
    rerender({
      currentDraft: editedDraft,
      entries: [older, current],
      isLoadingOlderPage: false
    });
    act(() => {
      result.current.settlePendingInputHistory();
    });

    expect(onDraftContentChange).toHaveBeenCalledOnce();
    expect(onDraftContentChange).toHaveBeenLastCalledWith(
      current.draft,
      "session:session-1"
    );
  });
});

function historyEntries(
  ...prompts: string[]
): AgentComposerInputHistoryEntry[] {
  return prompts.map((prompt) => ({
    id: prompt,
    draft: buildAgentComposerDraft({ prompt })
  }));
}
