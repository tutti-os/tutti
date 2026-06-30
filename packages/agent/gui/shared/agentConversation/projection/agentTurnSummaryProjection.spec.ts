import { describe, expect, it } from "vitest";
import type {
  WorkspaceAgentActivitySession,
  WorkspaceAgentActivityTimelineItem
} from "../../workspaceAgentActivityTypes";
import type { WorkspaceAgentActivityCard } from "../../workspaceAgentActivityListViewModel";
import type {
  WorkspaceAgentSessionDetailTurn,
  WorkspaceAgentSessionDetailViewModel
} from "../../workspaceAgentSessionDetailViewModel";
import { buildWorkspaceAgentSessionDetailViewModel } from "../../workspaceAgentSessionDetailViewModel";
import {
  projectAgentTurnSummaryRowForTurn,
  projectAgentTurnSummaryRows
} from "./agentTurnSummaryProjection";

describe("projectAgentTurnSummaryRowForTurn", () => {
  it("extracts per-file diff and created-file content from tool payloads", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-1",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:edit-1",
            name: "Edit file",
            toolName: "Edit",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Updated src/app.ts",
            occurredAtUnixMs: 10,
            payload: {
              input: {
                file_path: "/workspace/src/app.ts",
                old_string: "const ready = false",
                new_string: "const ready = true"
              },
              output: {
                patch: "@@ -1 +1 @@\n-const ready = false\n+const ready = true"
              }
            }
          },
          {
            id: "call:write-1",
            name: "Write file",
            toolName: "Write",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Created src/routes.ts",
            occurredAtUnixMs: 12,
            payload: {
              input: {
                file_path: "/workspace/src/routes.ts",
                content: "export const routes = []"
              }
            }
          }
        ],
        toolCallCount: 2,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileCount: 2,
      modifiedCount: 1,
      createdCount: 1
    });
    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/src/app.ts",
        fileName: "app.ts",
        changeType: "modified",
        toolName: "Edit",
        unifiedDiff: "@@ -1 +1 @@\n-const ready = false\n+const ready = true"
      }),
      expect.objectContaining({
        path: "/workspace/src/routes.ts",
        fileName: "routes.ts",
        changeType: "created",
        toolName: "Write",
        content: "export const routes = []"
      })
    ]);
  });

  it("extracts Codex array-style Edit changes for summary rows", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-codex-array-edit",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:edit-array",
            name: "Edit files",
            toolName: "Edit",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Edited slide deck",
            occurredAtUnixMs: 14,
            payload: {
              input: {
                file_path: "/workspace/deck/assets/styles.css",
                changes: [
                  {
                    path: "/workspace/deck/slides/02-why-now.html",
                    kind: { type: "add" },
                    diff: "<section>Why now</section>\n"
                  },
                  {
                    path: "/workspace/deck/slides/01-cover.html",
                    kind: { type: "update" },
                    diff: "@@ -1 +1 @@\n-Old\n+New\n"
                  }
                ]
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileCount: 2,
      modifiedCount: 1,
      createdCount: 1
    });
    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/deck/slides/02-why-now.html",
        fileName: "02-why-now.html",
        changeType: "created",
        toolName: "Edit"
      }),
      expect.objectContaining({
        path: "/workspace/deck/slides/01-cover.html",
        fileName: "01-cover.html",
        changeType: "modified",
        toolName: "Edit"
      })
    ]);
  });

  it("summarizes Codex delete-add replacements as modified files", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-codex-replace",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:delete-index",
            name: "Edit file",
            toolName: "Edit",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Deleted index.html",
            occurredAtUnixMs: 14,
            payload: {
              input: {
                changes: [
                  {
                    path: "/workspace/game/index.html",
                    kind: { type: "delete" },
                    diff: "<!doctype html>\n<title>Old</title>\n"
                  },
                  {
                    path: "/workspace/game/stale.css",
                    kind: { type: "update" },
                    diff: "@@ -1 +1 @@\n-body{}\n+body{color:red}\n"
                  }
                ]
              }
            }
          },
          {
            id: "call:add-index",
            name: "Edit file",
            toolName: "Edit",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Created index.html",
            occurredAtUnixMs: 15,
            payload: {
              input: {
                changes: [
                  {
                    path: "/workspace/game/index.html",
                    kind: { type: "add" },
                    diff: "<!doctype html>\n<title>Snake</title>\n"
                  },
                  {
                    path: "/workspace/game/stale.css",
                    kind: { type: "delete" },
                    diff: "body{color:red}\n"
                  }
                ]
              }
            }
          }
        ],
        toolCallCount: 2,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileCount: 2,
      modifiedCount: 2,
      createdCount: 0
    });
    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/game/index.html",
        changeType: "modified",
        oldString: "<!doctype html>\n<title>Old</title>",
        newString: "<!doctype html>\n<title>Snake</title>",
        unifiedDiff: null
      }),
      expect.objectContaining({
        path: "/workspace/game/stale.css",
        changeType: "deleted",
        unifiedDiff: "body{color:red}"
      })
    ]);
  });

  it("preserves executable patch batches without deduping repeated paths", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-repeat-patch",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:first-edit",
            name: "Edit files",
            toolName: "Edit",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "First edit",
            occurredAtUnixMs: 14,
            payload: {
              input: {
                cwd: "/workspace/project",
                changes: [
                  {
                    path: "/workspace/project/src/app.ts",
                    kind: { type: "update" },
                    diff: "@@ -1 +1 @@\n-old\n+middle\n"
                  }
                ]
              }
            }
          },
          {
            id: "call:second-edit",
            name: "Edit files again",
            toolName: "Edit",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Second edit",
            occurredAtUnixMs: 15,
            payload: {
              input: {
                cwd: "/workspace/project",
                changes: [
                  {
                    path: "/workspace/project/src/app.ts",
                    kind: { type: "update" },
                    diff: "@@ -1 +1 @@\n-middle\n+new\n"
                  }
                ]
              }
            }
          }
        ],
        toolCallCount: 2,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.files).toHaveLength(1);
    expect(rows[0]?.patchBatches).toEqual([
      expect.objectContaining({
        cwd: "/workspace/project",
        toolCallId: "call:first-edit",
        changes: [
          expect.objectContaining({
            path: "/workspace/project/src/app.ts",
            unifiedDiff: "@@ -1 +1 @@\n-old\n+middle"
          })
        ]
      }),
      expect.objectContaining({
        cwd: "/workspace/project",
        toolCallId: "call:second-edit",
        changes: [
          expect.objectContaining({
            path: "/workspace/project/src/app.ts",
            unifiedDiff: "@@ -1 +1 @@\n-middle\n+new"
          })
        ]
      })
    ]);
  });

  it("preserves literal whitespace in executable patch batch content", () => {
    const content = "\n  indented value  \n\n";
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-whitespace-patch",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:write-whitespace",
            name: "Write file",
            toolName: "Write",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Created whitespace file",
            occurredAtUnixMs: 16,
            payload: {
              input: {
                cwd: "/workspace/project",
                changes: {
                  "/workspace/project/src/whitespace.txt": {
                    type: "add",
                    content
                  }
                }
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows[0]?.files[0]).toEqual(
      expect.objectContaining({
        content,
        newString: content
      })
    );
    expect(rows[0]?.patchBatches?.[0]?.changes[0]).toEqual(
      expect.objectContaining({
        content,
        newString: content,
        oldString: ""
      })
    );
  });

  it("extracts nested task step file changes for durable reopen summaries", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-2",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:task-1",
            name: "Task",
            toolName: "Task",
            callType: "subagent",
            status: "Completed",
            statusKind: "completed",
            summary: "Delegated change",
            occurredAtUnixMs: 20,
            payload: {
              metadata: {
                steps: [
                  {
                    toolUseId: "step-1",
                    toolName: "Write",
                    toolInput: {
                      file_path: "/workspace/docs/spec.md",
                      content: "# renderer parity"
                    }
                  }
                ]
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/docs/spec.md",
        changeType: "created",
        content: "# renderer parity"
      })
    ]);
  });

  it("aligns payload step patch batches with nested file extraction", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-payload-steps",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:task-payload-steps",
            name: "Task",
            toolName: "Task",
            callType: "subagent",
            status: "Completed",
            statusKind: "completed",
            summary: "Delegated change",
            occurredAtUnixMs: 21,
            payload: {
              steps: [
                {
                  id: "step-ok",
                  status: "completed",
                  toolName: "Write",
                  toolInput: {
                    cwd: "/workspace/project",
                    changes: {
                      "/workspace/project/docs/ok.md": {
                        type: "add",
                        content: "ok\n"
                      }
                    }
                  }
                },
                {
                  id: "step-failed",
                  status: "failed",
                  toolName: "Write",
                  toolInput: {
                    cwd: "/workspace/project",
                    changes: {
                      "/workspace/project/docs/failed.md": {
                        type: "add",
                        content: "failed\n"
                      }
                    }
                  }
                }
              ]
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/project/docs/ok.md",
        changeType: "created"
      })
    ]);
    expect(rows[0]?.patchBatches).toEqual([
      expect.objectContaining({
        cwd: "/workspace/project",
        toolCallId: "step-ok",
        changes: [
          expect.objectContaining({
            path: "/workspace/project/docs/ok.md",
            content: "ok\n"
          })
        ]
      })
    ]);
  });

  it("extracts local Tutti workspace paths when workspaceRoot is known", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-local-workspace",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:edit-local",
            name: "Edit local files",
            toolName: "Edit",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Edited local files",
            occurredAtUnixMs: 22,
            payload: {
              fileChanges: {
                files: [
                  { path: "src/app.ts", change: "modified" },
                  {
                    path: "/Users/example/tsh-project/tutti/src/routes.ts",
                    change: "added"
                  },
                  { path: "/tmp/outside.txt", change: "added" }
                ]
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/Users/example/tsh-project/tutti" }
    );

    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "src/app.ts",
        label: "app.ts"
      }),
      expect.objectContaining({
        path: "/Users/example/tsh-project/tutti/src/routes.ts",
        label: "routes.ts",
        changeType: "created"
      }),
      expect.objectContaining({
        path: "/tmp/outside.txt",
        label: "outside.txt",
        changeType: "created"
      })
    ]);
  });

  it("ignores structured payload strings in file change metadata paths", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-structured-metadata",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:write-structured",
            name: "Write file",
            toolName: "Write",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Write files",
            occurredAtUnixMs: 25,
            payload: {
              fileChanges: {
                files: [
                  {
                    path: '{"oldStart":1,"lines":["+not a path"]}',
                    change: "added"
                  },
                  { path: "/workspace/docs/spec.md", change: "added" }
                ]
              },
              input: {
                content: "# renderer parity"
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/docs/spec.md",
        changeType: "created"
      })
    ]);
  });

  it("extracts created edit-file content from ACP diff blocks without a unified patch", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-3",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:edit-add-1",
            name: "Edit /workspace/today.txt",
            toolName: "Edit",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Created today.txt",
            occurredAtUnixMs: 30,
            payload: {
              input: {
                file_path: "/workspace/today.txt",
                changes: {
                  "/workspace/today.txt": {
                    type: "add",
                    content: "2026-05-19\n"
                  }
                }
              },
              output: {
                filePath: "/workspace/today.txt",
                newString: "2026-05-19",
                content: [
                  {
                    type: "diff",
                    path: "/workspace/today.txt",
                    newText: "2026-05-19\n"
                  }
                ],
                changes: {
                  "/workspace/today.txt": {
                    type: "add",
                    content: "2026-05-19\n"
                  }
                }
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileCount: 1,
      modifiedCount: 0,
      createdCount: 1
    });
    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/today.txt",
        changeType: "created",
        content: "2026-05-19\n",
        newString: "2026-05-19\n"
      })
    ]);
  });

  it("extracts Claude Code write-file changes from ACP-style input locations and content", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-4",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:write-acp-1",
            name: "Write today.txt",
            toolName: "Write",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Write today.txt",
            occurredAtUnixMs: 40,
            payload: {
              input: {
                kind: "write",
                locations: [{ path: "/workspace/today.txt" }],
                content: [
                  {
                    type: "diff",
                    path: "/workspace/today.txt",
                    newText: "2026-05-22\n"
                  }
                ],
                rawInput: {
                  content: "2026-05-22\n"
                }
              },
              output: {
                rawOutput: {
                  success: true
                }
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/today.txt",
        changeType: "created",
        content: "2026-05-22\n",
        newString: "2026-05-22\n"
      })
    ]);
  });

  it("ignores failed write path fallback and keeps successful structured Bash write changes", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-structured-bash-write",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:write-failed",
            name: "Write file",
            toolName: "Write",
            callType: "tool",
            status: "Failed",
            statusKind: "failed",
            summary: "Failed to write current_time.txt",
            occurredAtUnixMs: 50,
            payload: {
              input: {
                file_path: "/workspace/current_time.txt"
              },
              output: {
                error:
                  "EPERM: operation not permitted, open '/workspace/current_time.txt'"
              }
            }
          },
          {
            id: "call:bash-write",
            name: "执行命令",
            toolName: "Bash",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "python - <<'PY' ...",
            occurredAtUnixMs: 51,
            payload: {
              activityKind: "write_file",
              fileChangeKind: "add",
              paths: ["/workspace/current_time.txt"],
              input: {
                rawInput: {
                  command: "python - <<'PY' ..."
                }
              }
            }
          }
        ],
        toolCallCount: 2,
        hasFailedToolCall: true,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/current_time.txt",
        changeType: "created",
        toolName: "Bash"
      })
    ]);
  });

  it("ignores failed file-change metadata in turn summaries only", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-failed-file-change-metadata",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:write-failed-filechanges",
            name: "Write file",
            toolName: "Write",
            callType: "tool",
            status: "Failed",
            statusKind: "failed",
            summary: "Failed to write report.md",
            occurredAtUnixMs: 52,
            payload: {
              fileChanges: {
                files: [{ path: "/workspace/report.md", change: "added" }]
              },
              input: {
                content: "# report"
              }
            }
          },
          {
            id: "call:edit-failed-changes",
            name: "Edit file",
            toolName: "Edit",
            callType: "tool",
            status: "Failed",
            statusKind: "failed",
            summary: "Failed to edit app.ts",
            occurredAtUnixMs: 53,
            payload: {
              output: {
                changes: {
                  "/workspace/src/app.ts": {
                    type: "modify",
                    oldString: "const ready = false",
                    newString: "const ready = true"
                  }
                },
                content: [
                  {
                    type: "diff",
                    path: "/workspace/src/app.ts",
                    oldText: "const ready = false",
                    newText: "const ready = true"
                  }
                ]
              }
            }
          }
        ],
        toolCallCount: 2,
        hasFailedToolCall: true,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows).toEqual([]);
  });
});

