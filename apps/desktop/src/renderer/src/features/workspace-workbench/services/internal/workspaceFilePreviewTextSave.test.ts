import assert from "node:assert/strict";
import test from "node:test";
import { saveWorkspaceFilePreviewText } from "./workspaceFilePreviewTextSave.ts";

test("workspace file preview text save sends absolute paths through tuttid", async () => {
  const writes: Array<{
    content: string;
    path: string;
    workspaceID: string;
  }> = [];
  const absolutePath = "/Users/example/Downloads/skills/SKILL.md";

  await saveWorkspaceFilePreviewText({
    content: "updated",
    path: absolutePath,
    tuttidClient: {
      async writeWorkspaceFileText(workspaceID, request) {
        writes.push({
          content: request.content,
          path: request.path,
          workspaceID
        });
      }
    },
    workspaceID: "workspace-1"
  });

  assert.deepEqual(writes, [
    {
      content: "updated",
      path: absolutePath,
      workspaceID: "workspace-1"
    }
  ]);
});
