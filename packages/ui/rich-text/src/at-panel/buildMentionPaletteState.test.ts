import assert from "node:assert/strict";
import test from "node:test";
import { buildMentionPaletteState } from "./buildMentionPaletteState.ts";
import type { RichTextTriggerQueryMatch as RichTextAtQueryMatch } from "../types/trigger.ts";
import type { RichTextTriggerProviderGroup } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMatch(providerId: string, key: string): RichTextAtQueryMatch {
  return {
    providerId,
    trigger: "@",
    key: `${providerId}:${key}`,
    label: key,
    item: { key },
    insertResult: { kind: "text", text: key }
  };
}

const GROUP_FILES: RichTextTriggerProviderGroup = {
  id: "files",
  label: "Files",
  providerIds: ["file"]
};

const GROUP_ISSUES: RichTextTriggerProviderGroup = {
  id: "issues",
  label: "Issues",
  providerIds: ["workspace-issue"]
};

const PROVIDER_GROUPS = [GROUP_FILES, GROUP_ISSUES] as const;

const FILTER_TABS = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" },
  { id: "issues", label: "Issues" }
] as const;

const BASE_INPUT = {
  providerGroups: PROVIDER_GROUPS,
  filterTabs: FILTER_TABS,
  activeFilterId: "all",
  expandedCounts: {} as Record<string, number | undefined>,
  isLoading: false
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("empty query → mode:'browse', status:'idle', categories and groups present", () => {
  const matches = [makeMatch("file", "readme")];
  const state = buildMentionPaletteState({
    ...BASE_INPUT,
    matches,
    query: ""
  });

  assert.equal(state.status, "idle");
  assert.equal(state.mode, "browse");
  assert.deepEqual(state.categories, FILTER_TABS);
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0]?.id, "files");
  assert.equal(state.error, null);
});

test("empty query + isLoading → mode:'browse', status:'loading'", () => {
  const state = buildMentionPaletteState({
    ...BASE_INPUT,
    matches: [],
    query: "",
    isLoading: true
  });

  assert.equal(state.status, "loading");
  assert.equal(state.mode, "browse");
  assert.equal(state.error, null);
});

test("non-empty query → mode:'results', status:'ready'", () => {
  const matches = [makeMatch("workspace-issue", "1")];
  const state = buildMentionPaletteState({
    ...BASE_INPUT,
    matches,
    query: "bug"
  });

  assert.equal(state.status, "ready");
  assert.equal(state.mode, "results");
  assert.equal(state.query, "bug");
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0]?.id, "issues");
});

test("non-empty query + isLoading → mode:'results', status:'loading'", () => {
  const state = buildMentionPaletteState({
    ...BASE_INPUT,
    matches: [],
    query: "foo",
    isLoading: true
  });

  assert.equal(state.status, "loading");
  assert.equal(state.mode, "results");
});

test("group with more items than pageSize → hasMore:true, expandLabel set from showMoreLabel", () => {
  const pageSize = 2;
  const matches = [
    makeMatch("file", "a"),
    makeMatch("file", "b"),
    makeMatch("file", "c")
  ];
  const showMoreLabel = (count: number) => `Show ${count} more`;

  const state = buildMentionPaletteState({
    ...BASE_INPUT,
    matches,
    query: "x",
    pageSize,
    showMoreLabel
  });

  const filesGroup = state.groups.find((g) => g.id === "files");
  assert.ok(filesGroup, "files group should be present");
  assert.equal(filesGroup.hasMore, true);
  assert.equal(filesGroup.visibleCount, 2);
  assert.equal(filesGroup.totalCount, 3);
  // remaining = totalCount - visibleCount = 1
  assert.equal(filesGroup.expandLabel, "Show 1 more");
});

test("group without hasMore → expandLabel is undefined even when showMoreLabel is provided", () => {
  const matches = [makeMatch("file", "a")];
  const showMoreLabel = (count: number) => `Show ${count} more`;

  const state = buildMentionPaletteState({
    ...BASE_INPUT,
    matches,
    query: "x",
    showMoreLabel
  });

  const filesGroup = state.groups.find((g) => g.id === "files");
  assert.ok(filesGroup);
  assert.equal(filesGroup.hasMore, false);
  assert.equal(filesGroup.expandLabel, undefined);
});

test("activeFilterId filters groups — only matching group items appear", () => {
  const matches = [
    makeMatch("file", "readme"),
    makeMatch("workspace-issue", "42")
  ];

  const state = buildMentionPaletteState({
    ...BASE_INPUT,
    matches,
    query: "test",
    activeFilterId: "files"
  });

  // Only the files group should be visible
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0]?.id, "files");
  assert.equal(state.groups[0]?.items.length, 1);
  assert.equal(state.groups[0]?.items[0]?.providerId, "file");
});

test("categories always equal the passed filterTabs", () => {
  const customTabs = [
    { id: "a", label: "A" },
    { id: "b", label: "B" }
  ];

  const state = buildMentionPaletteState({
    ...BASE_INPUT,
    matches: [],
    query: "",
    filterTabs: customTabs
  });

  assert.deepEqual(state.categories, customTabs);
});

test("expandedCounts overrides default page size", () => {
  const matches = [
    makeMatch("file", "a"),
    makeMatch("file", "b"),
    makeMatch("file", "c"),
    makeMatch("file", "d"),
    makeMatch("file", "e"),
    makeMatch("file", "f")
  ];

  // Default page size is DEFAULT_RICH_TEXT_AT_PANEL_PAGE_SIZE (5)
  // With expandedCounts of 6, all 6 should be visible
  const state = buildMentionPaletteState({
    ...BASE_INPUT,
    matches,
    query: "x",
    expandedCounts: { files: 6 }
  });

  const filesGroup = state.groups.find((g) => g.id === "files");
  assert.ok(filesGroup);
  assert.equal(filesGroup.visibleCount, 6);
  assert.equal(filesGroup.hasMore, false);
});

test("filter field reflects activeFilterId", () => {
  const state = buildMentionPaletteState({
    ...BASE_INPUT,
    matches: [],
    query: "",
    activeFilterId: "issues"
  });

  assert.equal(state.filter, "issues");
});
