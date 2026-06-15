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
        path: "/Users/test/.tutti-dev/agent/runs/run-1/session-1/codex-home/generated_images/imagegen/ig_123.png",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/Users/test/.tutti-dev/agent/runs/run-1/session-1/codex-home/generated_images/imagegen/ig_123.png",
      directoryPath:
        "/Users/test/.tutti-dev/agent/runs/run-1/session-1/codex-home/generated_images/imagegen",
      workspaceRoot: "/Users/test/project/tutti"
    });

    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/.tutti-dev/agent/runs/run-1/session-1/codex-home/secrets.txt",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toBeNull();
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
        href: "mention://workspace-issue?workspaceId=workspace-1&id=issue-1&mode=execute&topicId=topic-1&taskId=task-1&runId=run-1&outputDir=%2Fworkspace%2Fissues%2Fissue-1",
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
});
