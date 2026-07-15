import { describe, expect, it } from "vitest";
import type { Editor, Range } from "@tiptap/core";
import { Schema } from "@tiptap/pm/model";
import {
  attrsToMentionItem,
  createAgentSessionMarkdownLink,
  createAgentSessionMentionHref,
  expandRangeOverMentionPlaceholder,
  formatAgentMentionMarkdown,
  mentionItemToAttrs,
  parseAgentMentionMarkdown,
  parseMentionItemFromHref
} from "./agentFileMentionExtension";
import {
  registerAgentCustomMentionKind,
  resetAgentCustomMentionKindsForTests
} from "../../../shared/agentCustomMentionKinds";
import { createRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import { managedAgentRoundedIconUrl } from "../../../shared/managedAgentIcons";

const placeholderSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }]
    },
    // Leaf inline node standing in for an already-inserted mention chip.
    chip: { group: "inline", inline: true, atom: true },
    text: { group: "inline" }
  }
});

/**
 * Build a fake editor whose paragraph is `text`, then locate the `@` and return
 * an empty-query suggestion range over it — mirroring what the Suggestion plugin
 * hands {@link expandRangeOverMentionPlaceholder} when a user types `@`.
 */
function editorForPlaceholder(text: string): { editor: Editor; range: Range } {
  const doc = placeholderSchema.node("doc", null, [
    placeholderSchema.node("paragraph", null, [placeholderSchema.text(text)])
  ]);
  const editor = { state: { doc } } as unknown as Editor;
  const atPos = text.indexOf("@") + 1; // +1 for the paragraph open token
  return { editor, range: { from: atPos, to: atPos + 1 } };
}

