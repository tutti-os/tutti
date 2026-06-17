import assert from "node:assert/strict";
import test from "node:test";
import type { RichTextAtQueryMatch } from "../types/at.ts";
import {
  createRichTextAtEditorMatchEntry,
  findRichTextAtEditorEntryKeyForMatch,
  moveRichTextAtEditorActiveEntryKey,
  resolveRichTextAtEditorActiveEntryKey,
  type RichTextAtEditorNavigationEntry
} from "./richTextAtEditorNavigation.ts";

test("resolveRichTextAtEditorActiveEntryKey keeps active key only while visible", () => {
  const entries = [
    createRichTextAtEditorMatchEntry(testMatch("files", "a"), "files:a"),
    createRichTextAtEditorMatchEntry(testMatch("apps", "b"), "apps:b")
  ];

  assert.equal(
    resolveRichTextAtEditorActiveEntryKey({
      entries,
      activeEntryKey: "apps:b"
    }),
    "apps:b"
  );
  assert.equal(
    resolveRichTextAtEditorActiveEntryKey({
      entries,
      activeEntryKey: "sessions:c"
    }),
    "files:a"
  );
});

test("moveRichTextAtEditorActiveEntryKey navigates match and action entries", () => {
  const calls: string[] = [];
  const entries: RichTextAtEditorNavigationEntry[] = [
    createRichTextAtEditorMatchEntry(testMatch("files", "a"), "files:a"),
    {
      key: "expand:files",
      type: "action",
      onSelect: () => calls.push("expand")
    },
    createRichTextAtEditorMatchEntry(testMatch("apps", "b"), "apps:b")
  ];

  assert.equal(
    moveRichTextAtEditorActiveEntryKey({
      entries,
      activeEntryKey: null,
      delta: 1
    }),
    "files:a"
  );
  assert.equal(
    moveRichTextAtEditorActiveEntryKey({
      entries,
      activeEntryKey: "files:a",
      delta: 1
    }),
    "expand:files"
  );
  assert.equal(
    moveRichTextAtEditorActiveEntryKey({
      entries,
      activeEntryKey: "files:a",
      delta: -1
    }),
    "apps:b"
  );

  const expandEntry = entries[1];
  if (expandEntry?.type === "action") {
    expandEntry.onSelect();
  }
  assert.deepEqual(calls, ["expand"]);
});

test("findRichTextAtEditorEntryKeyForMatch returns panel-specific keys", () => {
  const match = testMatch("workspace-app", "weather");
  const entries = [
    createRichTextAtEditorMatchEntry(match, "apps:workspace-app:weather")
  ];

  assert.equal(
    findRichTextAtEditorEntryKeyForMatch(entries, match),
    "apps:workspace-app:weather"
  );
});

function testMatch(providerId: string, key: string): RichTextAtQueryMatch {
  return {
    providerId,
    key,
    label: key,
    item: { key },
    insertResult: {
      kind: "text",
      text: key
    }
  };
}
