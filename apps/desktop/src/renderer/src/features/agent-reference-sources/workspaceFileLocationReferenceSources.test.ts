import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFileLocationSection } from "@tutti-os/workspace-file-manager/services";
import type { WorkspaceFileReferenceAdapter } from "@tutti-os/workspace-file-reference/contracts";
import {
  USER_PROJECT_REFERENCE_SOURCE_ID,
  WORKSPACE_FILE_SOURCE_ID,
  createWorkspaceFileLocationReferenceSources
} from "./workspaceFileLocationReferenceSources.ts";

test("location reference sources expose project and local sidebar groups", async () => {
  const sources = createWorkspaceFileLocationReferenceSources({
    adapter: {},
    getLocationSections: () => locationSections,
    localLabel: "Local",
    projectLabel: "Project"
  });

  assert.deepEqual(
    sources.map((source) => source.metadata.id),
    [USER_PROJECT_REFERENCE_SOURCE_ID, WORKSPACE_FILE_SOURCE_ID]
  );
  assert.deepEqual(
    sources[0]
      ?.listSidebarGroups?.({ workspaceId: "workspace-1" })
      .map((node) => [node.ref.sourceId, node.ref.nodeId, node.displayName]),
    [[USER_PROJECT_REFERENCE_SOURCE_ID, "/Users/local/repo", "Repo"]]
  );
  assert.deepEqual(
    sources[1]
      ?.listSidebarGroups?.({ workspaceId: "workspace-1" })
      .map((node) => [node.ref.sourceId, node.ref.nodeId, node.displayName]),
    [
      [WORKSPACE_FILE_SOURCE_ID, "__recent__", "Recent"],
      [WORKSPACE_FILE_SOURCE_ID, "Downloads", "Downloads"]
    ]
  );
});

test("location reference source locates projects by id and path", async () => {
  const [projectSource] = createWorkspaceFileLocationReferenceSources({
    adapter: {},
    getLocationSections: () => locationSections,
    localLabel: "Local",
    projectLabel: "Project"
  });

  assert.deepEqual(
    await projectSource?.locateTarget?.(
      { workspaceId: "workspace-1" },
      { projectId: "project-1", projectPath: "" }
    ),
    [
      {
        sourceId: USER_PROJECT_REFERENCE_SOURCE_ID,
        nodeId: "/Users/local/repo"
      }
    ]
  );
  assert.deepEqual(
    await projectSource?.locateTarget?.(
      { workspaceId: "workspace-1" },
      { projectPath: "/Users/local/repo" }
    ),
    [
      {
        sourceId: USER_PROJECT_REFERENCE_SOURCE_ID,
        nodeId: "/Users/local/repo"
      }
    ]
  );
});

test("location reference source searches recent from recent references", async () => {
  const adapter: WorkspaceFileReferenceAdapter = {
    async listRecentReferences() {
      return [
        {
          displayName: "notes.txt",
          kind: "file",
          path: "/Users/local/notes.txt"
        },
        {
          displayName: "archive.txt",
          kind: "file",
          path: "/Users/local/archive.txt"
        }
      ];
    }
  };
  const [, localSource] = createWorkspaceFileLocationReferenceSources({
    adapter,
    getLocationSections: () => locationSections,
    localLabel: "Local",
    projectLabel: "Project"
  });

  const result = await localSource?.search?.(
    { workspaceId: "workspace-1" },
    {
      query: "notes",
      withinNodeId: "__recent__"
    }
  );

  assert.deepEqual(
    result?.entries.map((entry) => entry.ref.nodeId),
    ["/Users/local/notes.txt"]
  );
});

test("location reference source lists up to 100 recent references", async () => {
  let observedRecentLimit: number | undefined;
  const adapter: WorkspaceFileReferenceAdapter = {
    async listRecentReferences(input) {
      observedRecentLimit = input.limit;
      return [
        {
          displayName: "notes.txt",
          kind: "file",
          path: "/Users/local/notes.txt"
        }
      ];
    }
  };
  const [, localSource] = createWorkspaceFileLocationReferenceSources({
    adapter,
    getLocationSections: () => locationSections,
    localLabel: "Local",
    projectLabel: "Project"
  });

  await localSource?.listChildren?.(
    { workspaceId: "workspace-1" },
    {
      node: {
        sourceId: WORKSPACE_FILE_SOURCE_ID,
        nodeId: "__recent__"
      }
    }
  );

  assert.equal(observedRecentLimit, 100);
});

test("location reference source recent search only matches file names", async () => {
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
  const [, localSource] = createWorkspaceFileLocationReferenceSources({
    adapter,
    getLocationSections: () => locationSections,
    localLabel: "Local",
    projectLabel: "Project"
  });

  const result = await localSource?.search?.(
    { workspaceId: "workspace-1" },
    {
      query: "workspace",
      withinNodeId: "__recent__"
    }
  );

  assert.deepEqual(result?.entries, []);
});

test("location reference source scopes directory search by selected location", async () => {
  const withinValues: Array<string | undefined> = [];
  const adapter: WorkspaceFileReferenceAdapter = {
    async searchReferences(input) {
      withinValues.push(input.within);
      return [];
    }
  };
  const [projectSource] = createWorkspaceFileLocationReferenceSources({
    adapter,
    getLocationSections: () => locationSections,
    localLabel: "Local",
    projectLabel: "Project"
  });

  await projectSource?.search?.(
    { workspaceId: "workspace-1" },
    {
      query: "app",
      withinNodeId: "/Users/local/repo"
    }
  );

  assert.deepEqual(withinValues, ["/Users/local/repo"]);
});

test("location reference source preserves creation times on search results", async () => {
  const adapter: WorkspaceFileReferenceAdapter = {
    async searchReferences() {
      return [
        {
          createdTimeMs: 1_800_000_000_000,
          kind: "file",
          mtimeMs: 1_800_000_001_000,
          path: "/Users/local/report.md"
        }
      ];
    }
  };
  const [, localSource] = createWorkspaceFileLocationReferenceSources({
    adapter,
    getLocationSections: () => locationSections,
    localLabel: "Local",
    projectLabel: "Project"
  });

  const result = await localSource?.search?.(
    { workspaceId: "workspace-1" },
    {
      query: "report"
    }
  );

  assert.equal(result?.entries[0]?.createdTimeMs, 1_800_000_000_000);
});

const locationSections: WorkspaceFileLocationSection[] = [
  {
    id: "project",
    label: "Project",
    locations: [
      {
        contextLabel: "/Users/local/repo",
        id: "project:project-1",
        kind: "directory",
        label: "Repo",
        path: "/Users/local/repo",
        referenceNodeId: "/Users/local/repo"
      }
    ]
  },
  {
    id: "local",
    label: "Local",
    locations: [
      {
        id: "local:recent",
        kind: "recent",
        label: "Recent"
      },
      {
        id: "local:downloads",
        kind: "directory",
        label: "Downloads",
        path: "/Users/local/Downloads",
        referenceNodeId: "Downloads"
      }
    ]
  }
];
