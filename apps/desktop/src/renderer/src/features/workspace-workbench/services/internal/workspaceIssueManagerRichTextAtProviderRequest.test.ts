import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceIssueManagerRichTextAtProviderRequest,
  createWorkspaceIssueManagerRichTextAtProviderRequestFromIdentity
} from "./workspaceIssueManagerRichTextAtProviderRequest.ts";

test("workspace issue manager rich text at provider request matches Agent GUI capabilities and current user metadata", () => {
  assert.deepEqual(
    createWorkspaceIssueManagerRichTextAtProviderRequest({
      currentUserId: "user-1",
      surface: "issue",
      workspaceId: "workspace-1"
    }),
    {
      capabilities: [
        "workspace-file",
        "workspace-issue",
        "agent-session",
        "workspace-app"
      ],
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
    createWorkspaceIssueManagerRichTextAtProviderRequestFromIdentity({
      currentUser: () => ({
        userId: "user-2"
      }),
      surface: "task",
      workspaceId: "workspace-2"
    }),
    {
      capabilities: [
        "workspace-file",
        "workspace-issue",
        "agent-session",
        "workspace-app"
      ],
      metadata: {
        currentUserId: "user-2"
      },
      surface: "task",
      target: "issue-manager",
      workspaceId: "workspace-2"
    }
  );
});
