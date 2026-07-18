import assert from "node:assert/strict";
import test from "node:test";
import type { RichTextTriggerQueryMatch } from "@tutti-os/ui-rich-text/types";
import { serializeWorkspaceAppExternalAtMatch } from "./workspaceAppExternalAtSerialization.ts";
import { workspaceAppExternalAgentIconDataUrlsByIconKey } from "./workspaceAppExternalAgentIconDataUrls.ts";

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
  assert.equal(
    serializeWorkspaceAppExternalAtMatch(
      createMatch({
        providerId: "file"
      })
    )?.providerId,
    "file"
  );
  assert.equal(
    serializeWorkspaceAppExternalAtMatch(
      createMatch({
        providerId: "workspace-issue"
      })
    )?.providerId,
    "workspace-issue"
  );
  assert.equal(
    serializeWorkspaceAppExternalAtMatch(
      createMatch({
        providerId: "agent-target"
      })
    )?.providerId,
    "agent-target"
  );
  assert.equal(
    serializeWorkspaceAppExternalAtMatch(
      createMatch({
        providerId: "unsupported"
      })
    ),
    null
  );
});

test("serializes mention insert results", () => {
  assert.deepEqual(
    serializeInsert(
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

test("serializes mention presentation with one canonical nested icon field", () => {
  assert.deepEqual(
    serializeInsert(
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
          subtitle: "Start a Codex session"
        }
      }
    }
  );
});

test("does not pass legacy mention metadata through to external apps", () => {
  assert.deepEqual(
    serializeInsert(
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
    serializeInsert({
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
    serializeInsert({
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
          iconUrl: "tutti-asset://agent/codex.png"
        }
      }
    }
  });
});

test("replaces managed Agent file icons with guest-loadable asset urls", () => {
  const match: RichTextTriggerQueryMatch = {
    providerId: "agent-target",
    trigger: "@",
    key: "local:cursor",
    label: "Cursor",
    iconUrl: "file:///Applications/Tutti.app/cursor-colorful-abc123.png",
    item: {},
    insertResult: {
      kind: "mention",
      mention: {
        entityId: "local:cursor",
        label: "Cursor",
        presentation: {
          agentProviderId: "cursor",
          iconUrl: "file:///Applications/Tutti.app/cursor-colorful-abc123.png"
        }
      }
    }
  };

  const cursorIconDataUrl =
    workspaceAppExternalAgentIconDataUrlsByIconKey.cursor;
  assert.deepEqual(serializeWorkspaceAppExternalAtMatch(match), {
    providerId: "agent-target",
    itemId: "local:cursor",
    label: "Cursor",
    thumbnailUrl: cursorIconDataUrl,
    insert: {
      kind: "mention",
      mention: {
        entityId: "local:cursor",
        label: "Cursor",
        presentation: {
          agentProviderId: "cursor",
          iconUrl: cursorIconDataUrl
        }
      }
    }
  });
});

test("keeps every managed Agent external icon within the 64px data-url budget", () => {
  for (const [iconKey, dataUrl] of Object.entries(
    workspaceAppExternalAgentIconDataUrlsByIconKey
  )) {
    assert.match(dataUrl, /^data:image\/webp;base64,/);
    const bytes = Buffer.from(dataUrl.split(",", 2)[1] ?? "", "base64");
    assert.ok(bytes.byteLength <= 2_048, `${iconKey} exceeds 2 KiB`);
    assert.deepEqual(readLossyWebpDimensions(bytes), {
      width: 64,
      height: 64
    });
  }
});

test("preserves remote and data Agent icons for external apps", () => {
  for (const iconUrl of [
    "https://cdn.example.com/gemini.png",
    "data:image/svg+xml;base64,gemini"
  ]) {
    const match: RichTextTriggerQueryMatch = {
      providerId: "agent-target",
      trigger: "@",
      key: "extension:gemini",
      label: "Gemini",
      iconUrl,
      item: {},
      insertResult: {
        kind: "mention",
        mention: {
          entityId: "extension:gemini",
          label: "Gemini",
          presentation: {
            agentProviderId: "acp:gemini",
            iconUrl
          }
        }
      }
    };

    assert.equal(
      serializeWorkspaceAppExternalAtMatch(match)?.thumbnailUrl,
      iconUrl
    );
  }
});

function createMatch(
  input: Partial<RichTextTriggerQueryMatch> = {}
): RichTextTriggerQueryMatch {
  return {
    iconUrl: "tutti://workspace-apps/automation/icon.png",
    insertResult: {
      kind: "text",
      text: "plain text"
    },
    item: {},
    key: "item-key",
    label: "Label",
    providerId: "file",
    trigger: "@",
    ...input
  };
}

function serializeInsert(
  insertResult: RichTextTriggerQueryMatch["insertResult"]
) {
  return serializeWorkspaceAppExternalAtMatch(
    createMatch({
      insertResult
    })
  )?.insert;
}

function readLossyWebpDimensions(bytes: Buffer): {
  width: number;
  height: number;
} {
  const frameHeaderOffset = bytes.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
  assert.notEqual(frameHeaderOffset, -1, "missing lossy WebP frame header");
  return {
    width: bytes.readUInt16LE(frameHeaderOffset + 3) & 0x3fff,
    height: bytes.readUInt16LE(frameHeaderOffset + 5) & 0x3fff
  };
}
