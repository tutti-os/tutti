import assert from "node:assert/strict";
import test from "node:test";
import type {
  ReferenceScope,
  WorkspaceFileReferenceAdapter
} from "@tutti-os/workspace-file-reference/contracts";
import { WORKSPACE_ROOT_GROUP_NODE_ID } from "@tutti-os/workspace-file-reference/core";
import { createWorkspaceFileReferenceSource } from "./workspaceFileReferenceSource.ts";

const scope: ReferenceScope = { workspaceId: "workspace-1" };

test("local source scopes search to the selected directory location", async () => {
  let observed: { within?: string } | undefined;
  const adapter: WorkspaceFileReferenceAdapter = {
    async searchReferences(input) {
      observed = input;
      return [];
    }
  };
  const source = createWorkspaceFileReferenceSource({
    adapter,
    label: "Local"
  });

  await source.search?.(scope, {
    query: "report",
    withinNodeId: "Documents"
  });

  assert.equal(observed?.within, "Documents");
});

test("local source ignores virtual locations (recent, personal root) for scoping", async () => {
  for (const sentinel of ["__recent__", WORKSPACE_ROOT_GROUP_NODE_ID]) {
    let observed: { within?: string } | undefined;
    const adapter: WorkspaceFileReferenceAdapter = {
      async searchReferences(input) {
        observed = input;
        return [];
      }
    };
    const source = createWorkspaceFileReferenceSource({
      adapter,
      label: "Local"
    });

    await source.search?.(scope, {
      query: "report",
      withinNodeId: sentinel
    });

    assert.equal(
      observed?.within,
      undefined,
      `expected no scope for sentinel ${sentinel}`
    );
  }
});
