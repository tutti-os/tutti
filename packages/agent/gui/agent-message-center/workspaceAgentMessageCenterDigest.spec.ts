import { describe, expect, it } from "vitest";
import type {
  AgentActivityMessage,
  AgentActivityNeedsAttentionItem
} from "@tutti-os/agent-activity-core";
import type { AgentConversationPromptVM } from "../shared/agentConversation/contracts/agentConversationVM";
import {
  buildWorkspaceAgentMessageCenterDigest as buildDigestFromPrecomputed,
  resolveWorkspaceAgentMessageCenterDigestAgentMessageSummary,
  type BuildWorkspaceAgentMessageCenterDigestInput,
  type WorkspaceAgentMessageCenterDigest,
  type WorkspaceAgentMessageCenterDigestAgentSummary
} from "./workspaceAgentMessageCenterDigest";

describe("buildWorkspaceAgentMessageCenterDigest", () => {
  it("uses agent messages for summaries instead of newer user messages", () => {
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      messages: [
        message({
          messageId: "assistant-1",
          role: "assistant",
          payload: { text: "Agent summary wins" },
          occurredAtUnixMs: 10
        }),
        message({
          messageId: "user-1",
          role: "user",
          payload: { text: "Newer user prompt loses" },
          occurredAtUnixMs: 20
        })
      ],
      needsAttention: null,
      pendingPrompt: null,
      status: "idle"
    });

    expect(digest.primary).toMatchObject({
      kind: "outcome",
      summary: "Agent summary wins",
      occurredAtUnixMs: 10
    });
  });

  it("uses a precomputed latest agent message when provided", () => {
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      latestAgentMessage: {
        summary: "Precomputed summary",
        occurredAtUnixMs: 42
      },
      messages: [
        message({
          messageId: "assistant-1",
          role: "assistant",
          payload: { text: "Message summary" },
          occurredAtUnixMs: 10
        })
      ],
      needsAttention: null,
      pendingPrompt: null,
      status: "working"
    });

    expect(digest.primary).toMatchObject({
      kind: "progress",
      summary: "Precomputed summary",
      occurredAtUnixMs: 42
    });
  });

  it("treats an explicit null latest agent message as precomputed empty", () => {
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      latestAgentMessage: null,
      messages: [
        message({
          messageId: "assistant-1",
          role: "assistant",
          payload: { text: "Skipped message summary" },
          occurredAtUnixMs: 10
        })
      ],
      needsAttention: null,
      pendingPrompt: null,
      status: "idle"
    });

    expect(digest.primary).toMatchObject({
      kind: "outcome",
      summary: "Fallback title",
      occurredAtUnixMs: null
    });
  });

  it("prefers displayPrompt for message summaries", () => {
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      messages: [
        message({
          messageId: "assistant-1",
          role: "assistant",
          payload: {
            displayPrompt: "Run Automation",
            text: "long automation prompt",
            content: "long automation prompt"
          },
          occurredAtUnixMs: 10
        })
      ],
      needsAttention: null,
      pendingPrompt: null,
      status: "idle"
    });

    expect(digest.primary).toMatchObject({
      summary: "Run Automation"
    });
  });

  it("prioritizes input-required over terminal-looking message summaries", () => {
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      messages: [
        message({
          payload: { text: "Finished writing files" },
          occurredAtUnixMs: 20
        })
      ],
      needsAttention: needsAttention({
        kind: "question",
        summary: "Choose the next step",
        occurredAtUnixMs: 30
      }),
      pendingPrompt: askUserPrompt("Choose the next step"),
      status: "working"
    });

    expect(digest.primary).toMatchObject({
      kind: "input-required",
      summary: "Choose the next step",
      occurredAtUnixMs: 30
    });
  });

  it("uses failed status for the primary kind even when the summary contains an artifact link", () => {
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      messages: [
        message({
          payload: {
            text: "Created [report.md](report.md), then the request failed"
          },
          occurredAtUnixMs: 40
        })
      ],
      needsAttention: null,
      pendingPrompt: null,
      status: "failed"
    });

    expect(digest.primary).toMatchObject({
      kind: "error",
      summary: "Created [report.md](report.md), then the request failed"
    });
  });

  it("skips generic tool-name summaries when choosing the card body", () => {
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      messages: [
        message({
          messageId: "assistant-1",
          kind: "message.assistant",
          payload: {
            text: "当前会话目录不在沙箱可写根里，我先尝试用标准补丁工具写入。"
          },
          occurredAtUnixMs: 10
        }),
        message({
          messageId: "approval-1",
          kind: "tool_call",
          status: "failed",
          payload: {
            callType: "approval",
            toolName: "Approval",
            title: "Approval"
          },
          occurredAtUnixMs: 20
        })
      ],
      needsAttention: null,
      pendingPrompt: null,
      status: "completed"
    });

    expect(digest.primary).toMatchObject({
      kind: "outcome",
      summary: "当前会话目录不在沙箱可写根里，我先尝试用标准补丁工具写入。",
      occurredAtUnixMs: 10
    });
  });

  it("uses generic tool output when it has a concrete result", () => {
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      messages: [
        message({
          messageId: "assistant-1",
          payload: { text: "I will run the tests." },
          occurredAtUnixMs: 10
        }),
        message({
          messageId: "tool-1",
          kind: "tool_call",
          status: "completed",
          payload: {
            output: { summary: "53 tests passed" },
            title: "Bash",
            toolName: "Bash"
          },
          occurredAtUnixMs: 20
        })
      ],
      needsAttention: null,
      pendingPrompt: null,
      status: "completed"
    });

    expect(digest.primary).toMatchObject({
      kind: "outcome",
      summary: "53 tests passed",
      occurredAtUnixMs: 20
    });
  });

  it("uses nested MCP approval tool errors as concrete tool results", () => {
    const errorText =
      "### Error\nError: Browser is already in use for /Users/ccr/.codex/playwright-profile, use --isolated to run multiple instances of the same browser";
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      messages: [
        message({
          messageId: "assistant-1",
          payload: {
            text: "我会尝试关闭占用的 Playwright 会话后重新打开页面。"
          },
          occurredAtUnixMs: 10
        }),
        message({
          messageId: "toolcall:call_ZYi9QClIkukN1cu3Kv30mQe4",
          kind: "tool_call",
          status: "failed",
          payload: {
            callId: "call_ZYi9QClIkukN1cu3Kv30mQe4",
            callType: "tool",
            error: {
              content: [
                {
                  content: { text: errorText, type: "text" },
                  type: "content"
                }
              ],
              isError: true,
              stdout: errorText
            },
            input: {
              id: "mcp_tool_call_approval_call_ZYi9QClIkukN1cu3Kv30mQe4",
              request: {
                _meta: {
                  codex_approval_kind: "mcp_tool_call"
                },
                message:
                  'Allow the playwright MCP server to run tool "browser_close"?'
              },
              server: "playwright",
              tool: "browser_close"
            },
            name: "Approval",
            output: { stdout: errorText },
            title: "Approval",
            toolName: "Approval"
          },
          occurredAtUnixMs: 20
        })
      ],
      needsAttention: null,
      pendingPrompt: null,
      status: "completed"
    });

    expect(digest.primary).toMatchObject({
      kind: "outcome",
      summary:
        "playwright / browser_close: Error: Browser is already in use for /Users/ccr/.codex/playwright-profile, use --isolated to run multiple instances of the same browser",
      occurredAtUnixMs: 20
    });
  });

  it("uses generic tool input targets when no result summary exists", () => {
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      messages: [
        message({
          messageId: "assistant-1",
          payload: { text: "I will verify the package." },
          occurredAtUnixMs: 10
        }),
        message({
          messageId: "tool-1",
          kind: "tool_call",
          status: "completed",
          payload: {
            input: { command: "pnpm --filter @tutti-os/agent-gui test" },
            title: "Bash",
            toolName: "Bash"
          },
          occurredAtUnixMs: 20
        })
      ],
      needsAttention: null,
      pendingPrompt: null,
      status: "completed"
    });

    expect(digest.primary).toMatchObject({
      kind: "outcome",
      summary: "pnpm --filter @tutti-os/agent-gui test",
      occurredAtUnixMs: 20
    });
  });

  it("classifies completed, idle, and canceled sessions as outcome digests", () => {
    for (const status of ["completed", "idle", "canceled"] as const) {
      const digest = buildWorkspaceAgentMessageCenterDigest({
        fallbackTitle: "Fallback title",
        messages: [message({ payload: { text: `${status} summary` } })],
        needsAttention: null,
        pendingPrompt: null,
        status
      });

      expect(digest.primary).toMatchObject({
        kind: "outcome",
        summary: `${status} summary`
      });
    }
  });

  it("classifies working sessions with agent messages as progress digests", () => {
    const digest = buildWorkspaceAgentMessageCenterDigest({
      fallbackTitle: "Fallback title",
      messages: [message({ payload: { text: "Scanning files" } })],
      needsAttention: null,
      pendingPrompt: null,
      status: "working"
    });

    expect(digest.primary).toMatchObject({
      kind: "progress",
      summary: "Scanning files"
    });
  });

  it("falls back to needs-attention summary or title when no agent summary exists", () => {
    expect(
      buildWorkspaceAgentMessageCenterDigest({
        fallbackTitle: "Fallback title",
        messages: [],
        needsAttention: needsAttention({ summary: "Answer required" }),
        pendingPrompt: null,
        status: "waiting"
      }).primary.summary
    ).toBe("Answer required");

    expect(
      buildWorkspaceAgentMessageCenterDigest({
        fallbackTitle: "Fallback title",
        messages: [],
        needsAttention: null,
        pendingPrompt: null,
        status: "idle"
      }).primary.summary
    ).toBe("Fallback title");
  });
});

