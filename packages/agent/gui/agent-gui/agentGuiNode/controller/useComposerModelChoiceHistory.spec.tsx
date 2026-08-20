import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentGUIComposerModelChoiceHistoryVM } from "../model/agentGuiNodeTypes";
import { useComposerModelChoiceHistory } from "./useComposerModelChoiceHistory";

const RECENTS_PREFIX = "agent-gui:composer-model-recents:";
const FAVORITES_PREFIX = "agent-gui:composer-model-favorites:";

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe("useComposerModelChoiceHistory", () => {
  it("reconciles recents against an authoritative target catalog", async () => {
    globalThis.localStorage.setItem(
      `${RECENTS_PREFIX}agent:ccs`,
      '["old-model","valid-model"]'
    );
    globalThis.localStorage.setItem(
      `${FAVORITES_PREFIX}agent:ccs`,
      '["old-model"]'
    );

    const { result } = renderHook(() =>
      useComposerModelChoiceHistory(
        history("agent:ccs", catalog(["valid-model", "other-model"]))
      )
    );

    await waitFor(() => {
      expect(result.current.recentModelIds).toEqual(["valid-model"]);
    });
    act(() => result.current.refreshFromStorage());
    expect(globalThis.localStorage.getItem(`${RECENTS_PREFIX}agent:ccs`)).toBe(
      '["valid-model"]'
    );
    expect(
      globalThis.localStorage.getItem(`${FAVORITES_PREFIX}agent:ccs`)
    ).toBe('["old-model"]');
  });

  it("removes an empty recents key after every remembered model is rejected", async () => {
    globalThis.localStorage.setItem(
      `${RECENTS_PREFIX}agent:ccs`,
      '["old-model"]'
    );

    const { result } = renderHook(() =>
      useComposerModelChoiceHistory(
        history("agent:ccs", catalog(["valid-model", "other-model"]))
      )
    );

    act(() => result.current.refreshFromStorage());

    await waitFor(() => {
      expect(
        globalThis.localStorage.getItem(`${RECENTS_PREFIX}agent:ccs`)
      ).toBeNull();
    });
  });

  it.each([
    ["non-authoritative", catalog(["valid-model"], { authoritative: false })],
    ["loading", catalog(["valid-model"], { loading: true })],
    ["empty", catalog([])],
    [
      "requested-only",
      catalog([], {
        models: [{ value: "old-model", requested: true }]
      })
    ],
    [
      "selected-only echo",
      catalog([], {
        effectiveModel: "old-model",
        models: [{ value: "old-model" }]
      })
    ]
  ])("preserves recents while the catalog is %s", async (_label, testimony) => {
    globalThis.localStorage.setItem(
      `${RECENTS_PREFIX}agent:ccs`,
      '["old-model"]'
    );

    const { result } = renderHook(() =>
      useComposerModelChoiceHistory(history("agent:ccs", testimony))
    );

    await waitFor(() => {
      expect(result.current.recentModelIds).toEqual(["old-model"]);
    });
    act(() => result.current.refreshFromStorage());
    expect(globalThis.localStorage.getItem(`${RECENTS_PREFIX}agent:ccs`)).toBe(
      '["old-model"]'
    );
  });

  it("lazily migrates the legacy shared bucket through current catalog testimony", async () => {
    globalThis.localStorage.setItem(
      `${RECENTS_PREFIX}default`,
      '["old-model","valid-model"]'
    );
    globalThis.localStorage.setItem(
      `${FAVORITES_PREFIX}default`,
      '["favorite-model"]'
    );
    globalThis.localStorage.setItem(
      `${RECENTS_PREFIX}agent:ccs`,
      '["target-model"]'
    );

    const { result } = renderHook(() =>
      useComposerModelChoiceHistory(
        history(
          "agent:ccs",
          catalog(["target-model", "valid-model", "other-model"])
        )
      )
    );

    act(() => result.current.refreshFromStorage());

    await waitFor(() => {
      expect(result.current.recentModelIds).toEqual([
        "target-model",
        "valid-model"
      ]);
      expect(result.current.favoriteModelIds).toEqual(["favorite-model"]);
    });
    expect(
      globalThis.localStorage.getItem(`${RECENTS_PREFIX}default`)
    ).toBeNull();
    expect(
      globalThis.localStorage.getItem(`${FAVORITES_PREFIX}default`)
    ).toBeNull();
  });

  it("fails closed without target identity and keeps targets isolated", () => {
    globalThis.localStorage.setItem(
      `${RECENTS_PREFIX}default`,
      '["legacy-model"]'
    );
    const { result, rerender } = renderHook(
      ({ targetId }: { targetId: string | null }) =>
        useComposerModelChoiceHistory(history(targetId, null)),
      { initialProps: { targetId: null as string | null } }
    );

    act(() => {
      result.current.recordRecentModel("new-model");
      result.current.toggleFavoriteModel("new-model");
    });
    expect(result.current.enabled).toBe(false);
    expect(result.current.recentModelIds).toEqual([]);
    expect(globalThis.localStorage.getItem(`${RECENTS_PREFIX}default`)).toBe(
      '["legacy-model"]'
    );
    expect(
      globalThis.localStorage.getItem(`${FAVORITES_PREFIX}default`)
    ).toBeNull();

    rerender({ targetId: "agent:first" });
    expect(result.current.enabled).toBe(true);
    act(() => result.current.recordRecentModel("first-model"));
    expect(
      globalThis.localStorage.getItem(`${RECENTS_PREFIX}agent:first`)
    ).toBe('["first-model"]');
    rerender({ targetId: "agent:second" });
    expect(result.current.recentModelIds).toEqual([]);
  });

  it("refreshes from another window when the menu opens", () => {
    const { result } = renderHook(() =>
      useComposerModelChoiceHistory(history("agent:ccs", null))
    );
    const key = `${RECENTS_PREFIX}agent:ccs`;
    globalThis.localStorage.setItem(key, '["external-model"]');

    act(() => result.current.refreshFromStorage());

    expect(result.current.recentModelIds).toEqual(["external-model"]);
  });
});

function history(
  targetId: string | null,
  testimony: AgentGUIComposerModelChoiceHistoryVM["catalog"]
): AgentGUIComposerModelChoiceHistoryVM {
  return { targetId, catalog: testimony };
}

function catalog(
  modelIds: readonly string[],
  overrides: Partial<
    NonNullable<AgentGUIComposerModelChoiceHistoryVM["catalog"]>
  > = {}
): NonNullable<AgentGUIComposerModelChoiceHistoryVM["catalog"]> {
  return {
    authoritative: true,
    effectiveModel: null,
    loading: false,
    models: modelIds.map((value) => ({ value })),
    ...overrides
  };
}
