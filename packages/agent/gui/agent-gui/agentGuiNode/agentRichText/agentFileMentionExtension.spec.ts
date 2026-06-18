import { describe, expect, it } from "vitest";
import {
  attrsToMentionItem,
  buildAgentSessionMentionHref,
  buildAgentWorkspaceAppBundleMentionHref,
  buildAgentWorkspaceAppFactoryMentionHref,
  buildAgentWorkspaceIssueMentionHref,
  formatAgentMentionMarkdown,
  parseAgentMentionMarkdown
} from "./agentFileMentionExtension";

describe("buildAgentSessionMentionHref", () => {
  it("builds an agent session mention href", () => {
    expect(buildAgentSessionMentionHref("workspace-1", "session-1")).toBe(
      "mention://agent-session/session-1?workspaceId=workspace-1"
    );
  });
});

describe("buildAgentWorkspaceIssueMentionHref", () => {
  it("builds a workspace issue mention href", () => {
    expect(buildAgentWorkspaceIssueMentionHref("workspace-1", "issue-1")).toBe(
      "mention://workspace-issue/issue-1?workspaceId=workspace-1"
    );
  });

  it("includes issue scope when provided", () => {
    expect(
      buildAgentWorkspaceIssueMentionHref("workspace-1", "issue-1", {
        mode: "execute",
        runId: "run-1",
        taskId: "task-1",
        topicId: "topic-1"
      })
    ).toBe(
      "mention://workspace-issue/issue-1?topicId=topic-1&workspaceId=workspace-1"
    );
  });
});

describe("buildAgentWorkspaceAppFactoryMentionHref", () => {
  it("builds a workspace app factory mention href", () => {
    expect(buildAgentWorkspaceAppFactoryMentionHref()).toBe(
      "mention://workspace-app-factory/create"
    );
  });
});

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

  it("parses app bundle attrs into a files array", () => {
    expect(
      attrsToMentionItem({
        kind: "workspace-app-bundle",
        name: "Design",
        appId: "app-1",
        workspaceId: "ws-1",
        filesJson: JSON.stringify([
          { path: "/p/a.txt", name: "a.txt" },
          { path: "/p/sub/b.txt", name: "b.txt" }
        ])
      })
    ).toMatchObject({
      kind: "workspace-app-bundle",
      appId: "app-1",
      workspaceId: "ws-1",
      files: [
        { path: "/p/a.txt", name: "a.txt" },
        { path: "/p/sub/b.txt", name: "b.txt" }
      ]
    });
  });

  it("tolerates malformed bundle filesJson by yielding no files", () => {
    expect(
      attrsToMentionItem({
        kind: "workspace-app-bundle",
        name: "Design",
        appId: "app-1",
        workspaceId: "ws-1",
        filesJson: "{not json"
      })
    ).toMatchObject({ kind: "workspace-app-bundle", files: [] });
  });
});

describe("formatAgentMentionMarkdown — app bundle", () => {
  const bundleItem = {
    kind: "workspace-app-bundle" as const,
    href: "mention://workspace-app-bundle/app-1?workspaceId=ws-1",
    workspaceId: "ws-1",
    targetId: "app-1",
    appId: "app-1",
    name: "Design",
    files: [
      { path: "/p/a.txt", name: "a.txt" },
      { path: "/p/sub/b.txt", name: "b.txt" }
    ]
  };

  it("display mode (default) renders one chip link", () => {
    expect(formatAgentMentionMarkdown(bundleItem)).toBe(
      "[@Design](mention://workspace-app-bundle/app-1?workspaceId=ws-1)"
    );
  });

  it("agent mode expands into one file mention per file", () => {
    expect(formatAgentMentionMarkdown(bundleItem, "agent")).toBe(
      "[@a.txt](/p/a.txt) [@b.txt](/p/sub/b.txt)"
    );
  });

  it("agent mode of an empty bundle falls back to the chip link", () => {
    // 空项目无文件可展开:退回 @项目名 链接,而不是空串(否则会留下空白节点)。
    expect(
      formatAgentMentionMarkdown({ ...bundleItem, files: [] }, "agent")
    ).toBe("[@Design](mention://workspace-app-bundle/app-1?workspaceId=ws-1)");
  });

  it("round-trips files + icon through the href (build → parse)", () => {
    const href = buildAgentWorkspaceAppBundleMentionHref(
      "ws-1",
      "app-1",
      [
        { path: "/p/a.txt", name: "a.txt" },
        { path: "/p/sub/b.txt", name: "b.txt" }
      ],
      "https://icons/app-1.png"
    );
    const parsed = parseAgentMentionMarkdown(`[@Design](${href})`);
    expect(parsed?.item).toMatchObject({
      kind: "workspace-app-bundle",
      name: "Design",
      iconUrl: "https://icons/app-1.png",
      files: [
        { path: "/p/a.txt", name: "a.txt" },
        { path: "/p/sub/b.txt", name: "b.txt" }
      ]
    });
  });
});
