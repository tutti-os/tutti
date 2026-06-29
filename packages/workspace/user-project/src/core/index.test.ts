import assert from "node:assert/strict";
import test from "node:test";
import {
  basenameWorkspaceUserProjectPath,
  getWorkspaceUserProjectErrorCode,
  prepareWorkspaceUserProjectSelection,
  resolveWorkspaceUserProjectDisplayLabel,
  stripAbsolutePathFromWorkspaceUserProjectLabel,
  upsertWorkspaceUserProject
} from "./index.ts";

test("workspace user project labels hide absolute paths", () => {
  assert.equal(
    stripAbsolutePathFromWorkspaceUserProjectLabel(
      "Private Project /Users/local/Documents/Private Project"
    ),
    "Private Project"
  );
  assert.equal(
    stripAbsolutePathFromWorkspaceUserProjectLabel(
      "C:\\Users\\local\\Documents\\Windows Project"
    ),
    "Windows Project"
  );
  assert.equal(
    stripAbsolutePathFromWorkspaceUserProjectLabel(
      "Shared \\\\server\\workspace\\Shared"
    ),
    "Shared"
  );
});

test("workspace user project display labels fall back to basename and id", () => {
  assert.equal(
    resolveWorkspaceUserProjectDisplayLabel({
      id: "project-1",
      label: "tutti /workspace/tutti",
      path: "/workspace/tutti"
    }),
    "tutti"
  );
  assert.equal(
    resolveWorkspaceUserProjectDisplayLabel({
      id: "project-2",
      label: "   ",
      path: "/workspace/automation/"
    }),
    "automation"
  );
  assert.equal(
    resolveWorkspaceUserProjectDisplayLabel({
      id: "project-3",
      label: "",
      path: "   "
    }),
    "project-3"
  );
});

test("workspace user project basename supports unix and windows paths", () => {
  assert.equal(basenameWorkspaceUserProjectPath("/workspace/tutti/"), "tutti");
  assert.equal(
    basenameWorkspaceUserProjectPath("C:\\Users\\local\\repo"),
    "repo"
  );
});

test("workspace user project upsert replaces by id or path", () => {
  const first = {
    id: "project-1",
    label: "tutti",
    path: "/workspace/tutti"
  };
  const second = {
    id: "project-2",
    label: "automation",
    path: "/workspace/automation"
  };

  assert.deepEqual(upsertWorkspaceUserProject([], first), [first]);
  assert.deepEqual(
    upsertWorkspaceUserProject([first], {
      ...first,
      label: "Tutti"
    }),
    [
      {
        ...first,
        label: "Tutti"
      }
    ]
  );
  assert.deepEqual(
    upsertWorkspaceUserProject([first], {
      ...second,
      path: first.path
    }),
    [
      {
        ...second,
        path: first.path
      }
    ]
  );
});

test("workspace user project error code walks causes", () => {
  assert.equal(
    getWorkspaceUserProjectErrorCode({
      cause: {
        code: "project_name_invalid"
      }
    }),
    "project_name_invalid"
  );
  assert.equal(getWorkspaceUserProjectErrorCode(new Error("plain")), null);
});

test("prepareWorkspaceUserProjectSelection delegates explicit preparation", async () => {
  const prepared = {
    isSelectedPathMissing: true,
    projects: [],
    selection: { kind: "none" as const }
  };

  assert.equal(
    await prepareWorkspaceUserProjectSelection(
      {
        async list() {
          throw new Error("list should not run");
        },
        async prepareSelection(input) {
          assert.deepEqual(input, {
            projectLocked: true,
            selectedPath: "/workspace/missing"
          });
          return prepared;
        }
      },
      {
        projectLocked: true,
        selectedPath: "/workspace/missing"
      }
    ),
    prepared
  );
});

test("prepareWorkspaceUserProjectSelection resolves fallback decisions", async () => {
  const projects = [
    {
      id: "project-alpha",
      label: "Alpha",
      path: "/workspace/alpha"
    },
    {
      id: "project-beta",
      label: "Beta",
      path: "/workspace/beta"
    }
  ];
  const rememberedSelections: Array<{ path: string | null }> = [];

  const api = {
    async checkPath(input: { path: string }) {
      return {
        exists: input.path !== "/workspace/missing",
        isDirectory: input.path !== "/workspace/missing",
        path: input.path
      };
    },
    async getDefaultSelection() {
      return { path: "/workspace/beta" };
    },
    async list() {
      return { projects };
    },
    rememberDefaultSelection(input: { path: string | null }) {
      rememberedSelections.push(input);
    }
  };

  assert.deepEqual(
    await prepareWorkspaceUserProjectSelection(
      {
        async list() {
          return { projects };
        }
      },
      {
        projectLocked: false,
        selectedPath: null
      }
    ),
    {
      isSelectedPathMissing: false,
      projects,
      selection: { kind: "none" }
    }
  );

  assert.deepEqual(
    await prepareWorkspaceUserProjectSelection(api, {
      projectLocked: false,
      selectedPath: null
    }),
    {
      isSelectedPathMissing: false,
      projects,
      selection: {
        kind: "select",
        path: "/workspace/beta"
      }
    }
  );
  assert.deepEqual(
    await prepareWorkspaceUserProjectSelection(api, {
      projectLocked: false,
      selectedPath: "/workspace/stale"
    }),
    {
      isSelectedPathMissing: false,
      projects,
      selection: {
        kind: "clear",
        suppressedPath: "/workspace/stale"
      }
    }
  );
  assert.deepEqual(rememberedSelections, [{ path: null }]);
  assert.deepEqual(
    await prepareWorkspaceUserProjectSelection(api, {
      projectLocked: true,
      selectedPath: "/workspace/missing"
    }),
    {
      isSelectedPathMissing: true,
      projects,
      selection: { kind: "none" }
    }
  );
});

test("prepareWorkspaceUserProjectSelection preserves explicit no-project default", async () => {
  const projects = [
    {
      id: "project-alpha",
      label: "Alpha",
      path: "/workspace/alpha"
    }
  ];

  assert.deepEqual(
    await prepareWorkspaceUserProjectSelection(
      {
        async getDefaultSelection() {
          return { path: null };
        },
        async list() {
          return { projects };
        }
      },
      {
        projectLocked: false,
        selectedPath: null
      }
    ),
    {
      isSelectedPathMissing: false,
      projects,
      selection: { kind: "none" }
    }
  );
});

test("prepareWorkspaceUserProjectSelection treats no-project paths as present roots", async () => {
  const projects = [
    {
      id: "project-alpha",
      label: "Alpha",
      path: "/workspace/alpha"
    }
  ];
  let checkPathCalls = 0;

  assert.deepEqual(
    await prepareWorkspaceUserProjectSelection(
      {
        async checkPath() {
          checkPathCalls += 1;
          return {
            exists: false,
            isDirectory: false,
            path: "/workspace/workspace-1"
          };
        },
        isNoProjectPath({ path }) {
          return path === "/workspace" || path === "/workspace/workspace-1";
        },
        async list() {
          return { projects };
        }
      },
      {
        projectLocked: true,
        selectedPath: "/workspace/workspace-1"
      }
    ),
    {
      isSelectedPathMissing: false,
      projects,
      selection: { kind: "none" }
    }
  );
  assert.equal(checkPathCalls, 0);
});
