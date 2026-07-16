import { describe, expect, it } from "vitest";
import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import type { WorkspaceAgentActivityCard } from "../../workspaceAgentActivityListViewModel";
import type {
  WorkspaceAgentSessionDetailTurn,
  WorkspaceAgentSessionDetailViewModel
} from "../../workspaceAgentSessionDetailViewModel";
import {
  projectAgentTurnSummaryRowForTurn,
  projectAgentTurnSummaryRows
} from "./agentTurnSummaryProjection";

describe("agent turn summary canonical projection", () => {
  it("projects create, modify, and delete semantics from turn.fileChanges", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      turn("turn-1"),
      {
        files: [
          {
            path: "/workspace/src/app.ts",
            change: "modified",
            diff: "@@ -1 +1 @@\n-old\n+new"
          },
          {
            path: "/workspace/src/routes.ts",
            change: "added",
            oldString: "",
            newString: "export const routes = []"
          },
          {
            path: "/workspace/obsolete.txt",
            change: "deleted",
            oldString: "obsolete\n",
            newString: ""
          }
        ]
      },
      { workspaceRoot: "/workspace", occurredAtUnixMs: 40 }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileCount: 3,
      createdCount: 1,
      modifiedCount: 2,
      occurredAtUnixMs: 40
    });
    expect(
      rows[0]?.files.map(({ path, changeType, label }) => ({
        path,
        changeType,
        label
      }))
    ).toEqual([
      {
        path: "/workspace/src/app.ts",
        changeType: "modified",
        label: "app.ts"
      },
      {
        path: "/workspace/src/routes.ts",
        changeType: "created",
        label: "routes.ts"
      },
      {
        path: "/workspace/obsolete.txt",
        changeType: "deleted",
        label: "obsolete.txt"
      }
    ]);
  });

  it("keeps executable patch batches separate from canonical presentation", () => {
    const sourceTurn = turn("turn-patch", [
      {
        id: "call-patch",
        name: "Edit",
        toolName: "Edit",
        callType: "tool",
        status: "Completed",
        statusKind: "completed",
        summary: "Edit two files",
        occurredAtUnixMs: 20,
        payload: {
          input: {
            cwd: "/workspace",
            changes: [
              {
                path: "/workspace/src/app.ts",
                type: "update",
                oldString: "old",
                newString: "new"
              },
              {
                path: "/workspace/not-in-turn.ts",
                type: "update",
                oldString: "old",
                newString: "new"
              }
            ]
          }
        }
      }
    ]);

    const rows = projectAgentTurnSummaryRowForTurn(
      sourceTurn,
      {
        files: [
          {
            path: "/workspace/src/app.ts",
            change: "modified"
          }
        ]
      },
      { workspaceRoot: "/workspace", defaultCwd: "/workspace" }
    );

    expect(rows[0]?.patchBatches).toEqual([
      {
        cwd: "/workspace",
        toolCallId: "call-patch",
        changes: [
          expect.objectContaining({
            path: "/workspace/src/app.ts",
            changeType: "modified",
            oldString: "old",
            newString: "new"
          })
        ]
      }
    ]);
  });

  it("projects every canonical settled turn and ignores legacy tool inference", () => {
    const older = turn("turn-old", [legacyWrite("old.txt")]);
    const latest = turn("turn-latest", [legacyWrite("wrong.txt")]);
    const source = detail([older, latest], {
      files: [{ path: "/workspace/current.txt", change: "modified" }]
    });
    source.sessionTurns = [
      {
        agentSessionId: "session-1",
        turnId: "turn-old",
        phase: "settled",
        origin: "user_prompt",
        outcome: "completed",
        startedAtUnixMs: 1,
        settledAtUnixMs: 20,
        updatedAtUnixMs: 20,
        fileChanges: {
          files: [
            {
              path: "/workspace/obsolete.txt",
              change: "deleted",
              oldString: "obsolete",
              newString: ""
            }
          ]
        }
      },
      {
        agentSessionId: "session-1",
        turnId: "turn-latest",
        phase: "settled",
        origin: "user_prompt",
        outcome: "completed",
        startedAtUnixMs: 21,
        settledAtUnixMs: 40,
        updatedAtUnixMs: 40,
        fileChanges: {
          files: [
            {
              path: "/workspace/current.txt",
              change: "modified"
            }
          ]
        }
      }
    ];
    const rows = projectAgentTurnSummaryRows(source);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.turnId)).toEqual(["turn-old", "turn-latest"]);
    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/obsolete.txt",
        changeType: "deleted"
      })
    ]);
  });

  it("does not backfill missing turn.fileChanges from current or historical payloads", () => {
    const source = detail([turn("turn-latest", [legacyWrite("legacy.txt")])]);
    source.activity.changedFiles = [
      { path: "/workspace/activity.txt", label: "activity.txt" }
    ];

    expect(projectAgentTurnSummaryRows(source)).toEqual([]);
  });
});

function turn(
  id: string,
  toolCalls: WorkspaceAgentSessionDetailTurn["toolCalls"] = []
): WorkspaceAgentSessionDetailTurn {
  return {
    id,
    userMessage: null,
    userMessages: [],
    agentMessages: [],
    toolCalls,
    toolCallCount: toolCalls.length,
    hasFailedToolCall: false,
    agentItems: []
  };
}

function legacyWrite(
  fileName: string
): WorkspaceAgentSessionDetailTurn["toolCalls"][number] {
  return {
    id: `call:${fileName}`,
    name: "Write",
    toolName: "Write",
    callType: "tool",
    status: "Completed",
    statusKind: "completed",
    summary: fileName,
    occurredAtUnixMs: 10,
    payload: {
      input: {
        file_path: `/workspace/${fileName}`,
        content: "legacy"
      }
    }
  };
}

function detail(
  turns: WorkspaceAgentSessionDetailTurn[],
  fileChanges?: Record<string, unknown>
): WorkspaceAgentSessionDetailViewModel {
  const latestTurnId = turns.at(-1)?.id ?? "turn-latest";
  return {
    activity: {
      id: "activity-1",
      sessionId: "session-1",
      userId: "user-1",
      userName: "User",
      agentProvider: "cursor",
      agentName: "Cursor",
      title: "Edit files",
      latestActivitySummary: "Completed",
      status: "completed",
      changedFiles: [],
      sortTimeUnixMs: 40
    } satisfies WorkspaceAgentActivityCard,
    session: normalizeAgentActivitySession({
      workspaceId: "workspace-1",
      agentSessionId: "session-1",
      provider: "cursor",
      providerSessionId: "provider-1",
      cwd: "/workspace",
      title: "Edit files",
      activeTurnId: null,
      latestTurnInteractions: [],
      pendingInteractions: [],
      latestTurn: {
        agentSessionId: "session-1",
        turnId: latestTurnId,
        phase: "settled",
        origin: "user_prompt",
        outcome: "completed",
        startedAtUnixMs: 1,
        settledAtUnixMs: 40,
        updatedAtUnixMs: 40,
        ...(fileChanges ? { fileChanges } : {})
      }
    }),
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    sessionTurns: fileChanges
      ? [
          {
            agentSessionId: "session-1",
            turnId: latestTurnId,
            phase: "settled",
            origin: "user_prompt",
            outcome: "completed",
            startedAtUnixMs: 1,
            settledAtUnixMs: 40,
            updatedAtUnixMs: 40,
            fileChanges
          }
        ]
      : [],
    turns
  };
}
