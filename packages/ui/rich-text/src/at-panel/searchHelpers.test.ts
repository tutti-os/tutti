import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRichTextAtFilterTabs,
  groupRichTextAtMatches,
  normalizeAtPanelQuery,
  richTextAtGroupExpandCount
} from "./searchHelpers.ts";
import type { RichTextTriggerQueryMatch as RichTextAtQueryMatch } from "../types/trigger.ts";

test("normalizeAtPanelQuery compacts whitespace", () => {
  assert.equal(normalizeAtPanelQuery("  hello   world "), "hello world");
});

test("buildRichTextAtFilterTabs creates all plus one tab per group filter", () => {
  assert.deepEqual(
    buildRichTextAtFilterTabs({
      allLabel: "All",
      groups: [
        { id: "files", label: "Files", providerIds: ["file"] },
        {
          id: "opened-files",
          label: "Files again",
          providerIds: ["file"],
          filterId: "files"
        },
        { id: "issues", label: "Issues", providerIds: ["workspace-issue"] }
      ],
      labels: { files: "Files" }
    }),
    [
      { id: "all", label: "All" },
      { id: "files", label: "Files" },
      { id: "issues", label: "Issues" }
    ]
  );
});

test("groupRichTextAtMatches groups by provider and pages visible items", () => {
  const matches = [
    match("file", "a"),
    match("file", "b"),
    match("file", "c"),
    match("workspace-issue", "i")
  ];
  const groups = groupRichTextAtMatches({
    filterId: "all",
    groups: [
      { id: "files", label: "Files", providerIds: ["file"], pageSize: 2 },
      { id: "issues", label: "Issues", providerIds: ["workspace-issue"] }
    ],
    matches
  });

  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.visibleCount, 2);
  assert.equal(groups[0]?.hasMore, true);
  const fileGroup = groups[0];
  assert.ok(fileGroup);
  assert.equal(richTextAtGroupExpandCount(fileGroup, 2), 1);
  assert.deepEqual(
    groups[1]?.items.map((item) => item.key),
    ["workspace-issue:i"]
  );
});

function match(providerId: string, key: string): RichTextAtQueryMatch {
  return {
    providerId,
    trigger: "@",
    key: `${providerId}:${key}`,
    label: key,
    item: { key },
    insertResult: { kind: "text", text: key }
  };
}