describe("parseAgentMentionMarkdown", () => {
  it("accepts plain workspace file markdown links without an @ prefix", () => {
    expect(
      parseAgentMentionMarkdown("[README.md](/workspace/docs/README.md)")
    ).toEqual({
      item: {
        kind: "file",
        href: "/workspace/docs/README.md",
        path: "/workspace/docs/README.md",
        name: "README.md",
        entryKind: "unknown",
        directoryPath: "/workspace/docs"
      },
      end: 38
    });
  });

  it("keeps trailing-slash local paths as directory mentions", () => {
    expect(
      parseAgentMentionMarkdown(
        "[@superpowers](/Users/test/project/tutti/superpowers/)"
      )
    ).toEqual({
      item: {
        kind: "file",
        href: "/Users/test/project/tutti/superpowers/",
        path: "/Users/test/project/tutti/superpowers/",
        name: "superpowers",
        entryKind: "directory",
        directoryPath: "/Users/test/project/tutti"
      },
      end: 54
    });
  });

  it("does not classify trailing-slash URLs as directory mentions", () => {
    expect(
      parseAgentMentionMarkdown("[@OpenAI](https://openai.com/)")
    ).toMatchObject({
      item: {
        href: "https://openai.com/",
        entryKind: "unknown"
      }
    });
  });

  it("accepts generic session mention hrefs", () => {
    const parsed = parseAgentMentionMarkdown(
      "[@Session](mention://agent-session/session-1?agentTargetId=local%3Aclaude-code&workspaceId=workspace-1)"
    );
    expect(parsed).toMatchObject({
      item: {
        kind: "session",
        workspaceId: "workspace-1",
        targetId: "session-1",
        agentTargetId: "local:claude-code",
        name: "Session"
      }
    });
    expect(mentionItemToAttrs(parsed!.item).iconUrl).toBe(
      managedAgentRoundedIconUrl("claude-code")
    );
  });

  it("derives the Cursor icon for a pasted local session mention", () => {
    const parsed = parseAgentMentionMarkdown(
      "[@Cursor session](mention://agent-session/session-1?agentTargetId=local%3Acursor&workspaceId=workspace-1)"
    );

    expect(mentionItemToAttrs(parsed!.item).iconUrl).toBe(
      managedAgentRoundedIconUrl("cursor")
    );
  });

  it("parses registered custom mention kinds into custom items", () => {
    registerAgentCustomMentionKind({
      kind: "external-note",
      present: (mention) => ({
        name: mention.label,
        summary: mention.scope?.preview?.trim() || undefined,
        workspaceId: mention.scope?.spaceId?.trim() || undefined
      })
    });
    try {
      expect(
        parseAgentMentionMarkdown(
          "[@两条外部笔记](mention://external-note/note-a?ids=note-a%2Cnote-b&preview=hello&spaceId=space-1)"
        )
      ).toMatchObject({
        item: {
          kind: "custom",
          customKind: "external-note",
          workspaceId: "space-1",
          targetId: "note-a",
          summary: "hello",
          name: "两条外部笔记"
        }
      });
    } finally {
      resetAgentCustomMentionKindsForTests();
    }
  });

  it("rejects unregistered custom mention kinds", () => {
    expect(
      parseAgentMentionMarkdown(
        "[@两条外部笔记](mention://external-note/note-a?spaceId=space-1)"
      )
    ).toBeNull();
  });

  it("round-trips custom items through attrs", () => {
    registerAgentCustomMentionKind({
      kind: "external-note",
      present: (mention) => ({
        name: mention.label,
        summary: mention.scope?.preview?.trim() || undefined,
        workspaceId: mention.scope?.spaceId?.trim() || undefined
      })
    });
    try {
      const href =
        "mention://external-note/note-a?ids=note-a%2Cnote-b&preview=hello&spaceId=space-1";
      const parsed = parseMentionItemFromHref({
        name: "两条外部笔记",
        href
      });
      expect(parsed).not.toBeNull();
      expect(attrsToMentionItem(mentionItemToAttrs(parsed!))).toEqual(parsed);
      // markdown 序列化走 default 分支(canonical href round-trip 无损)。
      expect(formatAgentMentionMarkdown(parsed!)).toContain(
        "mention://external-note/note-a"
      );
    } finally {
      resetAgentCustomMentionKindsForTests();
    }
  });

  it("accepts workspace app mention hrefs without an @ prefix", () => {
    expect(
      parseAgentMentionMarkdown(
        "[任务管理](mention://workspace-app/issue-manager?workspaceId=workspace-1)"
      )
    ).toMatchObject({
      item: {
        kind: "workspace-app",
        workspaceId: "workspace-1",
        targetId: "issue-manager",
        appId: "issue-manager",
        name: "任务管理"
      },
      end: 69
    });
  });

  it("accepts agent target mention hrefs without an @ prefix", () => {
    expect(
      parseAgentMentionMarkdown(
        "[Codex](mention://agent-target/local:codex?workspaceId=workspace-1)"
      )
    ).toMatchObject({
      item: {
        kind: "agent-target",
        workspaceId: "workspace-1",
        targetId: "local:codex",
        name: "Codex"
      }
    });
  });

  it("accepts workspace issue mention hrefs without an @ prefix", () => {
    expect(
      parseAgentMentionMarkdown(
        "[做一个音乐app](mention://workspace-issue/issue-1?workspaceId=workspace-1&topicId=default)"
      )
    ).toMatchObject({
      item: {
        kind: "workspace-issue",
        workspaceId: "workspace-1",
        targetId: "issue-1",
        topicId: "default",
        name: "做一个音乐app"
      }
    });
  });

  it("rejects legacy query-only provider mention hrefs", () => {
    expect(
      parseAgentMentionMarkdown(
        "[@Session](mention://agent-session?workspaceId=workspace-1&id=session-1)"
      )
    ).toBeNull();
    expect(
      parseAgentMentionMarkdown(
        "[@Issue](mention://workspace-issue?workspaceId=workspace-1&id=issue-1)"
      )
    ).toBeNull();
    expect(
      parseAgentMentionMarkdown(
        "[@App](mention://workspace-app?workspaceId=workspace-1&appId=app-1)"
      )
    ).toBeNull();
  });

  it("rejects old serialized mention fields", () => {
    expect(
      parseAgentMentionMarkdown(
        "[@App](mention://workspace-app/app-1?workspaceId=workspace-1&link=https%3A%2F%2Fexample.com)"
      )
    ).toBeNull();
    expect(
      parseAgentMentionMarkdown(
        "[@App](mention://workspace-app/app-1?workspaceId=workspace-1&meta.iconUrl=icon.png)"
      )
    ).toBeNull();
  });

  it("hydrates workspace app factory mentions with an entity path", () => {
    expect(
      parseAgentMentionMarkdown(
        "[@Create App](mention://workspace-app-factory/create)"
      )
    ).toMatchObject({
      item: {
        kind: "workspace-app-factory",
        href: "mention://workspace-app-factory/create",
        workspaceId: "",
        targetId: "create",
        jobId: "",
        name: "Create App"
      }
    });
  });
});

