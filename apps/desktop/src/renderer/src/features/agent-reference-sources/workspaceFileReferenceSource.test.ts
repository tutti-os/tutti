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

test("local source searches recent from the recent reference list", async () => {
  let searchedWholeWorkspace = false;
  let observedRecentLimit: number | undefined;
  const adapter: WorkspaceFileReferenceAdapter = {
    async listRecentReferences(input) {
      observedRecentLimit = input.limit;
      return [
        { kind: "file", path: "/workspace/2026.md" },
        { kind: "file", path: "/workspace/notes.txt" },
        { kind: "folder", path: "/workspace/2026-archive" }
      ];
    },
    async searchReferences() {
      searchedWholeWorkspace = true;
      return [{ kind: "file", path: "/workspace/global-2026.md" }];
    }
  };
  const source = createWorkspaceFileReferenceSource({
    adapter,
    label: "Local"
  });

  const result = await source.search?.(scope, {
    filters: ["document"],
    limit: 1,
    query: "2026",
    withinNodeId: "__recent__"
  });

  assert.equal(searchedWholeWorkspace, false);
  assert.equal(observedRecentLimit, 100);
  assert.deepEqual(
    result?.entries.map((entry) => entry.ref.nodeId),
    ["/workspace/2026.md"]
  );
});

test("local source lists up to 100 recent references", async () => {
  let observedRecentLimit: number | undefined;
  const adapter: WorkspaceFileReferenceAdapter = {
    async listRecentReferences(input) {
      observedRecentLimit = input.limit;
      return [{ kind: "file", path: "/workspace/notes.txt" }];
    }
  };
  const source = createWorkspaceFileReferenceSource({
    adapter,
    label: "Local"
  });

  await source.listChildren?.(scope, {
    node: {
      sourceId: "workspace-file",
      nodeId: "__recent__"
    }
  });

  assert.equal(observedRecentLimit, 100);
});

test("local source hides recent on Windows and keeps it on macOS", async () => {
  const adapter: WorkspaceFileReferenceAdapter = {};
  const windowsSource = createWorkspaceFileReferenceSource({
    adapter,
    label: "Local",
    os: "win32"
  });
  const macSource = createWorkspaceFileReferenceSource({
    adapter,
    label: "Local",
    os: "darwin"
  });

  const windowsGroups = await windowsSource.loadSidebarGroups?.(scope, {});
  const macGroups = await macSource.loadSidebarGroups?.(scope, {});

  assert.equal(
    windowsGroups?.entries.some((entry) => entry.ref.nodeId === "__recent__"),
    false
  );
  assert.equal(
    macGroups?.entries.some((entry) => entry.ref.nodeId === "__recent__"),
    true
  );
});

test("local source recent search only matches file names", async () => {
  const adapter: WorkspaceFileReferenceAdapter = {
    async listRecentReferences() {
      return [
        {
          displayName: "spec.md",
          kind: "file",
          path: "/Users/local/workspace/project/spec.md"
        }
      ];
    }
  };
  const source = createWorkspaceFileReferenceSource({
    adapter,
    label: "Local"
  });

  const result = await source.search?.(scope, {
    query: "workspace",
    withinNodeId: "__recent__"
  });

  assert.deepEqual(result?.entries, []);
});

test("local source ignores personal root sentinel for scoping", async () => {
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
    withinNodeId: WORKSPACE_ROOT_GROUP_NODE_ID
  });

  assert.equal(observed?.within, undefined);
});
