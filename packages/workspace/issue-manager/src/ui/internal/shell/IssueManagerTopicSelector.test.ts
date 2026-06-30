import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { formatIssueManagerTopicSelectorTriggerLabel } from "./IssueManagerTopicSelector.tsx";

const issueManagerTopicSelectorSource = readFileSync(
  new URL("./IssueManagerTopicSelector.tsx", import.meta.url),
  "utf8"
);

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

test("topic selector trigger uses task header label sizing", () => {
  assert.match(
    issueManagerTopicSelectorSource,
    /<Button[\s\S]*className=\{cn\([\s\S]*max-w-\[220px\][\s\S]*text-\[15px\]/
  );
});
