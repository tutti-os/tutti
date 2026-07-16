import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkspaceFileManagerPreservedNameColumnWidth,
  workspaceFileManagerCompactTableGridTemplate,
  workspaceFileManagerTableGridTemplate,
  workspaceFileManagerTableNameMinWidth,
  workspaceFileManagerTableNameMinWidthProperty
} from "./workspaceFileManagerTableSizing.ts";

test("workspace file manager keeps the name column while metadata columns shrink", () => {
  assert.equal(workspaceFileManagerTableNameMinWidth, 240);
  assert.equal(
    workspaceFileManagerTableGridTemplate,
    "minmax(var(--workspace-file-manager-table-name-min-width, 240px), 1fr) minmax(0, 148px) minmax(0, 96px)"
  );
  assert.equal(
    workspaceFileManagerCompactTableGridTemplate,
    "minmax(var(--workspace-file-manager-table-name-min-width, 240px), 1fr) minmax(0, 96px) minmax(0, 72px)"
  );
});

test("workspace file manager preserves the current name width when sidebar resizing starts", () => {
  assert.equal(
    workspaceFileManagerTableNameMinWidthProperty,
    "--workspace-file-manager-table-name-min-width"
  );
  assert.equal(resolveWorkspaceFileManagerPreservedNameColumnWidth(386.4), 386);
  assert.equal(resolveWorkspaceFileManagerPreservedNameColumnWidth(120), 240);
  assert.equal(
    resolveWorkspaceFileManagerPreservedNameColumnWidth(Number.NaN),
    240
  );
});