describe("projectAgentTurnSummaryRows", () => {
  it("does not collect statusless errored tool calls into turn summaries", () => {
    const detail = buildWorkspaceAgentSessionDetailViewModel({
      activity: {
        id: "activity-session-errored-call",
        sessionId: "session-errored-call",
        userId: "user-a",
        userName: "Jessica",
        agentProvider: "codex",
        agentName: "Codex",
        title: "Write a file",
        status: "failed",
        latestActivitySummary: "Failed",
        changedFiles: [],
        sortTimeUnixMs: 1_000
      } satisfies WorkspaceAgentActivityCard,
      session: {
        id: 1,
        agentSessionId: "session-errored-call",
        presenceId: 1,
        provider: "codex",
        providerSessionId: "provider-1",
        cwd: "/repo",
        status: "failed",
        title: "Write a file"
      } satisfies WorkspaceAgentActivitySession,
      workspaceRoot: "/repo",
      timelineItems: [
        {
          id: 1,
          workspaceId: "workspace-1",
          agentSessionId: "session-errored-call",
          eventId: "message-user-1",
          actorType: "user",
          actorId: "user-a",
          itemType: "message.user",
          role: "user",
          turnId: "turn-1",
          content: "Create note.txt"
        },
        {
          id: 2,
          workspaceId: "workspace-1",
          agentSessionId: "session-errored-call",
          eventId: "call-write-errored",
          actorType: "agent",
          actorId: "codex",
          itemType: "call.errored",
          callType: "tool",
          callId: "write-1",
          name: "Write",
          turnId: "turn-1",
          payload: {
            toolName: "Write",
            input: {
              file_path: "/repo/note.txt",
              content: "hello"
            },
            error: {
              message: "permission denied"
            }
          }
        }
      ] satisfies WorkspaceAgentActivityTimelineItem[]
    });

    expect(detail.turns[0]?.toolCalls[0]?.statusKind).toBe("failed");
    expect(projectAgentTurnSummaryRows(detail)).toEqual([]);
  });

  it("ignores structured payload strings from activity changed files fallback", () => {
    const rows = projectAgentTurnSummaryRows({
      activity: {
        id: "activity-session-1",
        sessionId: "session-1",
        userId: "user-a",
        userName: "Jessica",
        agentProvider: "gemini",
        agentName: "Gemini",
        title: "Completed session",
        status: "completed",
        latestActivitySummary: "Completed",
        changedFiles: [
          {
            path: '{"oldStart":1,"lines":["+not a path"]}',
            label: '{"oldStart":1,"lines":["+not a path"]}'
          },
          { path: "/repo/docs/spec.md", label: "/repo/docs/spec.md" }
        ],
        sortTimeUnixMs: 1_000
      },
      session: {
        id: 1,
        agentSessionId: "session-1",
        presenceId: 1,
        provider: "gemini",
        providerSessionId: "provider-1",
        cwd: "/repo",
        status: "completed",
        updatedAtUnixMs: 1_000
      },
      cwd: "/repo",
      workspaceRoot: "/repo",
      turns: []
    } satisfies WorkspaceAgentSessionDetailViewModel);

    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/repo/docs/spec.md",
        label: "spec.md"
      })
    ]);
  });

  it("projects apply_patch delete change-map content as removed file text", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-delete-file",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:delete-file",
            name: "apply_patch",
            toolName: "apply_patch",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Deleted a.md",
            occurredAtUnixMs: 70,
            payload: {
              output: {
                changes: {
                  "/workspace/a.md": {
                    type: "delete",
                    content: "aaaaa\n"
                  }
                }
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileCount: 1,
      modifiedCount: 1,
      createdCount: 0
    });
    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/a.md",
        changeType: "deleted",
        content: null,
        oldString: "aaaaa\n",
        newString: ""
      })
    ]);
  });

  it("projects apply_patch delete patch text when no explicit path is present", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-delete-patch",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:delete-patch",
            name: "apply_patch",
            toolName: "apply_patch",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Deleted a.md",
            occurredAtUnixMs: 72,
            payload: {
              output: {
                patch:
                  "*** Begin Patch\n*** Delete File: a.md\n@@\n-aaaaa\n*** End Patch\n"
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "a.md",
        changeType: "deleted",
        unifiedDiff:
          "*** Begin Patch\n*** Delete File: a.md\n@@\n-aaaaa\n*** End Patch"
      })
    ]);
  });

  it("filters paths that cannot resolve to workspace file links", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-non-workspace-filter",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:edit-filter",
            name: "Edit generated file",
            toolName: "Edit",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Edited generated file",
            occurredAtUnixMs: 60,
            payload: {
              fileChanges: {
                files: [
                  { path: "/dev/null", change: "added" },
                  { path: "/tmp/outside.txt", change: "added" },
                  { path: "ppt_news/generate_news_ppt.py", change: "added" },
                  {
                    path: "/workspace/output/imagegen/dancing-girl.png",
                    change: "added"
                  }
                ]
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/tmp/outside.txt",
        label: "outside.txt"
      }),
      expect.objectContaining({
        path: "ppt_news/generate_news_ppt.py",
        label: "generate_news_ppt.py"
      }),
      expect.objectContaining({
        path: "/workspace/output/imagegen/dancing-girl.png",
        label: "dancing-girl.png"
      })
    ]);
  });

  it("uses the shortest unique suffix for duplicate file names in summary rows", () => {
    const rows = projectAgentTurnSummaryRowForTurn(
      {
        id: "turn-duplicate-names",
        userMessage: null,
        userMessages: [],
        agentMessages: [],
        toolCalls: [
          {
            id: "call:edit-duplicate-names",
            name: "Edit generated files",
            toolName: "Edit",
            callType: "tool",
            status: "Completed",
            statusKind: "completed",
            summary: "Edited generated files",
            occurredAtUnixMs: 60,
            payload: {
              fileChanges: {
                files: [
                  { path: "/workspace/ppt_news/index.html", change: "added" },
                  { path: "/workspace/todo-app/index.html", change: "added" },
                  {
                    path: "/workspace/yesterday_news_2026-05-26.txt",
                    change: "added"
                  }
                ]
              }
            }
          }
        ],
        toolCallCount: 1,
        hasFailedToolCall: false,
        agentItems: []
      } satisfies WorkspaceAgentSessionDetailTurn,
      { workspaceRoot: "/workspace" }
    );

    expect(rows[0]?.files).toEqual([
      expect.objectContaining({
        path: "/workspace/ppt_news/index.html",
        label: "ppt_news/index.html"
      }),
      expect.objectContaining({
        path: "/workspace/todo-app/index.html",
        label: "todo-app/index.html"
      }),
      expect.objectContaining({
        path: "/workspace/yesterday_news_2026-05-26.txt",
        label: "yesterday_news_2026-05-26.txt"
      })
    ]);
  });
});
