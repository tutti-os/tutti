import assert from "node:assert/strict";
import test from "node:test";
import {
  answersFromInteractivePayload,
  commandEntries,
  goalStateFromContentBlocks,
  sdkContentFromPromptBlocks,
  speedFromFastModeState,
  toolPayload
} from "./normalizer.ts";

test("commandEntries filters unsupported commands and preserves SDK hints", () => {
  assert.deepEqual(
    commandEntries([
      { name: "context", description: "Show context", argumentHint: "scope" },
      {
        name: "review",
        description: "Review changes",
        argumentHint: ["target", "range"]
      },
      { name: "github (MCP)", description: "MCP command" },
      { name: "login", description: "Unsupported" },
      "usage",
      "  "
    ]),
    [
      {
        name: "context",
        description: "Show context",
        input: { hint: "scope" }
      },
      {
        name: "review",
        description: "Review changes",
        input: { hint: "target range" }
      },
      {
        name: "mcp:github",
        description: "MCP command"
      },
      { name: "usage" }
    ]
  );
});

test("speedFromFastModeState normalizes definitive states only", () => {
  assert.equal(speedFromFastModeState("on"), "fast");
  assert.equal(speedFromFastModeState("off"), "standard");
  assert.equal(speedFromFastModeState("cooldown"), undefined);
  assert.equal(speedFromFastModeState("unsupported"), undefined);
  assert.equal(speedFromFastModeState(undefined), undefined);
});

test("sdkContentFromPromptBlocks embeds Claude image prompt blocks", () => {
  assert.deepEqual(
    sdkContentFromPromptBlocks(
      [
        { type: "text", text: "What's in this image?" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }
      ],
      "fallback"
    ),
    [
      { type: "text", text: "What's in this image?" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "aW1hZ2U="
        }
      }
    ]
  );
});

test("sdkContentFromPromptBlocks falls back to legacy prompt text", () => {
  assert.deepEqual(sdkContentFromPromptBlocks(undefined, "hello"), [
    { type: "text", text: "hello" }
  ]);
});

test("toolPayload converts Claude structuredPatch hunks into executable changes", () => {
  const payload = toolPayload(
    "turn-1",
    {
      id: "toolu-edit",
      name: "Edit",
      input: {
        file_path: "/repo/src/app.ts",
        old_string: "old line",
        new_string: "new line"
      },
      partialInputJson: "",
      started: true
    },
    "completed",
    {
      _meta: {
        claudeCode: {
          toolResponse: {
            type: "update",
            filePath: "/repo/src/app.ts",
            structuredPatch: [
              {
                oldStart: 5,
                oldLines: 3,
                newStart: 5,
                newLines: 3,
                lines: [" context", "-old line", "+new line"]
              },
              {
                oldStart: 20,
                oldLines: 1,
                newStart: 20,
                newLines: 1,
                lines: ["-foo", "+bar"]
              }
            ]
          }
        }
      }
    }
  );

  const output = payload.output as Record<string, unknown>;
  const diff =
    "@@ -5,3 +5,3 @@\n context\n-old line\n+new line\n@@ -20,1 +20,1 @@\n-foo\n+bar";
  assert.deepEqual(output.structuredPatch, [
    {
      path: "/repo/src/app.ts",
      filePath: "/repo/src/app.ts",
      kind: "update",
      change: "update",
      diff,
      patch: diff
    }
  ]);
  assert.deepEqual(output.changes, [
    {
      path: "/repo/src/app.ts",
      type: "update",
      diff
    }
  ]);
});

test("toolPayload preserves Write create semantics from Claude tool_response", () => {
  const payload = toolPayload(
    "turn-1",
    {
      id: "toolu-write",
      name: "Write",
      input: {
        file_path: "/repo/new.ts",
        content: "first\nsecond"
      },
      partialInputJson: "",
      started: true
    },
    "completed",
    {
      tool_response: {
        type: "create",
        filePath: "/repo/new.ts",
        structuredPatch: [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
            lines: ["+first", "+second"]
          }
        ]
      }
    }
  );

  const output = payload.output as Record<string, unknown>;
  assert.deepEqual(output.changes, [
    {
      path: "/repo/new.ts",
      type: "create",
      diff: "@@ -0,0 +1,2 @@\n+first\n+second"
    }
  ]);
});

