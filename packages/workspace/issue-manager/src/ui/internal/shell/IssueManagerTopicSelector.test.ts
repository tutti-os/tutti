import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatIssueManagerTopicSelectorTriggerLabel } from "./IssueManagerTopicSelector.tsx";

const topicSelectorSource = readFileSync(
  new URL("./IssueManagerTopicSelector.tsx", import.meta.url),
  "utf8"
);

test("topic selector keeps its outer menu open while interacting with nested actions", () => {
  assert.match(
    topicSelectorSource,
    /<DropdownMenu\s+modal=\{false\}\s+open=\{menuOpen\}/
  );
  assert.equal(
    topicSelectorSource.match(
      /style=\{\{ zIndex: "var\(--z-panel-popover\)" \}\}/g
    )?.length,
    2
  );
});

test("topic selector prefixes active topic titles with localized topic labels", () => {
  assert.equal(
    formatIssueManagerTopicSelectorTriggerLabel({
      title: "work",
      topicLabel: "Topic"
    }),
    "Topic-work"
  );
  assert.equal(
    formatIssueManagerTopicSelectorTriggerLabel({
      title: "工作",
      topicLabel: "主题"
    }),
    "主题-工作"
  );
});

test("topic selector uses the topic label placeholder without an active title", () => {
  assert.equal(
    formatIssueManagerTopicSelectorTriggerLabel({
      title: "",
      topicLabel: "Topic"
    }),
    "Topic"
  );
});
