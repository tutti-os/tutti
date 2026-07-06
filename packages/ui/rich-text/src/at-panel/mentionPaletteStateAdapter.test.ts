import assert from "node:assert/strict";
import test from "node:test";
import { createMentionPaletteStateAdapter } from "./mentionPaletteStateAdapter.ts";
import type {
  MentionPaletteCategory,
  MentionPaletteState
} from "./mentionPaletteTypes.ts";

type Item = { id: string };

function getItemKey(item: Item, _groupId: string): string {
  return item.id;
}

const categories: MentionPaletteCategory[] = [
  { id: "session", label: "Sessions" },
  { id: "issue", label: "Tasks" }
];

// Regression coverage for the "@ panel Enter is stuck" bug: pressing Enter
// while the active category is inherently empty (e.g. "Tasks" with zero
// items, never having had a search query typed) used to be a silent no-op
// forever, instead of behaving like the already-fixed "search resolved to
// zero results" case. Enter should be able to dismiss/commit here just like
// it does for a zero-result search, rather than re-selecting the same
// already-active category.

test("commitHighlighted treats a zero-result search (results mode) as nothing to commit", () => {
  const state: MentionPaletteState<Item> = {
    status: "ready",
    query: "doesnotexist",
    mode: "results",
    filter: "issue",
    categories,
    groups: [],
    error: null
  };
  const adapter = createMentionPaletteStateAdapter({
    state,
    highlightedKey: null,
    getItemKey
  });

  const result = adapter.commitHighlighted();
  assert.deepEqual(result, { type: "none" });
});

test("commitHighlighted treats a structurally empty active category (browse mode) as nothing to commit", () => {
  // The user opened @ (no query typed → mode stays "browse") and switched to
  // the "issue" (Tasks) category, which has zero tasks from the start. The
  // controller still resolves a group for the active category so the real
  // "No tasks yet" empty state can render — see AgentMentionSearchController's
  // shouldShowEmptyGroup/buildEmptyGroup — so `groups` is non-empty even
  // though nothing in it is interactive.
  const state: MentionPaletteState<Item> = {
    status: "ready",
    query: "",
    mode: "browse",
    filter: "issue",
    categories,
    groups: [
      {
        id: "issues",
        items: [],
        totalCount: 0,
        visibleCount: 0,
        hasMore: false,
        emptyLabel: "No tasks yet"
      }
    ],
    error: null
  };

  // Highlighting the active category's own header entry is what the
  // composer's highlight-repair effect lands on for this state (there is
  // nothing else to flatten into a highlightable entry).
  const adapter = createMentionPaletteStateAdapter({
    state,
    highlightedKey: "category:issue",
    getItemKey
  });

  const result = adapter.commitHighlighted();
  assert.deepEqual(result, { type: "none" });
});

test("commitHighlighted still lets Enter drill into an unselected category from the top-level browse list", () => {
  // Sanity check that the fix does not break genuine category navigation:
  // when nothing is loaded yet for the active category (groups: []), the
  // highlighted entry can legitimately be a *different* category's header,
  // and committing it should still select that category rather than being
  // swallowed as "none".
  const state: MentionPaletteState<Item> = {
    status: "loading",
    query: "",
    mode: "browse",
    filter: "session",
    categories,
    groups: [],
    error: null
  };

  const adapter = createMentionPaletteStateAdapter({
    state,
    highlightedKey: "category:issue",
    getItemKey
  });

  const result = adapter.commitHighlighted();
  assert.deepEqual(result, { type: "category", categoryId: "issue" });
});