describe("attrsToMentionItem", () => {
  it("prefers workspaceId attrs for session mentions", () => {
    expect(
      attrsToMentionItem({
        kind: "session",
        href: "mention://agent-session/session-1?agentTargetId=local%3Aclaude-code&workspaceId=workspace-1",
        workspaceId: "workspace-1",
        targetId: "session-1",
        name: "Session"
      })
    ).toMatchObject({
      kind: "session",
      workspaceId: "workspace-1",
      targetId: "session-1",
      agentTargetId: "local:claude-code"
    });
  });

  it("preserves an explicit session agent icon through attrs", () => {
    const item = attrsToMentionItem(
      mentionItemToAttrs({
        kind: "session",
        href: "mention://agent-session/session-1?agentTargetId=shared-agent%3Acursor&workspaceId=workspace-1",
        workspaceId: "workspace-1",
        targetId: "session-1",
        agentTargetId: "shared-agent:cursor",
        name: "Session",
        title: "Session",
        scope: "collab_sessions",
        initiatorName: "",
        agentName: "Cursor",
        agentIconUrl: "tutti://agent/cursor.svg"
      })
    );

    expect(item).toMatchObject({
      kind: "session",
      agentIconUrl: "tutti://agent/cursor.svg"
    });
  });

  it("accepts workspace issue attrs", () => {
    expect(
      attrsToMentionItem({
        kind: "workspace-issue",
        href: "mention://workspace-issue/issue-1?workspaceId=workspace-1",
        workspaceId: "workspace-1",
        targetId: "issue-1",
        name: "Issue"
      })
    ).toMatchObject({
      kind: "workspace-issue",
      workspaceId: "workspace-1",
      targetId: "issue-1"
    });
  });

  it("accepts workspace app factory attrs", () => {
    expect(
      attrsToMentionItem({
        kind: "workspace-app-factory",
        href: "mention://workspace-app-factory/create",
        name: "Create App"
      })
    ).toMatchObject({
      kind: "workspace-app-factory",
      workspaceId: "",
      targetId: "",
      jobId: "",
      href: "mention://workspace-app-factory/create"
    });
  });

  it("round-trips file mention thumbnail attrs", () => {
    expect(
      attrsToMentionItem({
        kind: "file",
        name: "diagram.png",
        href: "/workspace/diagram.png",
        path: "/workspace/diagram.png",
        entryKind: "file",
        directoryPath: "/workspace",
        thumbnailUrl: "data:image/png;base64,thumb"
      })
    ).toMatchObject({
      kind: "file",
      name: "diagram.png",
      thumbnailUrl: "data:image/png;base64,thumb"
    });
  });

  it("parses workspace-reference attrs into a resolvable handle", () => {
    expect(
      attrsToMentionItem({
        kind: "workspace-reference",
        href: "mention://workspace-reference/topic-1?groupId=issue-1&source=task&workspaceId=ws-1",
        name: "Design",
        targetId: "topic-1",
        source: "task",
        groupId: "issue-1",
        workspaceId: "ws-1",
        fileCount: "3"
      })
    ).toMatchObject({
      kind: "workspace-reference",
      source: "task",
      targetId: "topic-1",
      groupId: "issue-1",
      workspaceId: "ws-1",
      fileCount: 3
    });
  });

  it("defaults a malformed fileCount to zero", () => {
    expect(
      attrsToMentionItem({
        kind: "workspace-reference",
        href: "mention://workspace-reference/app-1?source=app&workspaceId=ws-1",
        name: "Design",
        targetId: "app-1",
        source: "app",
        workspaceId: "ws-1",
        fileCount: "nope"
      })
    ).toMatchObject({
      kind: "workspace-reference",
      source: "app",
      fileCount: 0
    });
  });

  it("round-trips agent target attrs", () => {
    expect(
      attrsToMentionItem({
        kind: "agent-target",
        href: "mention://agent-target/local:claude-code?workspaceId=ws-1",
        name: "Claude Code",
        targetId: "local:claude-code",
        workspaceId: "ws-1",
        description: "Run Claude Code locally",
        agentProviderId: "claude-code",
        iconUrl: "tutti://agent/claude-code.svg"
      })
    ).toMatchObject({
      kind: "agent-target",
      targetId: "local:claude-code",
      workspaceId: "ws-1",
      agentProviderId: "claude-code",
      iconUrl: "tutti://agent/claude-code.svg"
    });
  });
});

