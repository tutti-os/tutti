import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceAppAtQueryDirectoryRequest } from "./workspaceAppAtQueryDirectoryRequest.ts";

test("workspace app directory request uses registered guest identity", () => {
  assert.deepEqual(
    createWorkspaceAppAtQueryDirectoryRequest({
      context: { appID: "docs", workspaceID: "workspace-1" },
      query: { directoryPath: "/workspace/docs", providerId: "file" },
      requestId: "request-1"
    }),
    {
      appId: "docs",
      input: { directoryPath: "/workspace/docs", providerId: "file" },
      operation: "at.queryDirectory",
      requestId: "request-1",
      workspaceId: "workspace-1"
    }
  );
});
