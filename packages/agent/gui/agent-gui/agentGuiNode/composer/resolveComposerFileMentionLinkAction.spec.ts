import { describe, expect, it } from "vitest";
import { createAgentComposerFileMentionMarkdown } from "../agentRichText/agentMentionMarkdown";
import { buildAgentComposerDraft } from "../model/agentComposerDraft";
import {
  collectComposerDraftFiles,
  resolveComposerFileMentionLinkAction
} from "./resolveComposerFileMentionLinkAction";

function composerFileHref(input: {
  id: string;
  name: string;
  status: "ready" | "uploading" | "error";
}): string {
  const markdown = createAgentComposerFileMentionMarkdown(input);
  const match = /\(([^)]+)\)/.exec(markdown);
  if (!match?.[1]) {
    throw new Error(`missing composer-file href in ${markdown}`);
  }
  return match[1];
}

describe("resolveComposerFileMentionLinkAction", () => {
  it("opens a ready composer-file mention through its draft locator", () => {
    expect(
      resolveComposerFileMentionLinkAction({
        href: composerFileHref({
          id: "file-1",
          name: "archive.zip",
          status: "ready"
        }),
        files: [
          {
            id: "file-1",
            name: "archive.zip",
            path: "/workspace/room-1/archive.zip"
          }
        ],
        workspaceRoot: "/workspace/room-1",
        source: "agent-markdown"
      })
    ).toMatchObject({
      kind: "open",
      action: {
        type: "open-workspace-file",
        path: "/workspace/room-1/archive.zip"
      }
    });
  });

  it("opens staged local-asset locators for prepared host uploads", () => {
    expect(
      resolveComposerFileMentionLinkAction({
        href: composerFileHref({
          id: "file-asset",
          name: "notes.txt",
          status: "ready"
        }),
        files: [
          {
            id: "file-asset",
            name: "notes.txt",
            path: "/var/cache/tsh/local-assets/room-1/user-1/notes.txt"
          }
        ],
        workspaceRoot: "/workspace/room-1",
        source: "agent-markdown"
      })
    ).toMatchObject({
      kind: "open",
      action: {
        type: "open-local-asset-preview",
        path: "/var/cache/tsh/local-assets/room-1/user-1/notes.txt"
      }
    });
  });

  it("prefers hostPath when the staged path is missing", () => {
    expect(
      resolveComposerFileMentionLinkAction({
        href: composerFileHref({
          id: "file-host",
          name: "notes.txt",
          status: "ready"
        }),
        files: [
          {
            id: "file-host",
            name: "notes.txt",
            hostPath: "/Users/me/notes.txt"
          }
        ],
        workspaceRoot: "/workspace/room-1",
        source: "agent-markdown"
      })
    ).toMatchObject({
      kind: "open",
      action: {
        type: "open-workspace-file",
        path: "/Users/me/notes.txt"
      }
    });
  });

  it("blocks uploading composer-file mentions", () => {
    expect(
      resolveComposerFileMentionLinkAction({
        href: composerFileHref({
          id: "file-1",
          name: "pending.pdf",
          status: "uploading"
        }),
        files: [
          {
            id: "file-1",
            name: "pending.pdf",
            path: "/runtime/pending.pdf",
            uploading: true
          }
        ],
        workspaceRoot: "/workspace/room-1",
        source: "agent-markdown"
      })
    ).toEqual({ kind: "blocked", reason: "uploading" });
  });

  it("blocks failed composer-file mentions", () => {
    expect(
      resolveComposerFileMentionLinkAction({
        href: composerFileHref({
          id: "file-1",
          name: "broken.pdf",
          status: "error"
        }),
        files: [
          {
            id: "file-1",
            name: "broken.pdf",
            uploadError: "file_too_large"
          }
        ],
        workspaceRoot: "/workspace/room-1",
        source: "agent-markdown"
      })
    ).toEqual({ kind: "blocked", reason: "failed" });
  });

  it("blocks missing draft entries as unavailable", () => {
    expect(
      resolveComposerFileMentionLinkAction({
        href: composerFileHref({
          id: "missing",
          name: "gone.pdf",
          status: "ready"
        }),
        files: [],
        workspaceRoot: "/workspace/room-1",
        source: "agent-markdown"
      })
    ).toEqual({ kind: "blocked", reason: "unavailable" });
  });

  it("does not intercept ordinary path-backed file mentions", () => {
    expect(
      resolveComposerFileMentionLinkAction({
        href: "/workspace/room-1/readme.md",
        files: [],
        workspaceRoot: "/workspace/room-1",
        source: "agent-markdown"
      })
    ).toBeNull();
  });
});

describe("collectComposerDraftFiles", () => {
  it("merges active files with scoped draft registries", () => {
    const collected = collectComposerDraftFiles({
      activeFiles: [{ id: "a", name: "a.txt", path: "/a.txt" }],
      draftsByScope: {
        home: buildAgentComposerDraft({
          prompt: "",
          files: [{ id: "b", name: "b.txt", path: "/b.txt" }]
        }),
        session: buildAgentComposerDraft({
          prompt: "",
          files: [{ id: "a", name: "a-override.txt", path: "/a2.txt" }]
        })
      }
    });

    expect(collected).toEqual([
      { id: "a", name: "a.txt", path: "/a.txt" },
      { id: "b", name: "b.txt", path: "/b.txt" }
    ]);
  });
});
