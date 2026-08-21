import { describe, expect, it } from "vitest";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import { createAgentFileMentionContent } from "./agentWorkspaceFileReferences";

describe("createAgentFileMentionContent", () => {
  it("derives Windows file metadata with normalized directory separators", () => {
    const path = String.raw`C:\Users\agent\workspace\report.md`;
    const reference: WorkspaceFileReference = {
      displayName: "report.md",
      kind: "file",
      path
    };

    expect(createAgentFileMentionContent([reference])[0]).toMatchObject({
      type: "agentFileMention",
      attrs: {
        href: path,
        path,
        name: "report.md",
        entryKind: "file",
        directoryPath: "C:/Users/agent/workspace"
      }
    });
  });

  it("does not append a mixed separator to a Windows folder reference", () => {
    const path = "C:\\Users\\agent\\workspace\\generated\\";
    const reference: WorkspaceFileReference = {
      displayName: "generated",
      kind: "folder",
      path
    };

    expect(createAgentFileMentionContent([reference])[0]).toMatchObject({
      type: "agentFileMention",
      attrs: {
        href: path,
        path,
        name: "generated",
        entryKind: "directory",
        directoryPath: "C:/Users/agent/workspace"
      }
    });
  });
});