type DigestSpecInput = Omit<
  BuildWorkspaceAgentMessageCenterDigestInput,
  "latestAgentMessage"
> & {
  latestAgentMessage?: WorkspaceAgentMessageCenterDigestAgentSummary | null;
  messages?: readonly AgentActivityMessage[];
};

function buildWorkspaceAgentMessageCenterDigest(
  input: DigestSpecInput
): WorkspaceAgentMessageCenterDigest {
  const { latestAgentMessage, messages = [], ...digestInput } = input;
  return buildDigestFromPrecomputed({
    ...digestInput,
    latestAgentMessage:
      latestAgentMessage === undefined
        ? latestDigestAgentMessage(messages)
        : latestAgentMessage
  });
}

function latestDigestAgentMessage(
  messages: readonly AgentActivityMessage[]
): WorkspaceAgentMessageCenterDigestAgentSummary | null {
  let latest: WorkspaceAgentMessageCenterDigestAgentSummary | null = null;
  for (const item of messages) {
    const summary =
      resolveWorkspaceAgentMessageCenterDigestAgentMessageSummary(item);
    if (!summary) {
      continue;
    }
    const occurredAtUnixMs = messageTimeUnixMs(item);
    if (!latest || occurredAtUnixMs >= latest.occurredAtUnixMs) {
      latest = { summary, occurredAtUnixMs };
    }
  }
  return latest;
}

