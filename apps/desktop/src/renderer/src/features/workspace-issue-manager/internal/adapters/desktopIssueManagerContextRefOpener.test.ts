import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { createDesktopIssueManagerContextRefOpener } from "./desktopIssueManagerContextRefOpener.ts";

test("managed issue attachments cross the host boundary by opaque ContextRef identity", async () => {
  const reads: string[][] = [];
  const archives: unknown[] = [];
  const opened: string[] = [];
  const opener = createDesktopIssueManagerContextRefOpener({
    fileAdapter: {},
    hostFilesApi: {
      async archiveAgentPromptFile(input) {
        archives.push(input);
        return {
          name: "capture.png",
          path: "/local/cache/capture.png",
          sizeBytes: 8
        };
      },
      async openTerminalLink(input) {
        opened.push(input.path);
      }
    },
    tuttidClient: {
      async readWorkspaceIssueAttachment(workspaceId, issueId, contextRefId) {
        reads.push([workspaceId, issueId, contextRefId]);
        return {
          contextRefId,
          data: "iVBORw0KGgo=",
          displayName: "capture.png",
          mimeType: "image/png"
        };
      }
    } as TuttidClient,
    workspaceId: "workspace-1"
  });

  await opener.openContextRef({
    accessKind: "managed_attachment",
    contextRefId: "attachment-1",
    createdAtUnix: 1,
    displayName: "capture.png",
    issueId: "issue-1",
    parentKind: "issue",
    refType: "image/png",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(reads, [["workspace-1", "issue-1", "attachment-1"]]);
  assert.deepEqual(archives, [
    {
      dataBase64: "iVBORw0KGgo=",
      displayName: "capture.png",
      mimeType: "image/png",
      workspaceID: "workspace-1"
    }
  ]);
  assert.deepEqual(opened, ["/local/cache/capture.png"]);
});

test("workspace-path ContextRefs keep using the existing file adapter", async () => {
  const opened: string[] = [];
  const opener = createDesktopIssueManagerContextRefOpener({
    fileAdapter: {
      async openReference(reference) {
        opened.push(reference.path);
      }
    },
    hostFilesApi: {
      async archiveAgentPromptFile() {
        assert.fail("must not archive a workspace-path reference");
      },
      async openTerminalLink() {
        assert.fail("must not open a workspace-path reference directly");
      }
    },
    tuttidClient: {} as TuttidClient,
    workspaceId: "workspace-1"
  });

  await opener.openContextRef({
    accessKind: "workspace_path",
    contextRefId: "context-ref-1",
    createdAtUnix: 1,
    displayName: "capture.png",
    issueId: "issue-1",
    parentKind: "issue",
    path: "/workspace/capture.png",
    refType: "image/png",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(opened, ["/workspace/capture.png"]);
});
