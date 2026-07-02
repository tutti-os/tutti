import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

const richTextTriggerEditorSource = readFileSync(
  new URL("./RichTextTriggerEditor.tsx", import.meta.url),
  "utf8"
);

test("palette trigger editor only prevents Enter when a palette entry commits", () => {
  assert.doesNotMatch(richTextTriggerEditorSource, /makeAtPanelKeyDown/);
  assert.match(
    richTextTriggerEditorSource,
    /if \(event\.key === "Enter"\)[\s\S]*if \(entry\?\.type !== "item" \|\| !entry\.groupId\) \{[\s\S]*return;[\s\S]*if \(match\) \{[\s\S]*event\.preventDefault\(\);[\s\S]*applyMatch\(match\);/
  );
});
