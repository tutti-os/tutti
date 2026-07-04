import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceIssueManagerRichTextTriggerProviderRequest,
  createWorkspaceIssueManagerRichTextTriggerProviderRequestFromIdentity
} from "./workspaceIssueManagerRichTextTriggerProviderRequest.ts";

test("workspace issue manager rich text at provider request enables agent and app mentions", () => {
  assert.deepEqual(
    createWorkspaceIssueManagerRichTextTriggerProviderRequest({
      currentUserId: "user-1",
      surface: "issue",
      workspaceId: "workspace-1"
    }),
    {
      capabilities: ["agent-target", "workspace-app"],
      metadata: {
        currentUserId: "user-1"
      },
      surface: "issue",
      target: "issue-manager",
      workspaceId: "workspace-1"
    }
  );
});

test("workspace issue manager rich text at provider request reads current user metadata from identity source", () => {
  assert.deepEqual(
    createWorkspaceIssueManagerRichTextTriggerProviderRequestFromIdentity({
      currentUser: () => ({
        userId: "user-2"
      }),
      surface: "task",
      workspaceId: "workspace-2"
    }),
    {
      capabilities: ["agent-target", "workspace-app"],
      metadata: {
        currentUserId: "user-2"
      },
      surface: "task",
      target: "issue-manager",
      workspaceId: "workspace-2"
    }
  );
});
