import { describe, expect, it } from "vitest";
import type { WorkspaceAgentSessionDetailToolCall } from "../../workspaceAgentSessionDetailViewModel";
import { projectAgentToolCall } from "./agentToolProjection";

describe("projectAgentToolCall", () => {
  it.each([
    ["Bash", "tool", "bash"],
    ["Read", "tool", "read"],
    ["Write", "tool", "write"],
    ["Edit", "tool", "edit"],
    ["Grep", "tool", "search"],
    ["Glob", "tool", "search"],
    ["WebSearch", "tool", "web-search"],
    ["WebFetch", "tool", "web-fetch"],
    ["ImageGeneration", "tool", "image-generation"],
    ["TodoWrite", "tool", "todo-write"],
    ["Task", "tool", "task"]
  ] satisfies Array<[string, string, string]>)(
    "maps canonical tool name %s/%s to %s",
    (toolName, callType, rendererKind) => {
      expect(
        projectAgentToolCall({
          ...baseCall(),
          toolName,
          callType
        }).rendererKind
      ).toBe(rendererKind);
    }
  );

  it.each([
    ["read_file", "tool", "read"],
    ["write_file", "tool", "write"],
    ["edit_file", "tool", "edit"],
    ["bash", "tool", "bash"],
    ["grep", "tool", "search"],
    ["websearch", "tool", "web-search"],
    ["webfetch", "tool", "web-fetch"],
    ["todowrite", "tool", "todo-write"],
    ["toolsearch", "tool", "tool-search"],
    ["skill", "tool", "skill"],
    ["closeAgent", "tool", "default"],
    ["wait", "tool", "default"],
    ["custom_mcp_tool", "mcp", "mcp"],
    ["Approval", "approval", "approval"],
    ["EnterPlanMode", "interactive", "plan-enter"],
    ["ExitPlanMode", "interactive", "plan-exit"],
    ["AskUserQuestion", "interactive", "ask-user"],
    ["Task", "tool", "task"],
    ["Agent", "tool", "task"],
    ["delegate_agent", "tool", "task"]
  ] satisfies Array<[string, string, string]>)(
    "maps %s/%s to %s",
    (toolName, callType, rendererKind) => {
      expect(
        projectAgentToolCall({
          ...baseCall(),
          toolName,
          callType
        }).rendererKind
      ).toBe(rendererKind);
    }
  );

  it("projects approval, ask-user, plan, and task structured payloads", () => {
    const approval = projectAgentToolCall({
      ...baseCall(),
      toolName: "Approval",
      callType: "approval",
      payload: {
        input: {
          requestId: "approval-1",
          options: [{ optionId: "yes", label: "Allow", description: "Proceed" }]
        }
      }
    });
    expect(approval.approval?.requestId).toBe("approval-1");

    const switchModeApproval = projectAgentToolCall({
      ...baseCall(),
      toolName: "Approval",
      callType: "approval",
      status: "waiting_approval",
      payload: {
        input: {
          requestId: "0",
          toolCall: {
            kind: "switch_mode",
            title: "Ready to code?",
            toolCallId: "call-1"
          },
          options: [
            { optionId: "default", name: "Yes, and manually approve edits" },
            { optionId: "plan", name: "No, keep planning" }
          ]
        }
      }
    });
    expect(switchModeApproval.approval).toBeNull();
    expect(switchModeApproval.planMode).toEqual(
      expect.objectContaining({
        kind: "exit",
        requestId: "0",
        title: "Ready to code?"
      })
    );
    expect(switchModeApproval.rendererKind).toBe("plan-exit");

    const askUser = projectAgentToolCall({
      ...baseCall(),
      toolName: "AskUserQuestion",
      callType: "interactive",
      payload: {
        input: {
          requestId: "prompt-1",
          questions: [
            {
              id: "q1",
              header: "Choice",
              question: "Pick one",
              options: [{ label: "A", description: "Option A" }]
            }
          ]
        }
      }
    });
    expect(askUser.askUserQuestion?.questions[0]?.question).toBe("Pick one");

    const task = projectAgentToolCall({
      ...baseCall(),
      toolName: "Task",
      callType: "tool",
      payload: {
        input: {
          prompt: "Fix the build"
        },
        output: {
          steps: [
            {
              id: "step-1",
              toolName: "Read",
              status: "completed",
              toolResult: { text: "done" }
            }
          ]
        },
        metadata: {
          childSessionID: "child-1"
        }
      }
    });
    expect(task.task?.delegateSessionId).toBe("child-1");
    expect(task.task?.steps).toHaveLength(1);
  });

  it("normalizes persisted standard ACP envelopes for specialized tool renderers", () => {
    const projected = projectAgentToolCall({
      ...baseCall(),
      toolName: "Edit",
      callType: "tool",
      payload: {
        input: {
          kind: "edit",
          title: "apply_patch",
          rawInput: { patchText: "*** Begin Patch" }
        },
        output: {
          rawOutput: {
            metadata: {
              diff: "Index: /workspace/index.html\n--- /workspace/index.html\n+++ /workspace/index.html",
              files: [
                {
                  filePath: "/workspace/index.html",
                  patch: "Index: /workspace/index.html"
                }
              ]
            }
          }
        }
      }
    });

    expect(projected.rendererKind).toBe("edit");
    expect(projected.input?.patchText).toBe("*** Begin Patch");
    expect(projected.output?.diff).toContain("/workspace/index.html");
    expect(projected.output?.files).toEqual([
      expect.objectContaining({ filePath: "/workspace/index.html" })
    ]);
  });

  it("prefers canonical payload input/output over tool_state when both exist", () => {
    const projected = projectAgentToolCall({
      ...baseCall(),
      toolName: "Bash",
      payload: {
        input: { command: "pwd" },
        output: { stdout: "/workspace\n" },
        tool_state: {
          input: { command: "legacy pwd" },
          output: { stdout: "legacy output\n" }
        }
      }
    });

    expect(projected.input?.command).toBe("pwd");
    expect(projected.output?.stdout).toBe("/workspace\n");
  });

  it("uses explicit MCP target fields for approval-wrapped tool names", () => {
    const projected = projectAgentToolCall({
      ...baseCall(),
      name: "Approval",
      toolName: "Approval",
      callType: "tool",
      payload: {
        input: {
          requestId: "request-1",
          server: "playwright",
          tool: "browser_close",
          options: [{ optionId: "approved", name: "Allow" }]
        }
      }
    });

    expect(projected.name).toBe("playwright / browser_close");
    expect(projected.approval?.title).toBe("playwright / browser_close");
  });

  it("projects canonical top-level content and locations into the tool vm", () => {
    const projected = projectAgentToolCall({
      ...baseCall(),
      toolName: "Read",
      payload: {
        locations: [{ path: "/workspace/src/app.ts", line: 4 }],
        content: [{ type: "text", text: "export const ready = true\n" }]
      }
    });

    expect(projected.locations).toEqual([
      { path: "/workspace/src/app.ts", line: 4 }
    ]);
    expect(projected.content).toEqual([
      { type: "text", text: "export const ready = true\n" }
    ]);
  });

  it("detects opaque image generation aliases from canonical content blocks", () => {
    const projected = projectAgentToolCall({
      ...baseCall(),
      toolName: "ig_05eb62dbe723c910016a1336ad3de881919216a6f64051a5e2",
      name: "ig_05eb62dbe723c910016a1336ad3de881919216a6f64051a5e2",
      payload: {
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
    });

    expect(projected.rendererKind).toBe("image-generation");
  });

  it("preserves nested output.output text for task results and step summaries", () => {
    const projected = projectAgentToolCall({
      ...baseCall(),
      toolName: "Task",
      callType: "tool",
      payload: {
        output: {
          output: "Task finished successfully",
          steps: [
            {
              id: "step-1",
              toolName: "Read",
              status: "completed",
              toolResult: { output: "Loaded docs chunk" }
            }
          ]
        }
      }
    });

    expect(projected.task?.resultMarkdown).toBe("Task finished successfully");
    expect(projected.task?.steps[0]?.summary).toBe("Loaded docs chunk");
  });

  it("does not project task summary or prompt as output when result payload is missing", () => {
    const prompt =
      "Generate one random integer from 1 to 10 inclusive. Use your own randomness.";
    const projected = projectAgentToolCall({
      ...baseCall(),
      name: "Agent",
      toolName: "Agent",
      callType: "tool",
      status: "failed",
      statusKind: "failed",
      summary: prompt,
      payload: {
        input: {
          prompt,
          task: prompt
        }
      }
    });

    expect(projected.task?.prompt).toBe(prompt);
    expect(projected.task?.resultMarkdown).toBeNull();
  });

  it("projects Claude subagent prompt, duration, result, and steps from nested tool response payloads", () => {
    const projected = projectAgentToolCall({
      ...baseCall(),
      name: "Task: Search today top news",
      toolName: "Agent",
      callType: "tool",
      payload: {
        input: {
          _meta: {
            claudeCode: {
              toolResponse: {
                prompt: "Search for today's top news (2026年5月24日).",
                agentId: "child-agent-1",
                totalDurationMs: 42_400
              }
            }
          }
        },
        output: {
          content: [
            {
              type: "content",
              content: {
                text: "Here is a summary of today's top news (2026年5月24日):"
              }
            }
          ]
        },
        metadata: {
          steps: [
            {
              id: "step-1",
              toolName: "WebSearch",
              status: "completed",
              toolResult: {
                text: "Searched web"
              }
            }
          ]
        }
      }
    });

    expect(projected.task?.prompt).toBe(
      "Search for today's top news (2026年5月24日)."
    );
    expect(projected.task?.delegateSessionId).toBe("child-agent-1");
    expect(projected.task?.durationMs).toBe(42_400);
    expect(projected.task?.resultMarkdown).toBe(
      "Here is a summary of today's top news (2026年5月24日):"
    );
    expect(projected.task?.steps).toHaveLength(1);
    expect(projected.task?.steps[0]?.summary).toBe("Searched web");
  });

  it("projects async subagent agent id from metadata", () => {
    const projected = projectAgentToolCall({
      ...baseCall(),
      toolName: "Agent",
      callType: "subagent",
      payload: {
        input: {
          prompt: "Inspect workspace"
        },
        metadata: {
          subagentAsync: true,
          taskStatus: "running",
          subagentAgentId: "a33f4e9013dedffe8"
        }
      }
    });

    expect(projected.task?.delegateSessionId).toBe("a33f4e9013dedffe8");
    expect(projected.task?.status).toBe("running");
  });
});

function baseCall(): WorkspaceAgentSessionDetailToolCall {
  return {
    id: "call:1",
    name: "Tool",
    toolName: null,
    callType: "tool",
    status: "Completed",
    statusKind: "completed",
    summary: "",
    payload: null
  };
}
