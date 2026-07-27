import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFilePreviewTarget } from "@tutti-os/workspace-file-preview";
import { resolveWorkspaceFilePreviewTextHeaderState } from "./workspaceFilePreviewNodeState.ts";

const markdownFile: WorkspaceFilePreviewTarget = {
  name: "README.md",
  path: "/workspace/README.md",
  previewKind: "markdown"
};

test("workspace file preview header restores a valid markdown view mode", () => {
  assert.deepEqual(
    resolveWorkspaceFilePreviewTextHeaderState({
      runtimeNodeState: {
        file: markdownFile,
        textHeader: {
          canSave: true,
          dirty: false,
          status: "saved",
          viewMode: "preview"
        }
      }
    }),
    {
      canSave: true,
      dirty: false,
      status: "saved",
      viewMode: "preview"
    }
  );
});

test("workspace file preview header ignores an unknown markdown view mode", () => {
  assert.deepEqual(
    resolveWorkspaceFilePreviewTextHeaderState({
      runtimeNodeState: {
        file: markdownFile,
        textHeader: {
          canSave: true,
          dirty: false,
          status: "saved",
          viewMode: "side-by-side"
        }
      }
    }),
    {
      canSave: true,
      dirty: false,
      status: "saved"
    }
  );
});
