import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceMentionLinkAction,
  resolveWorkspaceFileLinkAction,
  resolveWorkspaceFilePathCandidate
} from "./workspaceLinkActions";

describe("resolveWorkspaceFileLinkAction", () => {
  it("opens local absolute paths without remapping workspace-prefixed paths", () => {
    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/project/tutti/src/App.tsx",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/Users/test/project/tutti/src/App.tsx",
      directoryPath: "/Users/test/project/tutti/src",
      workspaceRoot: "/Users/test/project/tutti"
    });

    expect(
      resolveWorkspaceFileLinkAction({
        path: "/workspace/src/App.tsx",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toBeNull();
  });

  it("allows local absolute paths when the workspace root is the filesystem root", () => {
    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/project/tutti/src/App.tsx",
        workspaceRoot: "/",
        basePath: "/",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/Users/test/project/tutti/src/App.tsx",
      directoryPath: "/Users/test/project/tutti/src",
      workspaceRoot: "/"
    });
  });

  it("allows direct generated image paths under Tutti state outside the workspace root", () => {
    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/generated_images/imagegen/ig_123.png",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/generated_images/imagegen/ig_123.png",
      directoryPath:
        "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/generated_images/imagegen",
      workspaceRoot: "/Users/test/project/tutti"
    });

    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/secrets.txt",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toBeNull();
  });

  it("allows direct workspace app data paths without a selected project", () => {
    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/.tutti-dev/apps/workspaces/workspace-1/group-chat/data/rooms/room-1/uploads/image.png",
        workspaceRoot: "",
        basePath: "",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/Users/test/.tutti-dev/apps/workspaces/workspace-1/group-chat/data/rooms/room-1/uploads/image.png",
      directoryPath:
        "/Users/test/.tutti-dev/apps/workspaces/workspace-1/group-chat/data/rooms/room-1/uploads",
      workspaceRoot:
        "/Users/test/.tutti-dev/apps/workspaces/workspace-1/group-chat/data/rooms/room-1/uploads"
    });

    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/Downloads/image.png",
        workspaceRoot: "",
        basePath: "",
        source: "agent-markdown"
      })
    ).toBeNull();

    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/.tutti-dev/apps/workspaces/workspace-1",
        workspaceRoot: "",
        basePath: "",
        source: "agent-markdown"
      })
    ).toBeNull();
  });

  it("preserves the selected workspace root for direct workspace app data paths", () => {
    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/.tutti-dev/apps/workspaces/workspace-1/group-chat/data/file.txt",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/Users/test/.tutti-dev/apps/workspaces/workspace-1/group-chat/data/file.txt",
      directoryPath:
        "/Users/test/.tutti-dev/apps/workspaces/workspace-1/group-chat/data",
      workspaceRoot: "/Users/test/project/tutti"
    });
  });

  it("resolves relative paths through the same workspace file candidate contract", () => {
    expect(
      resolveWorkspaceFilePathCandidate({
        path: "src/App.tsx",
        workspaceRoot: "/Users/test/project/tutti"
      })
    ).toMatchObject({
      path: "/Users/test/project/tutti/src/App.tsx",
      directoryPath: "/Users/test/project/tutti/src",
      workspaceRoot: "/Users/test/project/tutti"
    });
  });

  it("allows Windows local paths inside the workspace root", () => {
    expect(
      resolveWorkspaceFileLinkAction({
        path: "C:\\Users\\test\\project\\tutti\\src\\App.tsx",
        workspaceRoot: "C:\\Users\\test\\project\\tutti",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "C:/Users/test/project/tutti/src/App.tsx",
      directoryPath: "C:/Users/test/project/tutti/src",
      workspaceRoot: "C:/Users/test/project/tutti"
    });
  });
});

describe("resolveWorkspaceMentionLinkAction", () => {
  it("parses canonical workspace-issue mention context", () => {
    expect(
      resolveWorkspaceMentionLinkAction({
        href: "mention://workspace-issue/issue-1?workspaceId=workspace-1&mode=execute&topicId=topic-1&taskId=task-1&runId=run-1&outputDir=%2Fworkspace%2Fissues%2Fissue-1",
        source: "agent-markdown"
      })
    ).toEqual({
      type: "open-workspace-issue",
      workspaceId: "workspace-1",
      issueId: "issue-1",
      mode: "execute",
      topicId: "topic-1",
      taskId: "task-1",
      runId: "run-1",
      outputDir: "/workspace/issues/issue-1",
      source: "agent-markdown"
    });
  });

  it("parses workspace-app mention context", () => {
    expect(
      resolveWorkspaceMentionLinkAction({
        href: "mention://workspace-app/weather?workspaceId=workspace-1",
        source: "agent-markdown"
      })
    ).toEqual({
      type: "open-workspace-app",
      workspaceId: "workspace-1",
      appId: "weather",
      source: "agent-markdown"
    });
  });

  it("parses workspace-app mention navigation params", () => {
    expect(
      resolveWorkspaceMentionLinkAction({
        href: "mention://workspace-app/group-chat?workspaceId=workspace-1&messageId=msg-1&conversationId=conv-1",
        source: "agent-markdown"
      })
    ).toEqual({
      type: "open-workspace-app",
      workspaceId: "workspace-1",
      appId: "group-chat",
      messageId: "msg-1",
      conversationId: "conv-1",
      source: "agent-markdown"
    });
  });

  it("rejects legacy query-only workspace mention context", () => {
    expect(
      resolveWorkspaceMentionLinkAction({
        href: "mention://workspace-issue?workspaceId=workspace-1&id=issue-1",
        source: "agent-markdown"
      })
    ).toBeNull();
  });

  it("rejects reserved mention scope keys", () => {
    expect(
      resolveWorkspaceMentionLinkAction({
        href: "mention://agent-session/session-1?workspaceId=workspace-1&provider=codex",
        source: "agent-markdown"
      })
    ).toBeNull();
  });
});