test("toolPayload preserves subagent parent id and delegated steps", () => {
  const payload = toolPayload(
    "turn-1",
    {
      id: "toolu-task",
      name: "Task",
      input: {
        description: "Inspect workspace",
        prompt: "Find relevant files"
      },
      partialInputJson: "",
      started: true,
      steps: [
        {
          id: "toolu-read",
          toolUseId: "toolu-read",
          toolName: "Read",
          status: "completed",
          toolInput: { file_path: "/repo/README.md" },
          toolResult: { text: "Read README" }
        }
      ]
    },
    "completed",
    {
      content: "Task complete"
    }
  );

  assert.deepEqual((payload.metadata as Record<string, unknown>).steps, [
    {
      id: "toolu-read",
      toolUseId: "toolu-read",
      toolName: "Read",
      status: "completed",
      toolInput: { file_path: "/repo/README.md" },
      toolResult: { text: "Read README" }
    }
  ]);

  const childPayload = toolPayload(
    "turn-1",
    {
      id: "toolu-read",
      name: "Read",
      input: {
        file_path: "/repo/README.md"
      },
      partialInputJson: "",
      started: true,
      parentToolUseId: "toolu-task"
    },
    "completed",
    { content: "Read README" }
  );

  assert.equal(
    (childPayload.metadata as Record<string, unknown>).parentToolUseId,
    "toolu-task"
  );
});

test("toolPayload extracts async subagent launch metadata", () => {
  const payload = toolPayload(
    "turn-1",
    {
      id: "toolu-agent",
      name: "Agent",
      input: {
        prompt: "Inspect workspace"
      },
      partialInputJson: "",
      started: true
    },
    "completed",
    {
      content:
        "Async agent launched successfully\nagentId: a33f4e9013dedffe8\noutput_file: /private/tmp/claude/tasks/a33f4e9013dedffe8.output"
    }
  );

  assert.deepEqual(payload.metadata, {
    adapter: "claude-agent-sdk",
    toolName: "Agent",
    async: true,
    subagentAsync: true,
    taskStatus: "running",
    subagentStatus: "running",
    subagentAgentId: "a33f4e9013dedffe8",
    agentId: "a33f4e9013dedffe8",
    outputFile: "/private/tmp/claude/tasks/a33f4e9013dedffe8.output",
    subagentOutputFile: "/private/tmp/claude/tasks/a33f4e9013dedffe8.output"
  });
});

test("toolPayload ignores Claude async subagent agentId suffix", () => {
  const payload = toolPayload(
    "turn-1",
    {
      id: "toolu-agent",
      name: "Agent",
      input: { prompt: "Inspect workspace" },
      partialInputJson: "",
      started: true
    },
    "completed",
    {
      content:
        "Async agent launched successfully\nagentId: a33f4e9013dedffe8 (internal ID: keep out)\noutput_file: /tmp/a33f4e9013dedffe8.output"
    }
  );

  assert.equal(
    (payload.metadata as Record<string, unknown>).agentId,
    "a33f4e9013dedffe8"
  );
});

test("toolPayload classifies Claude interactive tools as interactive", () => {
  for (const toolName of ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]) {
    const payload = toolPayload("turn-1", baseTool(toolName), "completed");

    assert.equal(payload.callType, "interactive");
    assert.deepEqual(payload.metadata, {
      adapter: "claude-agent-sdk",
      toolName
    });
  }
});

test("answersFromInteractivePayload keys answers by question text for Claude SDK", () => {
  assert.deepEqual(
    answersFromInteractivePayload(
      {
        answers: ["React", "UI, daemon"],
        answersByQuestionId: {
          "framework-id": "React",
          "question-2": ["UI", "daemon"]
        }
      },
      {
        questions: [
          {
            id: "framework-id",
            question: "Which framework?",
            options: [{ label: "React" }]
          },
          {
            question: "Which areas?",
            multiSelect: true,
            options: [{ label: "UI" }, { label: "daemon" }]
          }
        ]
      }
    ),
    {
      "Which framework?": "React",
      "Which areas?": "UI, daemon"
    }
  );
});

test("goalStateFromContentBlocks maps SDK goal_status attachments", () => {
  assert.deepEqual(
    goalStateFromContentBlocks([
      {
        type: "attachment",
        attachment: {
          type: "goal_status",
          met: false,
          sentinel: true,
          condition: "ship native goal"
        }
      }
    ]),
    {
      objective: "ship native goal",
      status: "active",
      sentinel: true
    }
  );
  assert.deepEqual(
    goalStateFromContentBlocks([
      {
        type: "goal_status",
        met: true,
        condition: "ship native goal",
        reason: "done",
        iterations: 1
      }
    ]),
    {
      objective: "ship native goal",
      status: "complete",
      reason: "done",
      iterations: 1
    }
  );
});

function baseTool(name: string) {
  return {
    id: `toolu-${name.toLowerCase()}`,
    name,
    input: {},
    partialInputJson: "",
    started: true
  };
}
