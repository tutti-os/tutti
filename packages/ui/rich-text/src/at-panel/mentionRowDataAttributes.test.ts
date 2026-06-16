import assert from "node:assert/strict";
import test from "node:test";
import {
  mentionRowDataAttribute,
  mentionRowRootDataAttributes
} from "./mentionRowDataAttributes.ts";

test("shared mention row data hooks are the default package vocabulary", () => {
  assert.deepEqual(mentionRowRootDataAttributes("shared", "file"), {
    "data-rich-text-at-mention-row": "true",
    "data-rich-text-at-mention-kind": "file"
  });
  assert.deepEqual(
    mentionRowDataAttribute("shared", "fileVisualKind", "document"),
    {
      "data-rich-text-at-mention-file-visual-kind": "document"
    }
  );
});

test("agent mode keeps the legacy agent data hooks for compatibility", () => {
  assert.deepEqual(mentionRowRootDataAttributes("agent", "file"), {
    "data-agent-file-mention": "true",
    "data-agent-mention-kind": "file"
  });
  assert.deepEqual(
    mentionRowDataAttribute("agent", "fileVisualKind", "document"),
    {
      "data-agent-file-visual-kind": "document"
    }
  );
});