describe("agent session mention links", () => {
  it("builds the stable agent-session mention href", () => {
    expect(
      createAgentSessionMentionHref({
        agentSessionId: "session-1",
        agentTargetId: "local:claude-code",
        label: "Session 1",
        workspaceId: "room-1"
      })
    ).toBe(
      "mention://agent-session/session-1?agentTargetId=local%3Aclaude-code&workspaceId=room-1"
    );
  });

  it("formats composer session mentions with the mention prefix", () => {
    expect(
      createAgentSessionMarkdownLink({
        agentSessionId: "session-1",
        agentTargetId: "local:codex",
        label: "Session 1",
        workspaceId: "room-1",
        withAtPrefix: true
      })
    ).toBe(
      "[@Session 1](mention://agent-session/session-1?agentTargetId=local%3Acodex&workspaceId=room-1)"
    );
  });

  it("formats copied session links without the mention prefix", () => {
    expect(
      createAgentSessionMarkdownLink({
        agentSessionId: "session-1",
        label: "Session [draft] \\ one",
        workspaceId: "room-1",
        withAtPrefix: false
      })
    ).toBe(
      "[Session \\[draft\\] \\\\ one](mention://agent-session/session-1?workspaceId=room-1)"
    );
  });

  it("preserves the agent target when formatting a session mention item", () => {
    expect(
      formatAgentMentionMarkdown({
        kind: "session",
        href: "mention://agent-session/session-1?workspaceId=room-1",
        workspaceId: "room-1",
        targetId: "session-1",
        agentTargetId: "local:claude-code",
        name: "Taylor & Claude Code Session 1",
        title: "Session 1",
        scope: "my_sessions",
        initiatorName: "Taylor",
        agentName: "Claude Code"
      })
    ).toBe(
      "[@Session 1](mention://agent-session/session-1?agentTargetId=local%3Aclaude-code&workspaceId=room-1)"
    );
  });

  it("preserves the agent target from an existing session href", () => {
    expect(
      formatAgentMentionMarkdown({
        kind: "session",
        href: "mention://agent-session/session-1?agentTargetId=local%3Aclaude-code&workspaceId=room-1",
        workspaceId: "room-1",
        targetId: "session-1",
        name: "Session 1",
        title: "Session 1",
        scope: "my_sessions",
        initiatorName: "Taylor",
        agentName: "Claude Code"
      })
    ).toBe(
      "[@Session 1](mention://agent-session/session-1?agentTargetId=local%3Aclaude-code&workspaceId=room-1)"
    );
  });
});

describe("formatAgentMentionMarkdown — agent target", () => {
  it("renders the agent-target mention href without falling back to workspace-app", () => {
    expect(
      formatAgentMentionMarkdown({
        kind: "agent-target",
        href: "mention://agent-target/local:codex?workspaceId=ws-1",
        workspaceId: "ws-1",
        targetId: "local:codex",
        name: "Codex",
        agentProviderId: "codex"
      })
    ).toBe("[@Codex](mention://agent-target/local:codex?workspaceId=ws-1)");
  });
});

