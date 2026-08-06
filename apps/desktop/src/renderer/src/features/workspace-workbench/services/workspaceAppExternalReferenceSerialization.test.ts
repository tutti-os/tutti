import assert from "node:assert/strict";
import test from "node:test";
import { serializeWorkspaceAppExternalReferenceSelection } from "./workspaceAppExternalReferenceSerialization.ts";

test("serializes paths and lazy application artifact bundles", () => {
  assert.deepEqual(
    serializeWorkspaceAppExternalReferenceSelection("workspace-1", {
      files: [{ displayName: "notes.md", kind: "file", path: "/notes.md" }],
      bundles: [
        {
          displayName: "Canvas outputs",
          fileCount: 3,
          handle: { groupId: "outputs", id: "ai-canvas", source: "app" },
          nodeId: "opaque-node",
          sourceId: "app-artifact"
        },
        {
          displayName: "Issue files",
          fileCount: 2,
          handle: { id: "topic-1", source: "task" },
          nodeId: "opaque-issue",
          sourceId: "issue"
        }
      ]
    }),
    [
      {
        selectionKind: "path",
        reference: {
          displayName: "notes.md",
          kind: "file",
          path: "/notes.md"
        }
      },
      {
        selectionKind: "workspace-reference",
        displayName: "Canvas outputs",
        fileCount: 3,
        groupId: "outputs",
        id: "ai-canvas",
        source: "app",
        workspaceId: "workspace-1"
      }
    ]
  );
});
