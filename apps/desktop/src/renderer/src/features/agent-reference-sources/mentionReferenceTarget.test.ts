import assert from "node:assert/strict";
import test from "node:test";
import type { AgentGUIProps } from "@tutti-os/agent-gui";
import { resolveMentionReferenceTarget } from "./mentionReferenceTarget.ts";
import { APP_ARTIFACT_SOURCE_ID } from "./appArtifactReferenceSource.ts";
import { ISSUE_SOURCE_ID } from "./issueReferenceSource.ts";

type MentionItem = Parameters<
  NonNullable<AgentGUIProps["workspace"]["resolveMentionReferenceTarget"]>
>[0];

function referenceItem(
  fields: Partial<Extract<MentionItem, { kind: "workspace-reference" }>>
): MentionItem {
  return {
    kind: "workspace-reference",
    href: "mention://workspace-reference/x",
    workspaceId: "ws-1",
    targetId: "",
    source: "app",
    name: "Ref",
    fileCount: 0,
    ...fields
  };
}

test("app workspace-reference maps to the app source with appId + groupId", () => {
  assert.deepEqual(
    resolveMentionReferenceTarget(
      referenceItem({ source: "app", targetId: "vibe-design", groupId: "g-9" })
    ),
    {
      sourceId: APP_ARTIFACT_SOURCE_ID,
      params: { appId: "vibe-design", groupId: "g-9" }
    }
  );
});

test("task workspace-reference maps to the issue source with topicId + issueId", () => {
  assert.deepEqual(
    resolveMentionReferenceTarget(
      referenceItem({ source: "task", targetId: "topic-1", groupId: "issue-9" })
    ),
    {
      sourceId: ISSUE_SOURCE_ID,
      params: { topicId: "topic-1", issueId: "issue-9" }
    }
  );
});

test("task workspace-reference without a group maps to the topic only", () => {
  assert.deepEqual(
    resolveMentionReferenceTarget(
      referenceItem({ source: "task", targetId: "topic-1" })
    ),
    { sourceId: ISSUE_SOURCE_ID, params: { topicId: "topic-1" } }
  );
});

test("app workspace-reference without an appId is unresolvable", () => {
  assert.equal(
    resolveMentionReferenceTarget(
      referenceItem({ source: "app", targetId: "" })
    ),
    null
  );
});