describe("formatAgentMentionMarkdown — workspace reference", () => {
  const referenceItem = {
    kind: "workspace-reference" as const,
    href: "mention://workspace-reference/app-1?source=app&workspaceId=ws-1",
    workspaceId: "ws-1",
    targetId: "app-1",
    source: "app" as const,
    name: "Design",
    fileCount: 2
  };

  it("renders one chip link (no expansion)", () => {
    expect(formatAgentMentionMarkdown(referenceItem)).toBe(
      "[@Design](mention://workspace-reference/app-1?count=2&source=app&workspaceId=ws-1)"
    );
  });

  it("omits display icon data from the prompt href", () => {
    expect(
      formatAgentMentionMarkdown({
        ...referenceItem,
        href: "mention://workspace-reference/app-1?icon=data%3Aimage%2Fpng%3Bbase64%2Cabc&source=app&workspaceId=ws-1",
        iconUrl: "data:image/png;base64,abc"
      })
    ).toBe(
      "[@Design](mention://workspace-reference/app-1?count=2&source=app&workspaceId=ws-1)"
    );
  });

  it("parses legacy href icon data for chip display", () => {
    const href = createRichTextMentionHref({
      providerId: "workspace-reference",
      entityId: "topic-1",
      label: "Design",
      scope: {
        workspaceId: "ws-1",
        source: "task",
        groupId: "issue-1",
        icon: "https://icons/app-1.png",
        count: "5"
      }
    });
    const parsed = parseAgentMentionMarkdown(`[@Design](${href})`);
    expect(parsed?.item).toMatchObject({
      kind: "workspace-reference",
      name: "Design",
      source: "task",
      targetId: "topic-1",
      groupId: "issue-1",
      iconUrl: "https://icons/app-1.png",
      fileCount: 5
    });
  });
});

describe("expandRangeOverMentionPlaceholder", () => {
  it("swallows a surrounding `{ … }` mention placeholder plus one trailing space", () => {
    // "让 { @ } 审查": paragraph offsets 1=让 2=' ' 3={ 4=' ' 5=@ 6=' ' 7=} 8=' ' 9=审 10=查
    const { editor, range } = editorForPlaceholder("让 { @ } 审查");
    expect(expandRangeOverMentionPlaceholder(editor, range)).toEqual({
      from: 3,
      to: 9
    });
  });

  it("swallows a placeholder that still carries its seeded label text", () => {
    // The seeded `@agent` label survives when the user types a fresh `@` inside.
    const { editor, range } = editorForPlaceholder("让 { @agent } 审查");
    const expanded = expandRangeOverMentionPlaceholder(editor, range);
    const doc = editor.state.doc;
    expect(doc.textBetween(expanded.from, expanded.to)).toBe("{ @agent } ");
  });

  it("leaves an ordinary `@` mention (no enclosing braces) untouched", () => {
    const { editor, range } = editorForPlaceholder("ping @");
    expect(expandRangeOverMentionPlaceholder(editor, range)).toEqual(range);
  });

  it("does not cross a closing brace when scanning left", () => {
    const { editor, range } = editorForPlaceholder("a } @ } b");
    expect(expandRangeOverMentionPlaceholder(editor, range)).toEqual(range);
  });

  it("leaves large, user-authored braces intact", () => {
    const { editor, range } = editorForPlaceholder(
      '{ "role": "assistant", "mentionedAt": @, "count": 1 }'
    );
    expect(expandRangeOverMentionPlaceholder(editor, range)).toEqual(range);
  });

  it("does not swallow a group that already contains a mention chip", () => {
    const doc = placeholderSchema.node("doc", null, [
      placeholderSchema.node("paragraph", null, [
        placeholderSchema.text("{ @ "),
        placeholderSchema.node("chip"),
        placeholderSchema.text(" }")
      ])
    ]);
    const editor = { state: { doc } } as unknown as Editor;
    const range = { from: 3, to: 4 }; // over the `@`
    expect(expandRangeOverMentionPlaceholder(editor, range)).toEqual(range);
  });
});