function message(
  overrides: Partial<AgentActivityMessage>
): AgentActivityMessage {
  return {
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    messageId: "message-1",
    version: 1,
    turnId: "turn-1",
    role: "assistant",
    kind: "message.assistant",
    status: "running",
    payload: {},
    occurredAtUnixMs: 1,
    ...overrides
  };
}

function needsAttention(
  overrides: Partial<AgentActivityNeedsAttentionItem>
): AgentActivityNeedsAttentionItem {
  return {
    id: "session-1:message-1",
    workspaceId: "workspace-1",
    agentSessionId: "session-1",
    provider: "codex",
    title: "Fallback title",
    cwd: "/workspace",
    kind: "question",
    summary: "Needs attention",
    occurredAtUnixMs: 1,
    ...overrides
  };
}

function askUserPrompt(title: string): AgentConversationPromptVM {
  return {
    kind: "ask-user",
    requestId: "request-1",
    title,
    questions: [
      {
        id: "response",
        header: title,
        question: title,
        options: [],
        multiSelect: false,
        answer: null
      }
    ]
  };
}

function messageTimeUnixMs(message: AgentActivityMessage): number {
  return (
    positiveNumber(message.occurredAtUnixMs) ??
    positiveNumber(message.completedAtUnixMs) ??
    positiveNumber(message.startedAtUnixMs) ??
    positiveNumber(message.version) ??
    0
  );
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}
