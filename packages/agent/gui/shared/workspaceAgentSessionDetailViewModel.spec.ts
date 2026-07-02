import type {
  AgentHostWorkspaceAgentSession,
  AgentHostWorkspaceAgentTimelineItem
} from "./contracts/dto";
import { afterEach, describe, expect, it } from "vitest";
import { setAgentGuiI18nTestLocale } from "../i18n/testUtils";
import type { WorkspaceAgentActivityCard } from "./workspaceAgentActivityListViewModel";
import { buildWorkspaceAgentSessionDetailViewModel } from "./workspaceAgentSessionDetailViewModel";

function item(
  overrides: Partial<AgentHostWorkspaceAgentTimelineItem> & { id: number }
): AgentHostWorkspaceAgentTimelineItem {
  const { id, ...rest } = overrides;
  return {
    id,
    workspaceId: "room-1",
    agentSessionId: "session-1",
    eventId: rest.eventId ?? `event-${id}`,
    actorType: rest.actorType ?? "agent",
    actorId: rest.actorId ?? "actor-1",
    itemType: rest.itemType ?? "message",
    ...rest
  };
}

const activity: WorkspaceAgentActivityCard = {
  id: "activity-session-1",
  sessionId: "session-1",
  userId: "user-1",
  userName: "Jessica",
  userAvatarUrl: "https://cdn.example.com/jessica.png",
  agentProvider: "codex",
  agentName: "Codex",
  title: "帮我根据目前工作区的信息出原型",
  status: "working",
  latestActivitySummary: "正在整理信息",
  changedFiles: [],
  sortTimeUnixMs: 10
};

const session: AgentHostWorkspaceAgentSession = {
  id: 1,
  agentSessionId: "session-1",
  presenceId: 1,
  provider: "codex",
  providerSessionId: "provider-session-1",
  cwd: "/workspace/app",
  effectiveStatus: "working",
  title: activity.title
};

