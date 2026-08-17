import assert from "node:assert/strict";
import test from "node:test";
import type {
  IssueManagerAddContextRefsInput,
  IssueManagerFileReference,
  IssueManagerRemoveContextRefInput
} from "../../contracts/index.ts";
import type { IssueManagerFeature } from "../../core/index.ts";
import {
  canIssueManagerOpenReferences,
  canIssueManagerRequestReferencesDirectly,
  executeIssueManagerAttachReferences,
  executeIssueManagerOpenReference,
  executeIssueManagerRemoveContextRef,
  executeIssueManagerUploadReferences,
  resolveIssueManagerReferenceInsertionContent
} from "./reference/controllerReferenceCommands.ts";
import {
  canIssueManagerCreateShareLink,
  executeIssueManagerShareSelection
} from "./share/controllerShareCommands.ts";
import { installNavigatorClipboard } from "./controllerActionTestHarness.ts";

test("controllerCommands detects direct reference adapters without browse support", () => {
  assert.equal(
    canIssueManagerRequestReferencesDirectly({
      async requestReferences() {
        return [];
      }
    }),
    true
  );
  assert.equal(
    canIssueManagerRequestReferencesDirectly({
      async listDirectory() {
        return {
          directoryPath: "/workspace",
          entries: []
        };
      },
      async requestReferences() {
        return [];
      }
    }),
    false
  );
});

test("controllerCommands build inserted markdown links from filtered references", () => {
  assert.equal(
    resolveIssueManagerReferenceInsertionContent({
      content: "Existing note",
      refs: [
        {
          displayName: "README.md",
          kind: "file",
          path: "/workspace/docs/README.md"
        },
        {
          displayName: "design",
          kind: "folder",
          path: "/workspace/docs/design"
        },
        {
          displayName: "ignored",
          kind: "file",
          path: "   "
        }
      ]
    }),
    "Existing note [README.md](/workspace/docs/README.md) [design](/workspace/docs/design/)"
  );
});

test("controllerCommands detect open/share adapters only when the method exists", () => {
  assert.equal(
    canIssueManagerOpenReferences({
      async openReference() {}
    }),
    true
  );
  assert.equal(canIssueManagerOpenReferences({}), false);
  assert.equal(
    canIssueManagerCreateShareLink({
      async createIssueLink() {
        return "tutti://workspace/workspace-1/issues/issue-1";
      }
    }),
    true
  );
  assert.equal(canIssueManagerCreateShareLink({}), false);
});

test("controllerCommands attach prepared task references through backend", async () => {
  const addContextRefsCalls: IssueManagerAddContextRefsInput[] = [];

  const attached = await executeIssueManagerAttachReferences({
    backend: {
      async addContextRefs(input: IssueManagerAddContextRefsInput) {
        addContextRefsCalls.push(input);
        return [];
      }
    } as unknown as IssueManagerFeature["backend"],
    refs: [
      {
        displayName: "spec.md",
        kind: "file",
        path: "/workspace/spec.md"
      },
      {
        displayName: "ignored",
        kind: "file",
        path: ""
      }
    ],
    selectedIssueId: "issue-1",
    target: {
      mode: "attach",
      parentKind: "task",
      taskId: "task-9"
    },
    workspaceId: "workspace-1"
  });

  assert.equal(attached, true);
  assert.deepEqual(addContextRefsCalls, [
    {
      issueId: "issue-1",
      parentKind: "task",
      refs: [
        {
          displayName: "spec.md",
          path: "/workspace/spec.md",
          refType: "file"
        }
      ],
      taskId: "task-9",
      workspaceId: "workspace-1"
    }
  ]);
});

test("controllerCommands open references through the file adapter", async () => {
  const openCalls: IssueManagerFileReference[] = [];
  const reference: IssueManagerFileReference = {
    displayName: "README.md",
    kind: "file",
    path: "/workspace/docs/README.md"
  };

  await executeIssueManagerOpenReference({
    fileAdapter: {
      async openReference(input) {
        openCalls.push(input);
      }
    },
    reference
  });

  assert.deepEqual(openCalls, [reference]);
});

test("controllerCommands remove issue and task refs with canonical payloads", async () => {
  const removeCalls: IssueManagerRemoveContextRefInput[] = [];
  const backend = {
    async removeContextRef(input: IssueManagerRemoveContextRefInput) {
      removeCalls.push(input);
      return { removed: true };
    }
  };

  await executeIssueManagerRemoveContextRef({
    backend: backend as unknown as IssueManagerFeature["backend"],
    ref: {
      accessKind: "workspace_path",
      contextRefId: "issue:/workspace/docs/spec.md",
      displayName: "spec.md",
      issueId: "issue-1",
      parentKind: "issue",
      path: "/workspace/docs/spec.md",
      refType: "file",
      workspaceId: "workspace-1"
    },
    workspaceId: "workspace-1"
  });
  await executeIssueManagerRemoveContextRef({
    backend: backend as unknown as IssueManagerFeature["backend"],
    ref: {
      accessKind: "workspace_path",
      contextRefId: "task-9:/workspace/docs/design.md",
      displayName: "design.md",
      issueId: "issue-1",
      parentKind: "task",
      path: "/workspace/docs/design.md",
      refType: "file",
      taskId: "task-9",
      workspaceId: "workspace-1"
    },
    workspaceId: "workspace-1"
  });

  assert.deepEqual(removeCalls, [
    {
      contextRefId: "issue:/workspace/docs/spec.md",
      issueId: "issue-1",
      parentKind: "issue",
      workspaceId: "workspace-1"
    },
    {
      contextRefId: "task-9:/workspace/docs/design.md",
      issueId: "issue-1",
      parentKind: "task",
      taskId: "task-9",
      workspaceId: "workspace-1"
    }
  ]);
});

test("controllerCommands upload references refreshes the touched paths", async () => {
  const refreshCalls: Array<{
    depth?: number;
    paths?: readonly string[];
    workspaceId: string;
  }> = [];
  const refs: IssueManagerFileReference[] = [
    {
      displayName: "brief.md",
      kind: "file",
      path: "/workspace/brief.md"
    }
  ];

  const uploadedRefs = await executeIssueManagerUploadReferences({
    fileAdapter: {
      async refreshTree(input) {
        refreshCalls.push(input);
      },
      async requestUpload() {
        return refs;
      }
    },
    mode: "files",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(uploadedRefs, refs);
  assert.deepEqual(refreshCalls, [
    {
      depth: 1,
      paths: ["/workspace/brief.md"],
      workspaceId: "workspace-1"
    }
  ]);
});

test("controllerCommands share selections through the share adapter and clipboard", async (t) => {
  const shareCalls: Array<{
    issueId: string;
    taskId?: string;
    workspaceId: string;
  }> = [];
  let copiedText: string | null = null;
  const restoreNavigator = installNavigatorClipboard(async (value) => {
    copiedText = value;
  });
  t.after(restoreNavigator);

  await executeIssueManagerShareSelection({
    issueId: "issue-1",
    shareAdapter: {
      async createIssueLink(input) {
        shareCalls.push(input);
        return "tutti://workspace/workspace-1/issues/issue-1/tasks/task-1";
      }
    },
    taskId: "task-1",
    workspaceId: "workspace-1"
  });

  assert.deepEqual(shareCalls, [
    {
      issueId: "issue-1",
      taskId: "task-1",
      workspaceId: "workspace-1"
    }
  ]);
  assert.equal(
    copiedText,
    "tutti://workspace/workspace-1/issues/issue-1/tasks/task-1"
  );
});
