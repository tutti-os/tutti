import { describe, expect, it } from "vitest";
import {
  attrsToMentionItem,
  formatAgentMentionMarkdown,
  parseAgentMentionMarkdown
} from "./agentFileMentionExtension";
import { createRichTextMentionHref } from "@tutti-os/ui-rich-text/core";

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
    expect(
      parseAgentMentionMarkdown(
        "[@Session](mention://agent-session/session-1?workspaceId=workspace-1)"
      )
    ).toMatchObject({
      item: {
        kind: "session",
        workspaceId: "workspace-1",
        targetId: "session-1",
        name: "Session"
      }
    });
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
        href: "mention://agent-session/session-1?workspaceId=workspace-1",
        workspaceId: "workspace-1",
        targetId: "session-1",
        name: "Session"
      })
    ).toMatchObject({
      kind: "session",
      workspaceId: "workspace-1",
      targetId: "session-1"
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
