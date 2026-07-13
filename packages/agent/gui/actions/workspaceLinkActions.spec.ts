import { describe, expect, it } from "vitest";
import {
  resolveLocalAssetPreviewLinkAction,
  resolveWorkspaceLinkAction,
  resolveWorkspaceMentionLinkAction,
  resolveWorkspaceFileLinkAction,
  resolveWorkspaceFilePathCandidate
} from "./workspaceLinkActions";
import {
  registerAgentCustomMentionKind,
  resetAgentCustomMentionKindsForTests
} from "../shared/agentCustomMentionKinds";

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
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/workspace/src/App.tsx",
      directoryPath: "/workspace/src",
      workspaceRoot: "/Users/test/project/tutti"
    });
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

  it("allows explicit local absolute paths outside the selected workspace root", () => {
    expect(
      resolveWorkspaceFileLinkAction({
        path: "/var/folders/17/demo/T/codex-presentations/test-note.md",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-file-change"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/var/folders/17/demo/T/codex-presentations/test-note.md",
      directoryPath: "/var/folders/17/demo/T/codex-presentations",
      workspaceRoot: "/Users/test/project/tutti"
    });

    expect(
      resolveWorkspaceFileLinkAction({
        path: "/tmp/report.txt",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-file-change"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/tmp/report.txt",
      directoryPath: "/tmp",
      workspaceRoot: "/Users/test/project/tutti"
    });
  });

  it("rejects special local device and network share paths before launch", () => {
    for (const path of [
      "/dev/null",
      "/dev/./null",
      "/dev//null",
      "NUL",
      "NUL.txt",
      "C:\\tmp\\NUL",
      "\\\\server\\share\\file.txt",
      "//server/share/file.txt"
    ]) {
      expect(
        resolveWorkspaceFileLinkAction({
          path,
          workspaceRoot: "/",
          basePath: "/",
          source: "agent-file-change"
        })
      ).toBeNull();
    }
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
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/secrets.txt",
      directoryPath: "/Users/test/.tutti-dev/agent/runs/session-1/codex-home",
      workspaceRoot: "/Users/test/project/tutti"
    });
  });

  it("allows direct generated video paths under Tutti state outside the workspace root", () => {
    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/generated_videos/dance.mp4",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/generated_videos/dance.mp4",
      directoryPath:
        "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/generated_videos",
      workspaceRoot: "/Users/test/project/tutti"
    });

    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/generated_videos/raw.mov",
        workspaceRoot: "/Users/test/project/tutti",
        basePath: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/generated_videos/raw.mov",
      directoryPath:
        "/Users/test/.tutti-dev/agent/runs/session-1/codex-home/generated_videos",
      workspaceRoot: "/Users/test/project/tutti"
    });
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

  it("rejects staged local asset paths from workspace file candidates", () => {
    expect(
      resolveWorkspaceFilePathCandidate({
        path: "/var/cache/tsh/local-assets/room-1/user-1/photo.png",
        workspaceRoot: "/workspace/project-a"
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

  it("uses the agent session cwd when a no-project conversation has no workspace root", () => {
    expect(
      resolveWorkspaceFileLinkAction({
        path: "/Users/test/Documents/tutti/session-1/index.html",
        workspaceRoot: null,
        basePath: "/Users/test/Documents/tutti/session-1",
        source: "agent-markdown"
      })
    ).toEqual({
      type: "open-workspace-file",
      path: "/Users/test/Documents/tutti/session-1/index.html",
      directoryPath: "/Users/test/Documents/tutti/session-1",
      workspaceRoot: "/Users/test/Documents/tutti/session-1",
      source: "agent-markdown"
    });
  });

  it("preserves home-relative paths for the desktop launch layer", () => {
    expect(
      resolveWorkspaceFileLinkAction({
        path: "~/docs/spec.md",
        workspaceRoot: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "~/docs/spec.md",
      directoryPath: "~/docs",
      workspaceRoot: "/Users/test/project/tutti"
    });

    expect(
      resolveWorkspaceFileLinkAction({
        path: "~",
        workspaceRoot: "/Users/test/project/tutti",
        source: "agent-markdown"
      })
    ).toMatchObject({
      type: "open-workspace-file",
      path: "~",
      directoryPath: "~",
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

  it("resolves clickable registered custom mentions to open-custom-mention", () => {
    registerAgentCustomMentionKind({
      kind: "external-note",
      clickable: true,
      present: (mention) => ({ name: mention.label })
    });
    try {
      expect(
        resolveWorkspaceMentionLinkAction({
          href: "mention://external-note/note-a?ids=note-a%2Cnote-b&preview=hello&spaceId=space-1",
          source: "agent-markdown"
        })
      ).toEqual({
        type: "open-custom-mention",
        kind: "external-note",
        href: "mention://external-note/note-a?ids=note-a%2Cnote-b&preview=hello&spaceId=space-1",
        source: "agent-markdown"
      });
    } finally {
      resetAgentCustomMentionKindsForTests();
    }
  });

  it("does not resolve non-clickable registered custom mentions", () => {
    registerAgentCustomMentionKind({
      kind: "external-note",
      present: (mention) => ({ name: mention.label })
    });
    try {
      expect(
        resolveWorkspaceMentionLinkAction({
          href: "mention://external-note/note-a?spaceId=space-1",
          source: "agent-markdown"
        })
      ).toBeNull();
    } finally {
      resetAgentCustomMentionKindsForTests();
    }
  });

  it("does not resolve unregistered custom mention kinds", () => {
    expect(
      resolveWorkspaceMentionLinkAction({
        href: "mention://external-note/note-a?spaceId=space-1",
        source: "agent-markdown"
      })
    ).toBeNull();
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

  it("parses agent-session mention context without a captured provider", () => {
    expect(
      resolveWorkspaceMentionLinkAction({
        href: "mention://agent-session/session-1?workspaceId=workspace-1",
        source: "agent-markdown"
      })
    ).toEqual({
      type: "open-agent-session",
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      source: "agent-markdown"
    });
  });

  it("parses the mentioned session's agent target scope", () => {
    expect(
      resolveWorkspaceMentionLinkAction({
        href: "mention://agent-session/session-1?agentTargetId=local%3Aclaude-code&workspaceId=workspace-1",
        source: "agent-markdown"
      })
    ).toEqual({
      type: "open-agent-session",
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      agentTargetId: "local:claude-code",
      source: "agent-markdown"
    });
  });
});

describe("resolveLocalAssetPreviewLinkAction", () => {
  it("resolves staged local asset paths as preview actions", () => {
    expect(
      resolveLocalAssetPreviewLinkAction({
        path: "/var/cache/tsh/local-assets/room-1/user-1/asset.png",
        source: "agent-markdown"
      })
    ).toEqual({
      type: "open-local-asset-preview",
      path: "/var/cache/tsh/local-assets/room-1/user-1/asset.png",
      name: "asset.png",
      source: "agent-markdown"
    });
  });

  it("rejects local asset metadata sidecars", () => {
    expect(
      resolveLocalAssetPreviewLinkAction({
        path: "/var/cache/tsh/local-assets/room-1/user-1/asset.png.metadata.json",
        source: "agent-markdown"
      })
    ).toBeNull();
  });

  it("rejects other VM absolute paths", () => {
    expect(
      resolveLocalAssetPreviewLinkAction({
        path: "/var/lib/tsh/notes.md",
        source: "agent-markdown"
      })
    ).toBeNull();
  });
});

describe("resolveWorkspaceLinkAction", () => {
  it("opens staged local asset links with the preview action", () => {
    expect(
      resolveWorkspaceLinkAction({
        href: "/var/cache/tsh/local-assets/room-1/user-1/photo.png",
        workspaceRoot: "/workspace/project-a",
        source: "agent-markdown"
      })
    ).toEqual({
      type: "open-local-asset-preview",
      path: "/var/cache/tsh/local-assets/room-1/user-1/photo.png",
      name: "photo.png",
      source: "agent-markdown"
    });
  });
});
