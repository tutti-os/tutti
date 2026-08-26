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
  it("canonicalizes Windows drive aliases in changed-file paths", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      turn("turn-windows"),
      {
        files: [
          {
            path: "/c/Users/demo/project/0817.txt",
            change: "added"
          }
        ]
      },
      {
        workspaceRoot: "C:\\Users\\demo\\project",
        defaultCwd: "C:\\Users\\demo\\project"
      }
    );

    expect(rows[0]?.files[0]?.path).toBe("/C:/Users/demo/project/0817.txt");
  });

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

  it("does not expose invalid file bodies as unified diffs", () => {
    const body = "# README\n\n- bullet\n";
    const rows = projectAgentTurnSummaryRowForTurn(
      turn("turn-invalid-diff"),
      {
        files: [
          {
            path: "/workspace/README.md",
            change: "created",
            diff: body
          },
          {
            path: "/workspace/obsolete.md",
            change: "deleted",
            unifiedDiff: body
          }
        ]
      },
      { workspaceRoot: "/workspace" }
    );

    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/README.md",
        unifiedDiff: null,
        content: body
      }),
      expect.objectContaining({
        path: "/workspace/obsolete.md",
        unifiedDiff: null,
        oldString: body,
        newString: ""
      })
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
          },
          {
            path: "/workspace/not-in-turn.ts",
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
          }),
          expect.objectContaining({
            path: "/workspace/not-in-turn.ts",
            changeType: "modified",
            oldString: "old",
            newString: "new"
          })
        ]
      }
    ]);
  });

  it("prefers canonical fileChanges over contradictory raw Kimi changes", () => {
    const content =
      "这是一个示例文本文件。\n\n当前时间：2026-08-20\n用途：测试文件创建\n\n你可以随时修改或删除此文件。";
    const sourceTurn = turn("turn-kimi-create", [
      {
        id: "call-kimi-create",
        name: "Write",
        toolName: "Write",
        callType: "tool",
        status: "Completed",
        statusKind: "completed",
        summary: "Create note.txt",
        occurredAtUnixMs: 20,
        payload: {
          cwd: "C:/Users/17940/Documents/tutti/test_git",
          fileChanges: {
            files: [
              {
                path: "C:/Users/17940/Documents/tutti/test_git/note.txt",
                change: "added",
                oldString: "",
                newString: content
              }
            ]
          },
          output: {
            changes: [
              {
                path: "C:/Users/17940/Documents/tutti/test_git/note.txt",
                type: "update",
                oldString: "",
                newString: content
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
            path: "C:/Users/17940/Documents/tutti/test_git/note.txt",
            change: "added",
            oldString: "",
            newString: content
          }
        ]
      },
      {
        workspaceRoot: "C:/Users/17940/Documents/tutti/test_git",
        defaultCwd: "C:/Users/17940/Documents/tutti/test_git"
      }
    );

    expect(rows[0]?.patchBatches).toEqual([
      {
        cwd: "C:/Users/17940/Documents/tutti/test_git",
        toolCallId: "call-kimi-create",
        changes: [
          expect.objectContaining({
            path: "/C:/Users/17940/Documents/tutti/test_git/note.txt",
            changeType: "created",
            oldString: "",
            newString: content
          })
        ]
      }
    ]);
  });

  it("drops historical one-sided modified raw changes without a canonical batch", () => {
    const sourceTurn = turn("turn-legacy-one-sided", [
      {
        id: "call-legacy-one-sided",
        name: "Write",
        toolName: "Write",
        callType: "tool",
        status: "Completed",
        statusKind: "completed",
        summary: "Write note.txt",
        occurredAtUnixMs: 20,
        payload: {
          input: {
            cwd: "/workspace",
            changes: [
              {
                path: "/workspace/note.txt",
                type: "update",
                newString: "after"
              }
            ]
          }
        }
      }
    ]);

    const rows = projectAgentTurnSummaryRowForTurn(
      sourceTurn,
      {
        files: [{ path: "/workspace/note.txt", change: "modified" }]
      },
      { workspaceRoot: "/workspace", defaultCwd: "/workspace" }
    );

    expect(rows[0]?.patchBatches).toBeUndefined();
  });

  it("fails the whole batch closed when one canonical sibling is incomplete", () => {
    const sourceTurn = turn("turn-mixed-coverage", [
      {
        id: "call-mixed-coverage",
        name: "Write",
        toolName: "Write",
        callType: "tool",
        status: "Completed",
        statusKind: "completed",
        summary: "Write two files",
        occurredAtUnixMs: 20,
        payload: {
          cwd: "/workspace",
          fileChanges: {
            files: [
              {
                path: "/workspace/created.txt",
                change: "added",
                oldString: "",
                newString: "created"
              },
              {
                path: "/workspace/incomplete.txt",
                change: "modified",
                newString: "after"
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
          { path: "/workspace/created.txt", change: "added" },
          { path: "/workspace/incomplete.txt", change: "modified" }
        ]
      },
      { workspaceRoot: "/workspace", defaultCwd: "/workspace" }
    );

    expect(rows[0]?.patchBatches).toBeUndefined();
  });

  it("fails closed for historical rename metadata without an executable diff", () => {
    const sourceTurn = turn("turn-legacy-rename", [
      {
        id: "call-legacy-rename",
        name: "Move",
        toolName: "Move",
        callType: "tool",
        status: "Completed",
        statusKind: "completed",
        summary: "Rename note.txt",
        occurredAtUnixMs: 20,
        payload: {
          cwd: "/workspace",
          changes: [
            {
              path: "/workspace/new-name.txt",
              oldPath: "/workspace/note.txt",
              type: "move"
            }
          ]
        }
      }
    ]);

    const rows = projectAgentTurnSummaryRowForTurn(
      sourceTurn,
      {
        files: [{ path: "/workspace/new-name.txt", change: "modified" }]
      },
      { workspaceRoot: "/workspace", defaultCwd: "/workspace" }
    );

    expect(rows[0]?.patchBatches).toBeUndefined();
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
