import assert from "node:assert/strict";
import test from "node:test";
import type { RichTextTriggerQueryMatch } from "@tutti-os/ui-rich-text/types";
import {
  serializeWorkspaceAppExternalAtInsert,
  serializeWorkspaceAppExternalAtMatch,
  toExternalAtProviderId
} from "./workspaceAppExternalAtSerialization.ts";

type TestMentionInsert = Extract<
  RichTextTriggerQueryMatch["insertResult"],
  { kind: "mention" }
>;

function mentionInsert(mention: Record<string, unknown>): TestMentionInsert {
  return {
    kind: "mention",
    mention: mention as unknown as TestMentionInsert["mention"]
  };
}

test("accepts external at provider ids", () => {
  assert.equal(toExternalAtProviderId("file"), "file");
  assert.equal(toExternalAtProviderId("workspace-issue"), "workspace-issue");
  assert.equal(toExternalAtProviderId("agent-target"), "agent-target");
  assert.equal(toExternalAtProviderId("unsupported"), null);
});

test("serializes mention insert results", () => {
  assert.deepEqual(
    serializeWorkspaceAppExternalAtInsert(
      mentionInsert({
        entityId: "issue-1",
        label: "Fix bug",
        scope: {
          topicId: "topic-1",
          workspaceId: "workspace-1"
        },
        presentation: {
          description: "Fix the broken flow",
          status: "open"
        }
      })
    ),
    {
      kind: "mention",
      mention: {
        entityId: "issue-1",
        label: "Fix bug",
        scope: {
          topicId: "topic-1",
          workspaceId: "workspace-1"
        },
        presentation: {
          description: "Fix the broken flow",
          status: "open"
        }
      }
    }
  );
});

test("serializes mention icon presentation as external thumbnail metadata", () => {
  assert.deepEqual(
    serializeWorkspaceAppExternalAtInsert(
      mentionInsert({
        entityId: "agent-codex",
        label: "Codex",
        scope: {
          workspaceId: "workspace-1"
        },
        presentation: {
          description: "Start a Codex session",
          iconUrl: "tutti-asset://agent/codex.png",
          subtitle: "Start a Codex session"
        }
      })
    ),
    {
      kind: "mention",
      mention: {
        entityId: "agent-codex",
        label: "Codex",
        scope: {
          workspaceId: "workspace-1"
        },
        presentation: {
          description: "Start a Codex session",
          iconUrl: "tutti-asset://agent/codex.png",
          subtitle: "Start a Codex session",
          thumbnailUrl: "tutti-asset://agent/codex.png"
        }
      }
    }
  );
});

test("does not pass legacy mention metadata through to external apps", () => {
  assert.deepEqual(
    serializeWorkspaceAppExternalAtInsert(
      mentionInsert({
        entityId: "issue-1",
        href: "mention://workspace-issue?issueId=issue-1",
        kind: "workspace-issue",
        label: "Fix bug",
        meta: {
          status: "open"
        }
      })
    ),
    {
      kind: "mention",
      mention: {
        entityId: "issue-1",
        label: "Fix bug"
      }
    }
  );
});

test("serializes markdown link and text insert results", () => {
  assert.deepEqual(
    serializeWorkspaceAppExternalAtInsert({
      kind: "markdown-link",
      href: "README.md",
      label: "README.md"
    }),
    {
      kind: "markdown-link",
      href: "README.md",
      label: "README.md"
    }
  );
  assert.deepEqual(
    serializeWorkspaceAppExternalAtInsert({
      kind: "text",
      text: "plain text"
    }),
    {
      kind: "text",
      text: "plain text"
    }
  );
});

test("serializes rich text at matches without exposing raw item", () => {
  const match: RichTextTriggerQueryMatch = {
    providerId: "file",
    trigger: "@",
    key: "README.md",
    label: "README.md",
    subtitle: "README.md",
    iconUrl: "tutti://workspace-apps/automation/icon.png",
    item: {
      raw: true
    },
    insertResult: {
      kind: "markdown-link",
      href: "README.md",
      label: "README.md"
    }
  };

  assert.deepEqual(serializeWorkspaceAppExternalAtMatch(match), {
    providerId: "file",
    itemId: "README.md",
    label: "README.md",
    subtitle: "README.md",
    thumbnailUrl: "tutti://workspace-apps/automation/icon.png",
    insert: {
      kind: "markdown-link",
      href: "README.md",
      label: "README.md"
    }
  });
});

test("serializes mention item id from insert identity for external restore", () => {
  const match: RichTextTriggerQueryMatch = {
    providerId: "workspace-app",
    trigger: "@",
    key: "app-key",
    label: "Codex",
    iconUrl: "tutti-asset://agent/codex.png",
    item: {},
    insertResult: {
      kind: "mention",
      mention: {
        entityId: "agent-codex",
        label: "Codex",
        presentation: {
          iconUrl: "tutti-asset://agent/codex.png"
        }
      }
    }
  };

  assert.deepEqual(serializeWorkspaceAppExternalAtMatch(match), {
    providerId: "workspace-app",
    itemId: "agent-codex",
    label: "Codex",
    thumbnailUrl: "tutti-asset://agent/codex.png",
    insert: {
      kind: "mention",
      mention: {
        entityId: "agent-codex",
        label: "Codex",
        presentation: {
          iconUrl: "tutti-asset://agent/codex.png",
          thumbnailUrl: "tutti-asset://agent/codex.png"
        }
      }
    }
  });
});
