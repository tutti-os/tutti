import { describe, expect, it } from "vitest";
import { shouldDismissMentionSearchAsNonQuery } from "./agentMentionSearchHelpers";
import type {
  AgentMentionGroup,
  AgentMentionSearchState
} from "./AgentMentionSearchContracts";
import type { AgentContextMentionItem } from "./agentRichText/agentFileMentionExtension";

function createResultsState(
  overrides: Partial<AgentMentionSearchState>
): AgentMentionSearchState {
  return {
    status: "ready",
    query: "hello world",
    mode: "results",
    filter: "session",
    categories: [],
    groups: [],
    error: null,
    ...overrides
  } as AgentMentionSearchState;
}

function createGroup(
  items: readonly AgentContextMentionItem[]
): AgentMentionGroup {
  return {
    id: "my_sessions",
    items,
    totalCount: items.length,
    visibleCount: items.length,
    hasMore: false
  };
}

const fileItem = {
  kind: "file",
  name: "hello world.md"
} as AgentContextMentionItem;

describe("shouldDismissMentionSearchAsNonQuery", () => {
  it("dismisses a settled multi-word query with zero results", () => {
    expect(
      shouldDismissMentionSearchAsNonQuery(createResultsState({ groups: [] }))
    ).toBe(true);
    expect(
      shouldDismissMentionSearchAsNonQuery(
        createResultsState({ groups: [createGroup([])] })
      )
    ).toBe(true);
  });

  it("keeps a single-word miss visible so category tabs stay reachable", () => {
    expect(
      shouldDismissMentionSearchAsNonQuery(
        createResultsState({ query: "zzz-no-match", groups: [] })
      )
    ).toBe(false);
  });

  it("keeps a multi-word query with matching results visible", () => {
    expect(
      shouldDismissMentionSearchAsNonQuery(
        createResultsState({ groups: [createGroup([fileItem])] })
      )
    ).toBe(false);
  });

  it("never dismisses while the search is still loading", () => {
    expect(
      shouldDismissMentionSearchAsNonQuery(
        createResultsState({ status: "loading", groups: [] })
      )
    ).toBe(false);
  });

  it("never dismisses browse mode or error states", () => {
    expect(
      shouldDismissMentionSearchAsNonQuery(
        createResultsState({ mode: "browse", query: "" })
      )
    ).toBe(false);
    expect(
      shouldDismissMentionSearchAsNonQuery(
        createResultsState({ status: "error", error: "boom" })
      )
    ).toBe(false);
  });
});