describe("buildWorkspaceAgentSessionDetailViewModel", () => {
  afterEach(async () => {
    setAgentGuiI18nTestLocale("zh-CN");
  });

  it("groups user, agent messages, and tool calls by turnId in timeline order", async () => {
    setAgentGuiI18nTestLocale("en");

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 1,
          turnId: "turn-1",
          itemType: "message",
          role: "user",
          content: "请基于 README.md 出一个页面"
        }),
        item({
          id: 2,
          turnId: "turn-1",
          itemType: "call.tool",
          name: "read_file",
          status: "completed",
          payload: { summary: "Read README.md" }
        }),
        item({
          id: 3,
          turnId: "turn-1",
          itemType: "message",
          role: "assistant",
          payload: { content: "已读取 [README.md](README.md)，准备设计。" }
        }),
        item({
          id: 4,
          turnId: "turn-2",
          itemType: "message.user",
          payload: { text: "整体更简约一点" }
        }),
        item({
          id: 5,
          turnId: "turn-2",
          itemType: "call",
          name: "edit_file",
          status: "failed",
          payload: { text: "Update src/App.tsx" }
        }),
        item({
          id: 6,
          turnId: "turn-2",
          itemType: "message.agent",
          content: "我会收敛视觉，并保留 http://127.0.0.1:8765/"
        })
      ],
      workspaceRoot: "/workspace"
    });

    expect(view.activity).toBe(activity);
    expect(view.cwd).toBe("/workspace/app");
    expect(view.workspaceRoot).toBe("/workspace");
    expect(view.turns).toHaveLength(2);
    expect(view.turns[0]).toMatchObject({
      id: "turn-1",
      toolCallCount: 1,
      hasFailedToolCall: false,
      toolCalls: [
        {
          id: "event-2",
          name: "Read file",
          status: "Completed",
          summary: "Read README.md",
          toolName: "Read"
        }
      ],
      userMessage: { body: "请基于 README.md 出一个页面" },
      userMessages: [{ body: "请基于 README.md 出一个页面" }],
      agentMessages: [{ body: "已读取 [README.md](README.md)，准备设计。" }]
    });
    expect(view.turns[1]).toMatchObject({
      id: "turn-2",
      toolCallCount: 1,
      hasFailedToolCall: true,
      toolCalls: [
        {
          id: "event-5",
          name: "Edit file",
          status: "Failed",
          summary: "Update src/App.tsx",
          toolName: "Edit"
        }
      ],
      userMessage: { body: "整体更简约一点" },
      userMessages: [{ body: "整体更简约一点" }],
      agentMessages: [{ body: "我会收敛视觉，并保留 http://127.0.0.1:8765/" }]
    });
  });

  it("falls back to item identity grouping and ignores blank message bodies", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({ id: 10, itemType: "message", role: "assistant", content: "  " }),
        item({ id: 11, itemType: "message.user", content: "第一轮问题" }),
        item({ id: 12, itemType: "call.tool", status: "completed" }),
        item({ id: 13, itemType: "message.assistant", content: "第一轮回答" }),
        item({ id: 14, itemType: "message.user", content: "第二轮问题" }),
        item({ id: 15, itemType: "message.agent", content: "第二轮回答" })
      ]
    });

    expect(view.turns).toHaveLength(2);
    expect(view.turns[0]?.userMessage?.body).toBe("第一轮问题");
    expect(view.turns[0]?.agentMessages.map((message) => message.body)).toEqual(
      ["第一轮回答"]
    );
    expect(view.turns[0]?.toolCallCount).toBe(1);
    expect(view.turns[1]?.userMessage?.body).toBe("第二轮问题");
    expect(view.turns[1]?.agentMessages.map((message) => message.body)).toEqual(
      ["第二轮回答"]
    );
  });

  it("renders known tool calls as localized type labels and key details", async () => {
    setAgentGuiI18nTestLocale("en");

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 20,
          itemType: "message.user",
          content: "检查项目结构"
        }),
        item({
          id: 21,
          itemType: "call.tool",
          name: "exec_command",
          status: "running",
          payload: {
            toolName: "Bash",
            input: {
              cmd: 'pwd && rg --files -g "!node_modules"'
            }
          }
        }),
        item({
          id: 22,
          itemType: "call.tool",
          name: "web_search",
          status: "completed",
          payload: {
            toolName: "WebSearch",
            input: {
              query: "opencode architecture"
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "event-21",
        name: "Run command",
        toolName: "Bash",
        callType: null,
        status: "Running",
        statusKind: "working",
        summary: 'pwd && rg --files -g "!node_modules"'
      }),
      expect.objectContaining({
        id: "event-22",
        name: "Search web",
        toolName: "WebSearch",
        callType: null,
        status: "Completed",
        statusKind: "completed",
        summary: "opencode architecture"
      })
    ]);
  });

  it("recognizes opaque image generation tool aliases from canonical content blocks", async () => {
    setAgentGuiI18nTestLocale("en");

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 30,
          turnId: "turn-image",
          itemType: "message.user",
          content: "帮我生成一个跳舞小女孩的图片"
        }),
        item({
          id: 31,
          turnId: "turn-image",
          itemType: "call.completed",
          name: "ig_05eb62dbe723c910016a1336ad3de881919216a6f64051a5e2",
          status: "completed",
          payload: {
            toolName: "ig_05eb62dbe723c910016a1336ad3de881919216a6f64051a5e2",
            callType: "tool",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Revised prompt: a joyful little girl dancing"
                }
              },
              {
                type: "content",
                content: {
                  type: "image",
                  uri: "/workspace/output/generated.png",
                  mimeType: "image/png"
                }
              }
            ]
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls[0]).toMatchObject({
      toolName: "ImageGeneration",
      name: "Image Generation"
    });
  });

  it("merges background terminal write_stdin output back into the originating bash tool call", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 200,
          turnId: "turn-bg",
          itemType: "message.user",
          content: "看看有什么文件"
        }),
        item({
          id: 201,
          turnId: "turn-bg",
          itemType: "call.completed",
          callId: "call-bash",
          status: "completed",
          payload: {
            toolName: "Bash",
            callID: "call-bash",
            input: {
              cmd: "ls -la"
            },
            output: {
              output:
                "Chunk ID: abc123\nProcess running with session ID 51893\n"
            }
          }
        }),
        item({
          id: 202,
          turnId: "turn-bg",
          itemType: "message.assistant_thinking",
          content: "Waiting for the background terminal."
        }),
        item({
          id: 203,
          turnId: "turn-bg",
          itemType: "call.completed",
          callId: "call-write-stdin",
          status: "completed",
          payload: {
            toolName: "write_stdin",
            callID: "call-write-stdin",
            input: {
              chars: "",
              session_id: "51893"
            },
            output: {
              output: "Chunk ID: out123\nOutput:\ntotal 1\ntoday_time.txt\n"
            }
          }
        })
      ]
    });

    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.toolCalls).toHaveLength(1);
    expect(view.turns[0]?.toolCalls[0]).toMatchObject({
      id: "call:call-bash",
      toolName: "Bash",
      statusKind: "completed",
      payload: {
        output: {
          output: "Chunk ID: out123\nOutput:\ntotal 1\ntoday_time.txt\n"
        }
      }
    });
    expect(view.turns[0]?.agentItems).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({
          kind: "tool-calls",
          toolCalls: expect.arrayContaining([
            expect.objectContaining({
              id: "call:call-write-stdin"
            })
          ])
        })
      ])
    );
  });

  it("prefers canonical payload tool names over display titles for ACP fetch calls", async () => {
    setAgentGuiI18nTestLocale("en");

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 26,
          turnId: "turn-web",
          itemType: "call.completed",
          name: "Searching the Web",
          callType: "tool",
          status: "completed",
          payload: {
            toolName: "WebSearch",
            kind: "fetch",
            input: {
              action: {
                type: "search",
                query: "today top news"
              },
              query: "today top news"
            }
          }
        }),
        item({
          id: 27,
          turnId: "turn-web",
          itemType: "call.completed",
          name: "Searching the Web",
          callType: "tool",
          status: "completed",
          payload: {
            toolName: "WebFetch",
            kind: "fetch",
            input: {
              action: {
                type: "open_page",
                url: "https://example.com/news"
              },
              query: "https://example.com/news"
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        name: "Search web",
        toolName: "WebSearch",
        summary: "today top news"
      }),
      expect.objectContaining({
        name: "Read web page",
        toolName: "WebFetch",
        summary: "example.com"
      })
    ]);
  });

  it("builds compact summaries for multi-file edits, web fetch domains, and todo progress", async () => {
    setAgentGuiI18nTestLocale("en");

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 28,
          turnId: "turn-summary",
          itemType: "call.tool",
          status: "completed",
          payload: {
            toolName: "Write",
            output: {
              structuredPatch: [
                { filePath: "src/app.ts", kind: "add" },
                { filePath: "src/routes.ts", kind: "add" }
              ]
            }
          }
        }),
        item({
          id: 29,
          turnId: "turn-summary",
          itemType: "call.tool",
          status: "completed",
          payload: {
            toolName: "WebFetch",
            input: {
              url: "https://docs.example.com/renderer"
            }
          }
        }),
        item({
          id: 30,
          turnId: "turn-summary",
          itemType: "call.tool",
          status: "completed",
          payload: {
            toolName: "TodoWrite",
            input: {
              todos: [
                { content: "A", status: "completed" },
                { content: "B", status: "pending" },
                { content: "C", status: "pending" }
              ]
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls.map((call) => call.summary)).toEqual([
      "2 files",
      "docs.example.com",
      "1/3 completed"
    ]);
  });

  it("builds compact summaries for Codex Edit changes arrays", async () => {
    setAgentGuiI18nTestLocale("en");

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 31,
          turnId: "turn-codex-array-edit",
          itemType: "call.tool",
          status: "completed",
          payload: {
            toolName: "Edit",
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
        })
      ]
    });

    expect(view.turns[0]?.toolCalls[0]?.summary).toBe("2 files");
  });

  it("keeps durable approval items in the transcript as specialized tool calls", async () => {
    setAgentGuiI18nTestLocale("en");

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 30,
          seq: 30,
          turnId: "turn-approval",
          itemType: "message.user",
          content: "继续执行前先问我"
        }),
        item({
          id: 31,
          seq: 31,
          turnId: "turn-approval",
          itemType: "approval.requested",
          name: "Need approval",
          callType: "approval",
          status: "awaiting_approval",
          payload: {
            callType: "approval",
            input: {
              options: [
                { id: "allow_once", label: "Allow once" },
                { id: "deny", label: "Deny" }
              ]
            }
          }
        })
      ]
    });

    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "event-31",
        name: "Need approval",
        callType: "approval",
        status: "Waiting",
        statusKind: "waiting"
      })
    ]);
    expect(view.turns[0]?.agentItems).toContainEqual(
      expect.objectContaining({
        kind: "tool-calls",
        toolCallCount: 1,
        toolCalls: [
          expect.objectContaining({
            id: "event-31",
            callType: "approval"
          })
        ]
      })
    );
  });

  it("preserves readable tool call details for second-level expansion", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 24,
          itemType: "message.user",
          content: "检查项目结构"
        }),
        item({
          id: 25,
          itemType: "call.tool",
          name: "exec_command",
          status: "completed",
          payload: {
            toolName: "Bash",
            input: {
              cmd: 'pwd && rg --files -g "!node_modules"'
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls[0]).toMatchObject({
      name: "执行命令",
      status: "已完成",
      summary: 'pwd && rg --files -g "!node_modules"'
    });
  });

  it("shows the tool action without structured output or error payloads", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 26,
          itemType: "message.user",
          content: "运行测试"
        }),
        item({
          id: 27,
          itemType: "call.tool",
          name: "exec_command",
          status: "failed",
          payload: {
            input: { cmd: "pnpm test" },
            output: { stdout: "1 failed" },
            error: { message: "exit code 1" }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls[0]?.summary).toBe("pnpm test");
  });

  it("preserves raw tool payload and call metadata for specialized renderers", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 40,
          seq: 40,
          turnId: "turn-plan",
          itemType: "message.user",
          content: "给我一个实施计划"
        }),
        item({
          id: 41,
          seq: 41,
          turnId: "turn-plan",
          itemType: "call",
          callType: "interactive",
          name: "ExitPlanMode",
          status: "completed",
          payload: {
            input: {
              plan: "# Plan\n\n- Inspect current renderer\n- Add specialized cards"
            },
            tool_state: {
              call_type: "interactive",
              name: "ExitPlanMode",
              input: {
                plan: "# Plan\n\n- Inspect current renderer\n- Add specialized cards"
              }
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls[0]).toMatchObject({
      toolName: "ExitPlanMode",
      callType: "interactive",
      payload: expect.objectContaining({
        input: expect.objectContaining({
          plan: "# Plan\n\n- Inspect current renderer\n- Add specialized cards"
        })
      })
    });
  });

  it("maps waiting_input interactive calls to waiting status for transcript rendering", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 40,
          seq: 40,
          turnId: "turn-plan",
          itemType: "message.user",
          content: "给我一个实施计划"
        }),
        item({
          id: 41,
          seq: 41,
          turnId: "turn-plan",
          itemType: "call.started",
          callType: "interactive",
          name: "AskUserQuestion",
          status: "waiting_input",
          payload: {
            input: {
              questions: [{ id: "scope", question: "Which scope?" }]
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls[0]).toMatchObject({
      toolName: "AskUserQuestion",
      callType: "interactive",
      statusKind: "waiting"
    });
  });

  it("keeps executable Claude AskUserQuestion prompts in the transcript detail view", () => {
    const claudeSession: AgentHostWorkspaceAgentSession = {
      ...session,
      provider: "claude-code"
    };

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity: {
        ...activity,
        agentProvider: "claude-code",
        agentName: "Claude Code"
      },
      session: claudeSession,
      timelineItems: [
        item({
          id: 42,
          seq: 42,
          turnId: "turn-claude-ask",
          itemType: "message.user",
          content: "验证 AskUserQuestion"
        }),
        item({
          id: 43,
          seq: 43,
          turnId: "turn-claude-ask",
          itemType: "call.started",
          callId: "call-ask-user",
          callType: "interactive",
          name: "AskUserQuestion",
          status: "waiting_input",
          payload: {
            callId: "call-ask-user",
            toolName: "AskUserQuestion",
            input: {
              requestId: "request-ask-user",
              questions: [{ id: "scope", question: "Which scope?" }]
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls[0]).toMatchObject({
      toolName: "AskUserQuestion",
      callType: "interactive",
      statusKind: "waiting",
      payload: expect.objectContaining({
        input: expect.objectContaining({
          requestId: "request-ask-user"
        })
      })
    });
  });

  it("hides unsupported Claude AskUserQuestion tool calls from the transcript detail view", () => {
    const claudeSession: AgentHostWorkspaceAgentSession = {
      ...session,
      provider: "claude-code"
    };

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity: {
        ...activity,
        agentProvider: "claude-code",
        agentName: "Claude Code"
      },
      session: claudeSession,
      timelineItems: [
        item({
          id: 42,
          seq: 42,
          turnId: "turn-claude-ask",
          itemType: "message.user",
          content: "帮我做一个 todo-list 应用？"
        }),
        item({
          id: 43,
          seq: 43,
          turnId: "turn-claude-ask",
          itemType: "call.started",
          callId: "call-ask-user",
          callType: "interactive",
          name: "AskUserQuestion",
          status: "waiting_input",
          payload: {
            toolName: "AskUserQuestion",
            input: {
              questions: [{ id: "scope", question: "Which scope?" }]
            }
          }
        }),
        item({
          id: 44,
          seq: 44,
          turnId: "turn-claude-ask",
          itemType: "call.errored",
          callId: "call-ask-user",
          callType: "interactive",
          name: "AskUserQuestion",
          status: "failed",
          payload: {
            toolName: "AskUserQuestion",
            input: {
              questions: [{ id: "scope", question: "Which scope?" }]
            },
            output: {
              output:
                "Error: No such tool available: AskUserQuestion. AskUserQuestion exists but is not enabled in this context."
            },
            error: {
              error:
                "Error: No such tool available: AskUserQuestion. AskUserQuestion exists but is not enabled in this context."
            }
          }
        })
      ]
    });

    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.toolCalls).toEqual([]);
    expect(view.turns[0]?.toolCallCount).toBe(0);
    expect(view.turns[0]?.hasFailedToolCall).toBe(false);
  });

  it("renders the actual command from failed Codex exec tool payloads instead of raw error JSON", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 28,
          itemType: "message.user",
          content: "查看 git 状态"
        }),
        item({
          id: 29,
          itemType: "call.tool",
          name: "exec_command",
          status: "failed",
          payload: {
            error: {
              activityKind: "run_command",
              callID: "call-1",
              command: "git status --short",
              exitCode: 128,
              status: "failed",
              tool: "exec_command"
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls[0]?.summary).toBe("git status --short");
  });

  it("keeps distinct Codex calls when legacy top-level callId only contains the tool name", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 30,
          turnId: "turn-codex",
          itemType: "message.user",
          content: "检查仓库"
        }),
        item({
          id: 31,
          turnId: "turn-codex",
          itemType: "call.started",
          callId: "tool.exec_command",
          name: "exec_command",
          status: "running",
          payload: {
            activityKind: "run_command",
            callID: "call-pwd",
            command: "pwd",
            tool: "exec_command"
          }
        }),
        item({
          id: 32,
          turnId: "turn-codex",
          itemType: "call.completed",
          callId: "tool.exec_command",
          name: "exec_command",
          status: "completed",
          payload: {
            activityKind: "run_command",
            callID: "call-pwd",
            command: "pwd",
            tool: "exec_command"
          }
        }),
        item({
          id: 33,
          turnId: "turn-codex",
          itemType: "call.started",
          callId: "tool.exec_command",
          name: "exec_command",
          status: "running",
          payload: {
            activityKind: "run_command",
            callID: "call-rg",
            command: "rg --files",
            tool: "exec_command"
          }
        }),
        item({
          id: 34,
          turnId: "turn-codex",
          itemType: "call.completed",
          callId: "tool.exec_command",
          name: "exec_command",
          status: "completed",
          payload: {
            activityKind: "run_command",
            callID: "call-rg",
            command: "rg --files",
            tool: "exec_command"
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls.map((call) => call.id)).toEqual([
      "call:call-pwd",
      "call:call-rg"
    ]);
    expect(view.turns[0]?.toolCalls.map((call) => call.summary)).toEqual([
      "pwd",
      "rg --files"
    ]);
  });

  it("renders concise content for file, search, and patch tool calls", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 30,
          itemType: "message.user",
          content: "继续检查和修改文件"
        }),
        item({
          id: 31,
          itemType: "call.tool",
          name: "read_file",
          status: "completed",
          payload: {
            input: { file_path: "src/App.tsx" }
          }
        }),
        item({
          id: 32,
          itemType: "call.tool",
          name: "search_files",
          status: "completed",
          payload: {
            metadata: { activityKind: "search_files", pattern: "useState" }
          }
        }),
        item({
          id: 33,
          itemType: "call.tool",
          name: "web_search",
          status: "completed",
          payload: {
            query: "Codex tool call rendering"
          }
        }),
        item({
          id: 34,
          itemType: "call.tool",
          name: "apply_patch",
          status: "completed",
          payload: {
            input: {
              patch:
                "*** Begin Patch\n*** Update File: README.md\n*** End Patch"
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls.map((call) => call.summary)).toEqual([
      "src/App.tsx",
      "useState",
      "Codex tool call rendering",
      "*** Begin Patch\n*** Update File: README.md\n*** End Patch"
    ]);
  });

  it("keeps distinct user messages across turns even when prompt text repeats", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 20,
          turnId: "turn-1",
          itemType: "message",
          role: "user",
          content: "第一条用户消息",
          occurredAtUnixMs: 1000
        }),
        item({
          id: 21,
          turnId: "turn-1",
          itemType: "message",
          role: "user",
          content: "第二条用户消息",
          occurredAtUnixMs: 1100
        }),
        item({
          id: 22,
          turnId: "turn-from-transcript",
          itemType: "message",
          role: "user",
          content: "第一条用户消息",
          occurredAtUnixMs: 1200
        }),
        item({
          id: 23,
          turnId: "turn-1",
          itemType: "message",
          role: "assistant",
          content: "收到。"
        })
      ]
    });

    expect(view.turns).toHaveLength(2);
    expect(view.turns[0]?.userMessages.map((message) => message.body)).toEqual([
      "第一条用户消息",
      "第二条用户消息"
    ]);
    expect(view.turns[0]?.agentMessages.map((message) => message.body)).toEqual(
      ["收到。"]
    );
    expect(view.turns[1]?.userMessages.map((message) => message.body)).toEqual([
      "第一条用户消息"
    ]);
  });

  it("folds duplicate user prompt projections within the same turn", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 20,
          turnId: "turn-1",
          itemType: "message",
          role: "user",
          content: "重复请求",
          occurredAtUnixMs: 1000
        }),
        item({
          id: 21,
          turnId: "turn-1",
          itemType: "message",
          role: "user",
          content: "重复请求",
          occurredAtUnixMs: 1100
        }),
        item({
          id: 22,
          turnId: "turn-1",
          itemType: "message",
          role: "assistant",
          content: "收到。",
          occurredAtUnixMs: 1200
        })
      ]
    });

    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.userMessages.map((message) => message.body)).toEqual([
      "重复请求"
    ]);
    expect(view.turns[0]?.agentMessages.map((message) => message.body)).toEqual(
      ["收到。"]
    );
  });

  it("does not render Claude synthetic interrupt messages as user transcript rows", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 20,
          turnId: "turn-1",
          itemType: "message",
          role: "user",
          content: "[Request interrupted by user]",
          occurredAtUnixMs: 1000
        }),
        item({
          id: 21,
          turnId: "turn-1",
          itemType: "message",
          role: "user",
          content: "[Request interrupted by user for tool use]",
          occurredAtUnixMs: 1050
        }),
        item({
          id: 23,
          turnId: "turn-1",
          itemType: "message",
          role: "user",
          content: "继续正常请求",
          occurredAtUnixMs: 1100
        }),
        item({
          id: 22,
          turnId: "turn-1",
          itemType: "message",
          role: "assistant",
          content: "收到。",
          occurredAtUnixMs: 1200
        })
      ]
    });

    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.userMessages.map((message) => message.body)).toEqual([
      "继续正常请求"
    ]);
    expect(view.turns[0]?.agentMessages.map((message) => message.body)).toEqual(
      ["收到。"]
    );
  });

  it("keeps agent thinking messages as collapsed agent timeline items", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 30,
          turnId: "turn-1",
          itemType: "message",
          role: "user",
          content: "分析架构"
        }),
        item({
          id: 31,
          turnId: "turn-1",
          itemType: "message",
          role: "assistant_thinking",
          content: "我先检查项目结构和入口文件。"
        }),
        item({
          id: 32,
          turnId: "turn-1",
          itemType: "message",
          role: "assistant",
          content: "已经找到主要模块，继续梳理调用链。"
        })
      ]
    });

    expect(view.turns[0]?.agentMessages.map((message) => message.body)).toEqual(
      ["已经找到主要模块，继续梳理调用链。"]
    );
    expect(view.turns[0]?.agentItems).toEqual([
      {
        kind: "thinking",
        thinking: {
          id: "event-31",
          body: "我先检查项目结构和入口文件。",
          turnId: "turn-1",
          occurredAtUnixMs: null
        }
      },
      {
        kind: "message",
        message: {
          id: "event-32",
          body: "已经找到主要模块，继续梳理调用链。",
          turnId: "turn-1",
          occurredAtUnixMs: null
        }
      }
    ]);
  });

  it("projects assistant thinking timeline status into the detail view model", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 33,
          turnId: "turn-1",
          itemType: "message",
          role: "assistant_thinking",
          status: "streaming",
          content: "我正在确认上下文。"
        })
      ]
    });

    expect(view.turns[0]?.agentItems[0]).toMatchObject({
      kind: "thinking",
      thinking: {
        id: "event-33",
        statusKind: "working"
      }
    });
  });

  it("deduplicates repeated agent thinking messages within a turn", () => {
    const thinkingBody = [
      "**Exploring frontend creation**",
      "",
      "I need to focus on creating a likely frontend for the issue at hand."
    ].join("\n");
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 35,
          turnId: "turn-1",
          itemType: "message",
          role: "user",
          content: "帮我写一个登陆页面"
        }),
        item({
          id: 36,
          turnId: "turn-1",
          itemType: "message",
          role: "assistant_thinking",
          content: thinkingBody
        }),
        item({
          id: 37,
          turnId: "turn-1",
          itemType: "message",
          role: "assistant_thinking",
          content: thinkingBody
        })
      ]
    });

    expect(view.turns[0]?.agentItems).toEqual([
      {
        kind: "thinking",
        thinking: {
          id: "event-36",
          body: thinkingBody,
          turnId: "turn-1",
          occurredAtUnixMs: null
        }
      }
    ]);
  });

  it("keeps a turn when the agent only emits thinking content", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 33,
          turnId: "turn-1",
          itemType: "message.assistant_thinking",
          content: "先确认配置是否已经注入。"
        })
      ]
    });

    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.agentItems).toEqual([
      {
        kind: "thinking",
        thinking: {
          id: "event-33",
          body: "先确认配置是否已经注入。",
          turnId: "turn-1",
          occurredAtUnixMs: null
        }
      }
    ]);
  });

  it("filters placeholder assistant thinking messages rendered as ellipsis", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 34,
          turnId: "turn-1",
          itemType: "message.assistant_thinking",
          role: "assistant_thinking",
          content: "..."
        }),
        item({
          id: 35,
          turnId: "turn-1",
          itemType: "message.assistant",
          role: "assistant",
          content: "继续分析这个 session。"
        })
      ]
    });

    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]?.agentItems).toEqual([
      {
        kind: "message",
        message: {
          id: "event-35",
          body: "继续分析这个 session。",
          turnId: "turn-1",
          occurredAtUnixMs: null
        }
      }
    ]);
  });

  it("keeps assistant messages before tool calls in the agent-side timeline order", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 60,
          turnId: "turn-1",
          itemType: "message.user",
          content: "分析open code 架构设计"
        }),
        item({
          id: 61,
          turnId: "turn-1",
          itemType: "message.assistant",
          role: "assistant",
          payload: {
            text: "我先快速扫一下仓库结构和关键配置，确认这是哪类项目，再基于实际代码做架构分析。"
          }
        }),
        item({
          id: 62,
          turnId: "turn-1",
          itemType: "call.started",
          name: "exec_command",
          status: "running",
          payload: {
            metadata: { activityKind: "search_files" },
            callID: "call-search"
          }
        }),
        item({
          id: 63,
          turnId: "turn-1",
          itemType: "call.completed",
          name: "exec_command",
          status: "completed",
          payload: {
            metadata: { activityKind: "search_files" },
            callID: "call-search"
          }
        }),
        item({
          id: 64,
          turnId: "turn-1",
          itemType: "message.assistant",
          role: "assistant",
          content:
            "本地工作目录是空的，所以我按当前公开的 OpenCode 项目来分析。"
        })
      ]
    });

    expect(view.turns[0]?.agentItems).toEqual([
      {
        kind: "message",
        message: {
          id: "event-61",
          body: "我先快速扫一下仓库结构和关键配置，确认这是哪类项目，再基于实际代码做架构分析。",
          turnId: "turn-1",
          occurredAtUnixMs: null
        }
      },
      {
        kind: "tool-calls",
        id: "tools:event-62",
        toolCallCount: 1,
        hasFailedToolCall: false,
        toolCalls: [
          expect.objectContaining({
            id: "call:call-search",
            name: "搜索文件",
            toolName: "Grep",
            callType: null,
            status: "已完成",
            statusKind: "completed",
            summary: ""
          })
        ]
      },
      {
        kind: "message",
        message: {
          id: "event-64",
          body: "本地工作目录是空的，所以我按当前公开的 OpenCode 项目来分析。",
          turnId: "turn-1",
          occurredAtUnixMs: null
        }
      }
    ]);
  });

  it("keeps thinking-only assistant items between tool calls at their original position", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session: {
        ...session,
        effectiveStatus: "completed",
        turnPhase: "completed"
      },
      timelineItems: [
        item({
          id: 90,
          seq: 90,
          turnId: "turn-1",
          itemType: "message.user",
          content: "完成这个修改"
        }),
        item({
          id: 91,
          seq: 91,
          turnId: "turn-1",
          itemType: "call.completed",
          name: "read_file",
          status: "completed",
          payload: {
            input: { file_path: "README.md" }
          }
        }),
        item({
          id: 92,
          seq: 92,
          turnId: "turn-1",
          itemType: "message.assistant_thinking",
          content: "我先确认文档，再更新实现文件。"
        }),
        item({
          id: 93,
          seq: 93,
          turnId: "turn-1",
          itemType: "call.completed",
          name: "edit_file",
          status: "completed",
          payload: {
            input: { file_path: "src/App.tsx" }
          }
        }),
        item({
          id: 94,
          seq: 94,
          turnId: "turn-1",
          itemType: "message.assistant",
          content: "已经整理好变更。"
        })
      ]
    });

    expect(view.turns[0]?.agentItems).toEqual([
      expect.objectContaining({
        kind: "tool-calls",
        toolCallCount: 1,
        toolCalls: [expect.objectContaining({ toolName: "Read" })]
      }),
      {
        kind: "thinking",
        thinking: {
          id: "event-92",
          body: "我先确认文档，再更新实现文件。",
          turnId: "turn-1",
          occurredAtUnixMs: null
        }
      },
      expect.objectContaining({
        kind: "tool-calls",
        toolCallCount: 1,
        toolCalls: [expect.objectContaining({ toolName: "Edit" })]
      }),
      {
        kind: "message",
        message: {
          id: "event-94",
          body: "已经整理好变更。",
          turnId: "turn-1",
          occurredAtUnixMs: null
        }
      }
    ]);
  });

  it("keeps trailing grouped tools split while the session is still processing", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session: {
        ...session,
        effectiveStatus: "working",
        turnPhase: "working"
      },
      timelineItems: [
        item({
          id: 95,
          seq: 95,
          turnId: "turn-1",
          itemType: "message.user",
          content: "继续执行"
        }),
        item({
          id: 96,
          seq: 96,
          turnId: "turn-1",
          itemType: "call.completed",
          name: "read_file",
          status: "completed",
          payload: {
            input: { file_path: "README.md" }
          }
        }),
        item({
          id: 97,
          seq: 97,
          turnId: "turn-1",
          itemType: "message.assistant_thinking",
          content: "我还在确认下一步改动。"
        }),
        item({
          id: 98,
          seq: 98,
          turnId: "turn-1",
          itemType: "call.completed",
          name: "edit_file",
          status: "completed",
          payload: {
            input: { file_path: "src/App.tsx" }
          }
        })
      ]
    });

    expect(view.turns[0]?.agentItems).toEqual([
      expect.objectContaining({
        kind: "tool-calls",
        toolCallCount: 1,
        toolCalls: [expect.objectContaining({ id: "event-96" })]
      }),
      {
        kind: "thinking",
        thinking: {
          id: "event-97",
          body: "我还在确认下一步改动。",
          turnId: "turn-1",
          occurredAtUnixMs: null
        }
      },
      expect.objectContaining({
        kind: "tool-calls",
        toolCallCount: 1,
        toolCalls: [expect.objectContaining({ id: "event-98" })]
      })
    ]);
  });

  it("renders non-Codex tool activities through the shared tool call disclosure model", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity: { ...activity, agentProvider: "gemini", agentName: "Gemini" },
      session: { ...session, provider: "gemini" },
      timelineItems: [
        item({
          id: 70,
          turnId: "turn-1",
          itemType: "message.user",
          content: "查一下 TODO"
        }),
        item({
          id: 71,
          turnId: "turn-1",
          itemType: "activity.started",
          payload: {
            activityKey: "tool.run_shell_command",
            metadata: {
              activityKind: "run_command",
              callID: "gemini-call-1",
              input: { command: "rg TODO" }
            }
          }
        }),
        item({
          id: 72,
          turnId: "turn-1",
          itemType: "event",
          payload: {
            eventKey: "activity.completed",
            activityKey: "tool.run_shell_command",
            metadata: {
              activityKind: "run_command",
              callID: "gemini-call-1",
              input: { command: "rg TODO" },
              output: { output: "src/App.tsx:12:TODO" }
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCallCount).toBe(1);
    expect(view.turns[0]?.agentItems).toEqual([
      {
        kind: "tool-calls",
        id: "tools:event-71",
        toolCallCount: 1,
        hasFailedToolCall: false,
        toolCalls: [
          expect.objectContaining({
            id: "call:gemini-call-1",
            name: "执行命令",
            toolName: "Bash",
            callType: null,
            status: "已完成",
            statusKind: "completed",
            summary: "rg TODO"
          })
        ]
      }
    ]);
  });

  it("does not treat agent activity timeline items as tool calls", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity: {
        ...activity,
        agentProvider: "openclaw",
        agentName: "OpenClaw"
      },
      session: { ...session, provider: "openclaw" },
      timelineItems: [
        item({
          id: 80,
          turnId: "turn-1",
          itemType: "message.user",
          content: "总结一下"
        }),
        item({
          id: 81,
          turnId: "turn-1",
          itemType: "activity.completed",
          payload: {
            activityKey: "agent.responding",
            metadata: { activityKind: "responding" }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCallCount).toBe(0);
    expect(view.turns[0]?.agentItems).toEqual([]);
  });

  it("does not treat call items carrying agent.responding activity as tool calls", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 82,
          turnId: "turn-1",
          itemType: "message.user",
          content: "总结一下"
        }),
        item({
          id: 83,
          turnId: "turn-1",
          itemType: "call",
          callType: "tool",
          name: "agent.responding",
          status: "completed",
          payload: {
            activityKey: "agent.responding",
            metadata: { activityKind: "responding" }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCallCount).toBe(0);
    expect(view.turns[0]?.agentItems).toEqual([]);
  });

  it("uses the canonical tool title for unknown tool calls without compacting payload JSON", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 30,
          itemType: "message.user",
          content: "运行未知工具"
        }),
        item({
          id: 31,
          itemType: "call.tool",
          name: "CurrentTask",
          status: "completed",
          payload: {
            nested: {
              noisy: true
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "event-31",
        name: "当前任务",
        toolName: "CurrentTask",
        callType: null,
        status: "已完成",
        statusKind: "completed",
        summary: "CurrentTask"
      })
    ]);
  });

  it("shows a summary for unknown tools when the input includes a useful string", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 32,
          itemType: "message.user",
          content: "继续当前 Issue"
        }),
        item({
          id: 33,
          itemType: "call.tool",
          name: "CurrentTask",
          status: "completed",
          payload: {
            metadata: {
              activityKind: "use_tool",
              tool: "CurrentTask",
              input: {
                task: "所有文件只写入你指定的 run 输出目录"
              }
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "event-33",
        name: "当前任务",
        toolName: "CurrentTask",
        callType: null,
        status: "已完成",
        statusKind: "completed",
        summary: "task: 所有文件只写入你指定的 run 输出目录"
      })
    ]);
  });

  it("merges repeated timeline items for the same tool call id and uses the latest status", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 40,
          itemType: "message.user",
          content: "列出文件"
        }),
        item({
          id: 41,
          itemType: "call.tool",
          callId: "call-ls",
          name: "exec_command",
          status: "running",
          payload: {
            input: {
              cmd: 'rg --files -g "!node_modules"'
            },
            metadata: { activityKind: "run_command" }
          }
        }),
        item({
          id: 42,
          itemType: "call.tool",
          callId: "call-ls",
          name: "exec_command",
          status: "completed",
          payload: {
            metadata: { activityKind: "list_files" }
          }
        }),
        item({
          id: 43,
          itemType: "call.tool",
          name: "exec_command",
          status: "running",
          payload: {
            callId: "call-pwd",
            metadata: { activityKind: "run_command" }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCallCount).toBe(2);
    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call-ls",
        name: "读取文件",
        toolName: "Read",
        callType: null,
        status: "已完成",
        statusKind: "completed",
        summary: 'rg --files -g "!node_modules"'
      }),
      expect.objectContaining({
        id: "call:call-pwd",
        name: "执行命令",
        toolName: "Bash",
        callType: null,
        status: "进行中",
        statusKind: "working",
        summary: ""
      })
    ]);
  });

  it("infers legacy canonical tool names from persisted activity kind and ACP kind metadata", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 50,
          turnId: "turn-acp",
          itemType: "call.completed",
          callType: "tool",
          callId: "call-list",
          name: "Searching the Web",
          status: "completed",
          payload: {
            kind: "fetch",
            input: {
              action: {
                type: "search",
                query: "renderer parity harness"
              }
            },
            output: {
              links: [
                {
                  title: "Renderer notes",
                  url: "https://example.com/renderers"
                }
              ]
            }
          }
        }),
        item({
          id: 51,
          turnId: "turn-acp",
          itemType: "call.completed",
          callType: "tool",
          callId: "call-pwd",
          name: "Move file",
          status: "completed",
          payload: {
            kind: "move",
            input: {
              path: "/workspace/app/src/old.ts",
              destination: "/workspace/app/src/new.ts"
            },
            output: {
              success: true
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call-list",
        toolName: "WebSearch",
        summary: "renderer parity harness"
      }),
      expect.objectContaining({
        id: "call:call-pwd",
        toolName: "Edit",
        summary: "/workspace/app/src/old.ts"
      })
    ]);
  });

  it("does not infer live ACP tool names when canonical payload toolName is missing", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 52,
          turnId: "turn-web-fallback",
          itemType: "call.completed",
          callType: "tool",
          callId: "call-web-fallback",
          name: "Searching for: renderer parity harness",
          status: "completed",
          payload: {
            acp: {
              sessionUpdate: "tool_call_update",
              kind: "fetch"
            },
            input: {
              action: {
                type: "search",
                query: "renderer parity harness"
              }
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call-web-fallback",
        toolName: null,
        summary: "renderer parity harness"
      })
    ]);
  });

  it("does not display opaque call ids as unknown tool names", async () => {
    setAgentGuiI18nTestLocale("zh-CN");

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 152,
          turnId: "turn-opaque-call-id",
          itemType: "call.completed",
          callType: "tool",
          callId: "call_D4wKrNKJmMD6hNfBOr4EKpwo",
          name: "call_D4wKrNKJmMD6hNfBOr4EKpwo",
          status: "completed",
          payload: {
            callType: "tool"
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call_D4wKrNKJmMD6hNfBOr4EKpwo",
        name: "使用工具",
        toolName: null,
        summary: ""
      })
    ]);
  });

  it("preserves live canonical mcp tool names instead of nulling them out", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 53,
          turnId: "turn-mcp-live",
          itemType: "call.completed",
          callType: "mcp",
          callId: "call-mcp-live",
          name: "Search Jira",
          status: "completed",
          payload: {
            toolName: "mcp__Atlassian__searchJiraIssuesUsingJql",
            metadata: {
              server: "Atlassian"
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call-mcp-live",
        toolName: "mcp__Atlassian__searchJiraIssuesUsingJql"
      })
    ]);
  });

  it("falls back to legacy ACP kind when payload toolName only repeats the display title", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 54,
          turnId: "turn-edit-live-title",
          itemType: "call.completed",
          callType: "tool",
          callId: "call-edit-live-title",
          name: "Edit /workspace/app/note.txt",
          status: "completed",
          payload: {
            acp: {
              sessionUpdate: "tool_call",
              kind: "edit"
            },
            kind: "edit",
            toolName: "Edit /workspace/app/note.txt",
            input: {
              file_path: "/workspace/app/note.txt"
            },
            output: {
              changes: {
                "/workspace/app/note.txt": {
                  type: "add",
                  content: "hello\n"
                }
              }
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call-edit-live-title",
        toolName: "Edit",
        summary: "/workspace/app/note.txt"
      })
    ]);
  });

  it("falls back to legacy ACP kind when live ACP toolName looks like an opaque function alias", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 55,
          turnId: "turn-edit-live-opaque-alias",
          itemType: "call.completed",
          callType: "tool",
          callId: "call-edit-live-opaque-alias",
          name: "Call Function Pjspfy0lsdms 1",
          status: "completed",
          payload: {
            acp: {
              sessionUpdate: "tool_call_update",
              kind: "edit"
            },
            kind: "edit",
            toolName: "Pjspfy0lsdms",
            input: {
              file_path: "/workspace/app/note.txt"
            },
            output: {
              changes: {
                "/workspace/app/note.txt": {
                  type: "add",
                  content: "hello\n"
                }
              }
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call-edit-live-opaque-alias",
        name: "编辑文件",
        toolName: "Edit",
        summary: "/workspace/app/note.txt"
      })
    ]);
  });

  it("preserves live canonical provider tool names when they look like stable identifiers", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 54,
          turnId: "turn-provider-tool",
          itemType: "call.completed",
          callType: "tool",
          callId: "call-provider-tool",
          name: "Use provider tool",
          status: "completed",
          payload: {
            acp: {
              sessionUpdate: "tool_call_update",
              kind: "other"
            },
            toolName: "Context7Lookup",
            input: {
              query: "agent renderer parity"
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call-provider-tool",
        toolName: "Context7Lookup"
      })
    ]);
  });

  it("preserves live canonical provider tool names even when they contain spaces", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 56,
          turnId: "turn-provider-tool-spaced",
          itemType: "call.completed",
          callType: "tool",
          callId: "call-provider-tool-spaced",
          name: "Use provider tool",
          status: "completed",
          payload: {
            acp: {
              sessionUpdate: "tool_call_update",
              kind: "other"
            },
            toolName: "Context7 Lookup",
            input: {
              query: "agent renderer parity"
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call-provider-tool-spaced",
        toolName: "Context7 Lookup"
      })
    ]);
  });

  it("preserves unknown live canonical tool names even when they match the display title", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 57,
          turnId: "turn-provider-tool-equal-title",
          itemType: "call.completed",
          callType: "tool",
          callId: "call-provider-tool-equal-title",
          name: "CurrentTask",
          status: "completed",
          payload: {
            acp: {
              sessionUpdate: "tool_call_update",
              kind: "other"
            },
            toolName: "CurrentTask"
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call-provider-tool-equal-title",
        toolName: "CurrentTask"
      })
    ]);
  });

  it("uses Claude Code nested canonical tool names instead of opaque call_function ids", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 58,
          turnId: "turn-claude-code-meta-tool-name",
          itemType: "call.completed",
          callType: "tool",
          callId: "call_function_bxbk8qj6jmk1_1",
          name: "call_function_bxbk8qj6jmk1_1",
          status: "completed",
          payload: {
            callType: "tool",
            input: {
              _meta: {
                claudeCode: {
                  toolName: "Bash"
                }
              },
              kind: "execute",
              rawInput: {
                command: "ls -la"
              },
              title: "ls -la"
            },
            output: {
              _meta: {
                claudeCode: {
                  toolName: "Bash"
                }
              }
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call_function_bxbk8qj6jmk1_1",
        name: "执行命令",
        toolName: "Bash",
        summary: "ls -la"
      })
    ]);
  });

  it("nests delegated child tools under the parent agent call using parentToolUseId", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 62,
          turnId: "turn-agent-nesting",
          itemType: "call.completed",
          callType: "tool",
          callId: "call_parent_agent",
          name: "Task",
          status: "completed",
          payload: {
            toolName: "Agent",
            input: {
              prompt: "Explore the workspace",
              subagent_type: "Explore"
            },
            output: {
              output: "Workspace is empty."
            }
          }
        }),
        item({
          id: 63,
          turnId: "turn-agent-nesting",
          itemType: "call.completed",
          callType: "tool",
          callId: "call_child_glob",
          name: "call_child_glob",
          status: "completed",
          payload: {
            toolName: "Glob",
            input: {
              pattern: "**/*",
              _meta: {
                claudeCode: {
                  parentToolUseId: "call_parent_agent"
                }
              }
            },
            output: {
              stdout: "index.html\nCLAUDE.md\n"
            }
          }
        }),
        item({
          id: 64,
          turnId: "turn-agent-nesting",
          itemType: "call.completed",
          callType: "tool",
          callId: "call_child_bash",
          name: "call_child_bash",
          status: "completed",
          payload: {
            toolName: "Bash",
            input: {
              command: "ls -la",
              _meta: {
                claudeCode: {
                  parentToolUseId: "call_parent_agent"
                }
              }
            },
            output: {
              stdout: "total 0\n"
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toHaveLength(1);
    expect(view.turns[0]?.toolCalls[0]).toEqual(
      expect.objectContaining({
        id: "call:call_parent_agent",
        toolName: "Agent"
      })
    );
    expect(view.turns[0]?.toolCalls[0]?.payload).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              toolUseId: "call_child_glob",
              toolName: "Glob"
            }),
            expect.objectContaining({
              toolUseId: "call_child_bash",
              toolName: "Bash"
            })
          ])
        })
      })
    );
  });

  it("nests delegated child tools under the parent agent call across turns when parentToolUseId matches", () => {
    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 65,
          turnId: "turn-parent-agent",
          itemType: "call.completed",
          callType: "tool",
          callId: "call_parent_cross_turn",
          name: "Task",
          status: "completed",
          payload: {
            toolName: "Agent",
            input: {
              prompt: "Inspect cross-turn child calls"
            },
            output: {
              output: "Done."
            }
          }
        }),
        item({
          id: 66,
          turnId: "turn-child-tool",
          itemType: "call.completed",
          callType: "tool",
          callId: "call_child_cross_turn",
          name: "call_child_cross_turn",
          status: "completed",
          payload: {
            toolName: "Glob",
            input: {
              pattern: "**/*"
            },
            metadata: {
              parentToolUseId: "call_parent_cross_turn"
            },
            output: {
              stdout: "index.html\n"
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toHaveLength(1);
    expect(view.turns[0]?.toolCalls[0]?.payload).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              toolUseId: "call_child_cross_turn",
              toolName: "Glob"
            })
          ])
        })
      })
    );
    expect(view.turns[1]?.toolCalls ?? []).toHaveLength(0);
  });

  it("uses canonical search_query arrays for folded web-search summaries", async () => {
    setAgentGuiI18nTestLocale("en");

    const view = buildWorkspaceAgentSessionDetailViewModel({
      activity,
      session,
      timelineItems: [
        item({
          id: 55,
          turnId: "turn-search-query-array",
          itemType: "call.completed",
          callType: "tool",
          callId: "call-search-query-array",
          name: "Search the web",
          status: "completed",
          payload: {
            toolName: "WebSearch",
            input: {
              search_query: ["renderer parity harness", "codex ui"]
            }
          }
        })
      ]
    });

    expect(view.turns[0]?.toolCalls).toEqual([
      expect.objectContaining({
        id: "call:call-search-query-array",
        summary: "renderer parity harness"
      })
    ]);
  });
});
