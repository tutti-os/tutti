import { describe, expect, it } from "vitest";
import {
  attrsToMentionItem,
  buildAgentSessionMentionHref,
  buildAgentWorkspaceAppFactoryMentionHref,
  buildAgentWorkspaceIssueMentionHref,
  parseAgentMentionMarkdown
} from "./agentFileMentionExtension";

describe("buildAgentSessionMentionHref", () => {
  it("builds an agent session mention href", () => {
    expect(buildAgentSessionMentionHref("workspace-1", "session-1")).toBe(
      "mention://agent-session?workspaceId=workspace-1&id=session-1"
    );
  });
});

describe("buildAgentWorkspaceIssueMentionHref", () => {
  it("builds a workspace issue mention href", () => {
    expect(buildAgentWorkspaceIssueMentionHref("workspace-1", "issue-1")).toBe(
      "mention://workspace-issue?workspaceId=workspace-1&id=issue-1"
    );
  });

  it("includes hidden issue context when provided", () => {
    expect(
      buildAgentWorkspaceIssueMentionHref("workspace-1", "issue-1", {
        mode: "execute",
        runId: "run-1",
        taskId: "task-1",
        topicId: "topic-1"
      })
    ).toBe(
      "mention://workspace-issue?workspaceId=workspace-1&id=issue-1&mode=execute&topicId=topic-1&taskId=task-1&runId=run-1"
    );
  });
});

describe("buildAgentWorkspaceAppFactoryMentionHref", () => {
  it("builds a workspace app factory mention href", () => {
    expect(buildAgentWorkspaceAppFactoryMentionHref()).toBe(
      "mention://workspace-app-factory"
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

  it("accepts workspaceId query params for session mentions", () => {
    expect(
      parseAgentMentionMarkdown(
        "[@Session](mention://agent-session?workspaceId=workspace-1&id=session-1)"
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

  it("hydrates workspace app factory mentions without query params", () => {
    expect(
      parseAgentMentionMarkdown(
        "[@Create App](mention://workspace-app-factory)"
      )
    ).toMatchObject({
      item: {
        kind: "workspace-app-factory",
        href: "mention://workspace-app-factory",
        workspaceId: "",
        targetId: "",
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
      href: "mention://workspace-app-factory"
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
});
