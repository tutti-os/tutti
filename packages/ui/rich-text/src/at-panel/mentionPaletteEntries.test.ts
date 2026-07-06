import assert from "node:assert/strict";
import test from "node:test";
import { flattenMentionPaletteEntries } from "./mentionPaletteEntries.ts";
import type {
  MentionPaletteCategory,
  MentionPaletteGroup,
  MentionPaletteState
} from "./mentionPaletteTypes.ts";

type Item = { id: string; kind: string };

function getItemKey(item: Item, _groupId: string): string {
  return `${item.kind}:${item.id}`;
}

function makeGroup(
  id: string,
  items: Item[],
  hasMore = false
): MentionPaletteGroup<Item> {
  return {
    id,
    items,
    totalCount: items.length + (hasMore ? 1 : 0),
    visibleCount: items.length,
    hasMore
  };
}

const categories: MentionPaletteCategory[] = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" }
];

function browseState(
  groups: MentionPaletteGroup<Item>[],
  status: "idle" | "loading" | "ready" = "idle"
): MentionPaletteState<Item> {
  if (status === "idle") {
    return {
      status: "idle",
      query: "",
      mode: "browse",
      filter: "all",
      categories,
      groups,
      error: null
    };
  }
  return {
    status,
    query: "",
    mode: "browse",
    filter: "all",
    categories,
    groups,
    error: null
  };
}

function resultsState(
  groups: MentionPaletteGroup<Item>[]
): MentionPaletteState<Item> {
  return {
    status: "ready",
    query: "hello",
    mode: "results",
    filter: "all",
    categories,
    groups,
    error: null
  };
}

// browse mode, no interactive group entries → only category entries
test("browse mode with no interactive entries produces only category entries", () => {
  const state = browseState([makeGroup("files", [])]);
  const entries = flattenMentionPaletteEntries(state, getItemKey);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    key: "category:all",
    type: "category",
    categoryId: "all"
  });
  assert.deepEqual(entries[1], {
    key: "category:files",
    type: "category",
    categoryId: "files"
  });
});

// browse mode with items → item + expand entries (no category entries)
test("browse mode with items produces item and expand entries, no categories", () => {
  const items: Item[] = [
    { id: "a", kind: "file" },
    { id: "b", kind: "file" }
  ];
  const state = browseState([makeGroup("my_group", items, true)]);
  const entries = flattenMentionPaletteEntries(state, getItemKey);

  assert.equal(entries.length, 3); // 2 items + 1 expand
  assert.deepEqual(entries[0], {
    key: "my_group:file:a",
    type: "item",
    groupId: "my_group",
    itemIndex: 0
  });
  assert.deepEqual(entries[1], {
    key: "my_group:file:b",
    type: "item",
    groupId: "my_group",
    itemIndex: 1
  });
  assert.deepEqual(entries[2], {
    key: "expand:my_group",
    type: "expand",
    groupId: "my_group"
  });
});

// browse mode with items but no hasMore → no expand entry
test("browse mode items without hasMore produces no expand entry", () => {
  const items: Item[] = [{ id: "x", kind: "session" }];
  const state = browseState([makeGroup("sessions", items, false)]);
  const entries = flattenMentionPaletteEntries(state, getItemKey);

  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.type, "item");
  assert.equal(entries[0]?.key, "sessions:session:x");
});

// results mode → no category entries, item + expand per group
test("results mode produces item and expand entries across multiple groups", () => {
  const group1Items: Item[] = [{ id: "1", kind: "issue" }];
  const group2Items: Item[] = [
    { id: "2", kind: "file" },
    { id: "3", kind: "file" }
  ];
  const state = resultsState([
    makeGroup("issues", group1Items, false),
    makeGroup("files", group2Items, true)
  ]);
  const entries = flattenMentionPaletteEntries(state, getItemKey);

  assert.equal(entries.length, 4); // 1 issue + 2 files + 1 expand
  assert.deepEqual(entries[0], {
    key: "issues:issue:1",
    type: "item",
    groupId: "issues",
    itemIndex: 0
  });
  assert.deepEqual(entries[1], {
    key: "files:file:2",
    type: "item",
    groupId: "files",
    itemIndex: 0
  });
  assert.deepEqual(entries[2], {
    key: "files:file:3",
    type: "item",
    groupId: "files",
    itemIndex: 1
  });
  assert.deepEqual(entries[3], {
    key: "expand:files",
    type: "expand",
    groupId: "files"
  });
});

// results mode, empty group → no item entries, no expand
test("results mode with empty group and no hasMore produces no entries for that group", () => {
  const state = resultsState([makeGroup("empty_group", [], false)]);
  const entries = flattenMentionPaletteEntries(state, getItemKey);
  assert.equal(entries.length, 0);
});

// results mode, empty group with hasMore → only expand entry
test("results mode with empty group but hasMore produces only expand entry", () => {
  const state = resultsState([makeGroup("loading_group", [], true)]);
  const entries = flattenMentionPaletteEntries(state, getItemKey);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    key: "expand:loading_group",
    type: "expand",
    groupId: "loading_group"
  });
});

// browse mode with no groups → only category entries
test("browse mode with no groups at all produces only category entries", () => {
  const state = browseState([]);
  const entries = flattenMentionPaletteEntries(state, getItemKey);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.type, "category");
  assert.equal(entries[1]?.type, "category");
});

// browse mode, active category is *structurally* empty (e.g. "No tasks yet")
// → zero entries, not a fallback to the category nav. This is distinct from
// the "no groups at all" / "not loaded yet" case above: here a group is
// present and carries an emptyLabel, meaning the category was resolved and
// genuinely has nothing in it. Regressing this would make the currently
// highlighted category's own header re-resolve as "selectable", so Enter
// re-selects the same category as a no-op forever instead of signalling
// "nothing to commit" to callers (who then treat it as dismiss-then-send).
test("browse mode with a structurally empty active category produces zero entries", () => {
  const state = browseState([
    { ...makeGroup("issues", []), emptyLabel: "No tasks yet" }
  ]);
  const entries = flattenMentionPaletteEntries(state, getItemKey);
  assert.equal(entries.length, 0);
});

// browse mode, structurally empty category alongside an unrelated group that
// still hasn't resolved → the resolved empty group is enough to skip the
// category-nav fallback for the whole flatten call.
test("browse mode with one resolved-empty group among groups produces zero entries", () => {
  const state = browseState([
    { ...makeGroup("opened_files", []), emptyLabel: "No files yet" },
    makeGroup("agent_generated_files", [])
  ]);
  const entries = flattenMentionPaletteEntries(state, getItemKey);
  assert.equal(entries.length, 0);
});

// entry key format matches expected pattern
test("item entry key is groupId:getItemKey result", () => {
  const item: Item = { id: "myId", kind: "workspace-app" };
  const state = resultsState([makeGroup("apps", [item], false)]);
  const entries = flattenMentionPaletteEntries(state, getItemKey);
  assert.equal(entries[0]?.key, "apps:workspace-app:myId");
});
