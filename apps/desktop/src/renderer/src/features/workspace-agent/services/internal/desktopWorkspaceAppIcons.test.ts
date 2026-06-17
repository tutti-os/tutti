import assert from "node:assert/strict";
import test from "node:test";
import { resolveDesktopWorkspaceAppIconEntries } from "./desktopWorkspaceAppIcons.ts";

test("desktop workspace app icon entries use App Center icon fields", () => {
  const entries = resolveDesktopWorkspaceAppIconEntries({
    apps: [
      {
        appId: "automation",
        availableIconUrl: "available-automation.png",
        iconUrl: "stored-automation.png"
      },
      {
        appId: "notes",
        availableIconUrl: "available-notes.png",
        iconUrl: null
      }
    ],
    workspaceId: "workspace-1"
  });

  assert.deepEqual(entries, [
    {
      appId: "automation",
      iconUrl: "stored-automation.png",
      workspaceId: "workspace-1"
    },
    {
      appId: "notes",
      iconUrl: "available-notes.png",
      workspaceId: "workspace-1"
    }
  ]);
});
