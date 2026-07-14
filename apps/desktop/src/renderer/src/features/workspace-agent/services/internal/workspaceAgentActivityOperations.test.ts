import assert from "node:assert/strict";
import test from "node:test";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { WorkspaceAgentActivityImportOperations } from "./workspaceAgentActivityImportOperations.ts";
import { WorkspaceAgentActivityQueryOperations } from "./workspaceAgentActivityQueryOperations.ts";

test("activity query operations own directory request normalization and response projection", async () => {
  const calls: unknown[] = [];
  const abortController = new AbortController();
  const operations = new WorkspaceAgentActivityQueryOperations({
    listWorkspaceAgentSessionSections: async (
      workspaceId: string,
      request: unknown,
      options: unknown
    ) => {
      calls.push({ options, request, workspaceId });
      return {
        pinned: { hasMore: false, sessions: [], totalCount: 0 },
        sections: [
          {
            hasMore: false,
            kind: "chats",
            nextCursor: undefined,
            sectionKey: "chats",
            sessions: [],
            totalCount: 4,
            userProject: null
          }
        ],
        workspaceId
      };
    }
  } as unknown as TuttidClient);

  const result = await operations.listSessionSections({
    agentTargetId: "  local:codex  ",
    limitPerSection: 12,
    signal: abortController.signal,
    workspaceId: "  workspace-1  "
  });

  assert.deepEqual(calls, [
    {
      options: { signal: abortController.signal },
      request: { agentTargetId: "local:codex", limitPerSection: 12 },
      workspaceId: "workspace-1"
    }
  ]);
  assert.deepEqual(result, {
    pinned: {
      hasMore: false,
      nextCursor: undefined,
      sessions: [],
      totalCount: 0
    },
    sections: [
      {
        hasMore: false,
        kind: "chats",
        nextCursor: undefined,
        sectionKey: "chats",
        sessions: [],
        totalCount: 4,
        userProject: null
      }
    ],
    workspaceId: "workspace-1"
  });
});

test("activity import operations refresh activity and projects after daemon import", async () => {
  const events: string[] = [];
  const operations = new WorkspaceAgentActivityImportOperations({
    refreshActivity: async (workspaceId) => {
      events.push(`activity:${workspaceId}`);
    },
    refreshUserProjects: async () => {
      events.push("projects");
    },
    tuttidClient: {
      importWorkspaceExternalAgentSessions: async (workspaceId: string) => {
        events.push(`import:${workspaceId}`);
        return {
          errors: [],
          importedMessages: 1,
          importedProjects: 1,
          importedSessions: 1,
          skippedSessions: 0
        };
      }
    } as unknown as TuttidClient
  });

  const result = await operations.import(" workspace-1 ", { projects: [] });

  assert.equal(result.importedSessions, 1);
  assert.deepEqual(events, [
    "import:workspace-1",
    "activity:workspace-1",
    "projects"
  ]);
});
