import assert from "node:assert/strict";
import test from "node:test";
import { dispatchWorkspaceAppExternalAtRequest } from "./workspaceAppExternalAtRequest.ts";

test("workspace app external at directory requests dispatch with host workspace context", async () => {
  const calls: unknown[] = [];
  const result = await dispatchWorkspaceAppExternalAtRequest({
    hostService: {
      async queryWorkspaceAppExternalAt() {
        throw new Error("unexpected at.query");
      },
      async queryWorkspaceAppExternalAtDirectory(input) {
        calls.push(input);
        return [];
      },
      async resolveWorkspaceAppExternalAt() {
        throw new Error("unexpected at.resolve");
      }
    },
    request: {
      appId: "docs",
      input: {
        directoryPath: "/workspace/docs",
        providerId: "file"
      },
      operation: "at.queryDirectory",
      requestId: "request-1",
      workspaceId: "untrusted-request-workspace"
    },
    workspaceId: "workspace-1"
  });

  assert.deepEqual(result, []);
  assert.deepEqual(calls, [
    {
      query: {
        directoryPath: "/workspace/docs",
        providerId: "file"
      },
      workspaceId: "workspace-1"
    }
  ]);
});
