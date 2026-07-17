import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createWorkspaceAppUserActiveTrackEvent,
  workspaceAppUserActiveEventName
} from "./workspaceAppActivityAnalytics.ts";

const workspaceAppContextSource = readFileSync(
  new URL("./workspaceAppContext.ts", import.meta.url),
  "utf8"
);

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

test("workspace app at resolution is scoped by the registered guest context", () => {
  assert.match(
    workspaceAppContextSource,
    /appExternal\.atResolve,[\s\S]*?requireWorkspaceAppGuestContext\(event\.sender\)[\s\S]*?normalizeTuttiExternalAtResolveInput\(payload\)[\s\S]*?appId: context\.appID,[\s\S]*?operation: "at\.resolve",[\s\S]*?workspaceId: context\.workspaceID/
  );
});
