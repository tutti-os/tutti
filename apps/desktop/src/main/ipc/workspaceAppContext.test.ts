import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspaceAppUserActiveTrackEvent,
  workspaceAppUserActiveEventName
} from "./workspaceAppActivityAnalytics.ts";

test("workspace app user active event uses host-owned app context", () => {
  assert.deepEqual(
    createWorkspaceAppUserActiveTrackEvent(
      {
        appID: "demo-app",
        workspaceID: "workspace-1"
      },
      1749124800000
    ),
    {
      client_ts: 1749124800000,
      name: workspaceAppUserActiveEventName,
      params: {
        app_id: "demo-app",
        workspace_id: "workspace-1"
      }
    }
  );
});
