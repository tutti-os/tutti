import { describe, expect, it } from "vitest";
import type { AgentToolCallVM } from "../../../contracts/agentToolCallVM";
import {
  getCommandRenderData,
  getFileChangeRenderData,
  getImageGenerationRenderData,
  getPlanModeRenderData,
  getSearchRenderData,
  getSkillRenderData,
  getTaskRenderData,
  getToolCallFailureText,
  getToolFallbackText,
  getWebSearchRenderData,
  getWebFetchRenderData
} from "./agentToolRenderData";

describe("agentToolRenderData", () => {
  it("uses the historical Codex savedPath as an image preview fallback", () => {
    const data = getImageGenerationRenderData(
      makeCall({
        toolName: "ImageGeneration",
        name: "Generate image",
        output: {
          savedPath:
            "/Users/demo/.tutti/agent/runs/session/codex-home/generated_images/thread/ig_123.png",
          result: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
        }
      })
    );

    expect(data).toEqual({
      prompt: null,
      imageUri:
        "/Users/demo/.tutti/agent/runs/session/codex-home/generated_images/thread/ig_123.png",
      mimeType: null
    });
  });

  it("uses canonical generated image fields without content blocks", () => {
    const data = getImageGenerationRenderData(
      makeCall({
        toolName: "ImageGeneration",
        output: {
          savedPaths: ["/workspace/output/canonical.png"],
          imageMimeType: "image/png"
        }
      })
    );

    expect(data).toEqual({
      prompt: null,
      imageUri: "/workspace/output/canonical.png",
      mimeType: "image/png"
    });
  });

  it("uses the first canonical generated-image path", () => {
    const data = getImageGenerationRenderData(
      makeCall({
        toolName: "ImageGeneration",
        output: {
          savedPaths: ["/workspace/output/canonical.webp"],
          imageMimeType: "image/webp"
        }
      })
    );

    expect(data).toEqual({
      prompt: null,
      imageUri: "/workspace/output/canonical.webp",
      mimeType: "image/webp"
    });
  });

  it("derives a Windows plan file name from the native path", () => {
    const data = getPlanModeRenderData(
      makeCall({
        rendererKind: "plan-enter",
        input: {
          filePath: "C:\\Users\\demo\\workspace\\plans\\plan.md"
        }
      })
    );

    expect(data.filePath).toBe("C:\\Users\\demo\\workspace\\plans\\plan.md");
    expect(data.fileName).toBe("plan.md");
  });

  it("extracts canonical command render data", () => {
    const data = getCommandRenderData(
      makeCall({
        toolName: "Bash",
        input: {
          command: "ls -la",
          cwd: "/workspace/room"
        },
        output: {
          stdout: "total 8\n",
          exitCode: 0,
          duration: { secs: 0, nanos: 240164833 }
        }
      })
    );

    expect(data).toMatchObject({
      command: "ls -la",
      cwd: "/workspace/room",
      stdout: "total 8\n",
      stderr: "",
      exitCode: 0,
      status: "completed"
    });
    expect(data.durationMs).toBeCloseTo(240.164833);
  });

  it("extracts flattened canonical command input", () => {
    const data = getCommandRenderData(
      makeCall({
        toolName: "Bash",
        input: {
          command: "python3 hello.py"
        },
        output: {
          stdout: "Hello, World!\n",
          exitCode: 0
        }
      })
    );

    expect(data).toMatchObject({
      command: "python3 hello.py",
      stdout: "Hello, World!\n",
      stderr: "",
      exitCode: 0,
      status: "completed"
    });
  });

  it("extracts durable command render data from canonical output fields", () => {
    const data = getCommandRenderData(
      makeCall({
        toolName: "Bash",
        input: {
          command: "sed -n 1,20p README.md"
        },
        output: {
          text: "# README\n\nhello\n",
          exitCode: 0
        }
      })
    );

    expect(data).toMatchObject({
      command: "sed -n 1,20p README.md",
      stdout: "# README\n\nhello\n",
      stderr: "",
      exitCode: 0,
      status: "completed"
    });
  });

  it("extracts projected ACP terminal command output", () => {
    const data = getCommandRenderData(
      makeCall({
        toolName: "Bash",
        input: {
          command:
            'tutti-cli agent active-peers 2>/dev/null || echo "no active peers"'
        },
        output: {
          status: "completed",
          text: '{\n  "schema_version": 1,\n  "ok": true,\n  "query": {\n    "kind": "active_peers"\n  }\n}',
          exitCode: 0
        }
      })
    );

    expect(data).toMatchObject({
      command:
        'tutti-cli agent active-peers 2>/dev/null || echo "no active peers"',
      stdout:
        '{\n  "schema_version": 1,\n  "ok": true,\n  "query": {\n    "kind": "active_peers"\n  }\n}',
      stderr: "",
      status: "completed"
    });
  });

  it("extracts projected ACP terminal room output", () => {
    const data = getCommandRenderData(
      makeCall({
        toolName: "Bash",
        input: {
          command:
            'tutti-cli agent active-peers --room-id room-123 2>/dev/null || echo "no active peers"'
        },
        output: {
          status: "completed",
          text: '{\n  "schema_version": 1,\n  "ok": true,\n  "query": {\n    "kind": "active_peers",\n    "room_id": "room-123"\n  }\n}',
          exitCode: 0
        }
      })
    );

    expect(data).toMatchObject({
      command:
        'tutti-cli agent active-peers --room-id room-123 2>/dev/null || echo "no active peers"',
      stdout:
        '{\n  "schema_version": 1,\n  "ok": true,\n  "query": {\n    "kind": "active_peers",\n    "room_id": "room-123"\n  }\n}',
      stderr: "",
      status: "completed"
    });
  });

  it("extracts durable search output from canonical text", () => {
    const data = getSearchRenderData(
      makeCall({
        toolName: "Grep",
        input: {
          pattern: "todo",
          path: "."
        },
        output: {
          text: "src/app.ts:12: todo item\nsrc/list.ts:8: todo list\n"
        }
      })
    );

    expect(data.output).toContain("src/app.ts:12: todo item");
    expect(data.mode).toBe("content");
  });

  it("extracts search output from the canonical text field", () => {
    const data = getSearchRenderData(
      makeCall({
        toolName: "Grep",
        input: { pattern: "canonical" },
        output: { text: "src/app.ts:12: canonical" }
      })
    );

    expect(data.output).toBe("src/app.ts:12: canonical");
    expect(data.mode).toBe("content");
  });

  it("prefers canonical error text over stdout", () => {
    const text = getToolFallbackText(
      makeCall({
        toolName: "Bash",
        status: "Failed",
        statusKind: "failed",
        error: {
          text: "permission denied\n",
          stdout: "fallback stdout\n"
        }
      })
    );

    expect(text.error).toBe("permission denied");
  });

  it("unwraps nested provider error envelopes", () => {
    const failure = getToolCallFailureText(
      makeCall({
        toolName: "McpTool",
        status: "Failed",
        statusKind: "failed",
        error: {
          response: {
            detail: {
              message: "MCP server rejected the request"
            }
          }
        }
      })
    );

    expect(failure).toBe("MCP server rejected the request");
  });

  it("joins structured error content arrays when no scalar error field exists", () => {
    const text = getToolFallbackText(
      makeCall({
        error: {
          content: [
            { type: "text", text: "first failure" },
            { type: "text", text: "second failure" }
          ]
        }
      })
    );

    expect(text.error).toBe("first failure\n\nsecond failure");
  });

  it("keeps nested search errors visible for specialized renderers", () => {
    const search = getSearchRenderData(
      makeCall({
        toolName: "Grep",
        error: {
          response: { detail: { message: "search backend unavailable" } }
        }
      })
    );

    expect(search.error).toBe("search backend unavailable");
  });

  it("keeps nested web-search errors visible for specialized renderers", () => {
    const search = getWebSearchRenderData(
      makeCall({
        toolName: "WebSearch",
        error: {
          response: { detail: { message: "search provider rejected request" } }
        }
      })
    );

    expect(search.error).toBe("search provider rejected request");
  });

  it("unwraps tool_use_error tags from failed write payloads", () => {
    const failure = getToolCallFailureText(
      makeCall({
        toolName: "Write",
        status: "Failed",
        statusKind: "failed",
        error: {
          message:
            "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>"
        }
      })
    );

    expect(failure).toBe(
      "File has not been read yet. Read it first before writing to it."
    );
  });

  it("falls back to failed output text when error payload is missing", () => {
    const failure = getToolCallFailureText(
      makeCall({
        toolName: "Write",
        status: "Failed",
        statusKind: "failed",
        output: {
          text: "<tool_use_error>Write blocked</tool_use_error>"
        }
      })
    );

    expect(failure).toBe("Write blocked");
  });

  it("extracts file changes from direct file content input", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        toolName: "Write",
        input: { file_path: "src/a.ts", content: "export const a = 1\n" }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        changeType: "created",
        language: "typescript",
        content: "export const a = 1"
      })
    ]);
  });

  it("extracts file changes from unified diff output", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        toolName: "Edit",
        output: {
          detailedContent:
            "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n"
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        changeType: "modified",
        added: 1,
        removed: 1
      })
    ]);
  });

  it("extracts OpenCode file changes from standard ACP output metadata", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        toolName: "Edit",
        output: {
          files: [
            {
              filePath: "/Users/local/session-1/index.html",
              patch:
                "--- a/index.html\n+++ b/index.html\n@@ -1 +1 @@\n-old\n+new\n"
            }
          ]
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "/Users/local/session-1/index.html",
        changeType: "modified",
        added: 1,
        removed: 1
      })
    ]);
  });

  it("extracts file changes from payload fileChanges metadata", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        payload: {
          fileChanges: {
            files: [{ path: "src/a.ts", change: "modified" }]
          }
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        changeType: "modified"
      })
    ]);
  });

  it("extracts unifiedDiff from payload fileChanges metadata", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        payload: {
          fileChanges: {
            files: [
              {
                path: "src/a.ts",
                change: "modified",
                unifiedDiff:
                  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n"
              }
            ]
          }
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        unifiedDiff: expect.stringContaining(
          "diff --git a/src/a.ts b/src/a.ts"
        ),
        added: 1,
        removed: 1
      })
    ]);
  });

  it("chooses a valid later diff alias over an invalid body", () => {
    const validDiff = "@@ -1 +1 @@\n-old\n+new";
    const changes = getFileChangeRenderData(
      makeCall({
        payload: {
          fileChanges: {
            files: [
              {
                path: "src/a.ts",
                change: "modified",
                diff: "README\n- bullet\n",
                unifiedDiff: validDiff
              }
            ]
          }
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        unifiedDiff: validDiff,
        added: 1,
        removed: 1
      })
    ]);
  });

  it("keeps an invalid created body as content instead of a patch", () => {
    const body = "# README\n\n- bullet\n- another bullet\n";
    const changes = getFileChangeRenderData(
      makeCall({
        payload: {
          fileChanges: {
            files: [{ path: "README.md", change: "created", diff: body }]
          }
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "README.md",
        changeType: "created",
        unifiedDiff: null,
        content: "# README\n\n- bullet\n- another bullet",
        added: 4,
        removed: 0
      })
    ]);
  });

  it("extracts file changes from structured patch output", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        output: {
          structuredPatch: [
            {
              filePath: "src/a.ts",
              diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n"
            }
          ]
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "src/a.ts",
        unifiedDiff: expect.stringContaining(
          "diff --git a/src/a.ts b/src/a.ts"
        ),
        added: 1,
        removed: 1
      })
    ]);
  });

  it("extracts file changes from ACP change maps for created files", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        toolName: "Edit",
        output: {
          changes: {
            "/workspace/note.txt": {
              type: "add",
              content: "hello from add\n"
            }
          }
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "/workspace/note.txt",
        changeType: "created",
        oldString: "",
        newString: "hello from add",
        added: 1,
        removed: 0
      })
    ]);
  });

  it("extracts file changes from Codex array-style changes", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        toolName: "Edit",
        input: {
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
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "/workspace/deck/slides/02-why-now.html",
        changeType: "created",
        language: "html"
      }),
      expect.objectContaining({
        path: "/workspace/deck/slides/01-cover.html",
        changeType: "modified",
        language: "html"
      })
    ]);
  });

  it("extracts file changes from ACP diff content blocks backed by change maps", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        toolName: "Edit",
        input: {
          changes: {
            "/workspace/note.txt": {
              type: "add",
              content: "hello from diff block\n"
            }
          }
        },
        content: [
          {
            type: "diff",
            path: "/workspace/note.txt",
            newText: "hello from diff block\n"
          }
        ]
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "/workspace/note.txt",
        changeType: "created",
        oldString: "",
        newString: "hello from diff block",
        added: 1
      })
    ]);
  });

  it("extracts projected ACP write changes", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        toolName: "Write",
        input: {
          kind: "write"
        },
        output: {
          changes: {
            "/workspace/today.txt": {
              type: "create",
              content: "2026-05-22\n"
            }
          }
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "/workspace/today.txt",
        changeType: "created",
        content: "2026-05-22",
        newString: "2026-05-22",
        added: 1,
        removed: 0
      })
    ]);
  });

  it("extracts file changes from raw diff output without an explicit input path", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        toolName: "Edit",
        output: {
          patch:
            "diff --git a/src/routes.ts b/src/routes.ts\n--- a/src/routes.ts\n+++ b/src/routes.ts\n@@ -1 +1 @@\n-const ready = false\n+const ready = true\n"
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "src/routes.ts",
        changeType: "modified",
        added: 1,
        removed: 1
      })
    ]);
  });

  it("extracts apply_patch delete file changes from change maps as removals", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        toolName: "apply_patch",
        output: {
          changes: {
            "a.md": {
              type: "delete",
              content: "aaaaa\n"
            }
          }
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "a.md",
        changeType: "deleted",
        content: null,
        oldString: "aaaaa",
        newString: "",
        added: 0,
        removed: 1,
        unifiedDiff: expect.stringContaining("deleted file mode 100644")
      })
    ]);
  });

  it("extracts apply_patch delete file changes from patch text as removals", () => {
    const changes = getFileChangeRenderData(
      makeCall({
        toolName: "apply_patch",
        output: {
          patch:
            "*** Begin Patch\n*** Delete File: a.md\n@@\n-aaaaa\n*** End Patch\n"
        }
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({
        path: "a.md",
        changeType: "deleted",
        added: 0,
        removed: 1
      })
    ]);
  });

  it("extracts web fetch url from canonical action input", () => {
    const web = getWebFetchRenderData(
      makeCall({
        toolName: "WebFetch",
        input: {
          action: {
            url: "https://example.com/story"
          }
        },
        output: {
          text: "Story body"
        }
      })
    );

    expect(web.url).toBe("https://example.com/story");
    expect(web.domain).toBe("example.com");
    expect(web.visibleContent).toBe("Story body");
  });

  it("extracts web fetch content from canonical output text without a URL", () => {
    const web = getWebFetchRenderData(
      makeCall({
        toolName: "WebFetch",
        output: { text: "Canonical page body" }
      })
    );

    expect(web.content).toBe("Canonical page body");
    expect(web.visibleContent).toBe("Canonical page body");
  });

  it("extracts projected ACP web fetch content", () => {
    const web = getWebFetchRenderData(
      makeCall({
        toolName: "WebFetch",
        input: {
          url: "https://dev.opencode.ai/"
        },
        output: {
          text: "Full fetched page body"
        }
      })
    );

    expect(web.url).toBe("https://dev.opencode.ai/");
    expect(web.content).toBe("Full fetched page body");
    expect(web.visibleContent).toBe("Full fetched page body");
  });

  it("extracts web fetch content from canonical output text", () => {
    const web = getWebFetchRenderData(
      makeCall({
        toolName: "WebFetch",
        input: { url: "https://example.com/story" },
        output: { text: "Canonical fetched page body" }
      })
    );

    expect(web.content).toBe("Canonical fetched page body");
    expect(web.visibleContent).toBe("Canonical fetched page body");
  });

  it("extracts search results from canonical locations and output text", () => {
    const search = getSearchRenderData(
      makeCall({
        toolName: "Grep",
        input: { pattern: "rendererKind" },
        locations: [
          { path: "src/agent.ts", line: 18 },
          { path: "src/tool.ts", line: 44 }
        ],
        output: {
          text: "src/agent.ts:18: rendererKind\nsrc/tool.ts:44: rendererKind"
        }
      })
    );

    expect(search.files).toEqual(["src/agent.ts", "src/tool.ts"]);
    expect(search.output).toContain("src/agent.ts:18: rendererKind");
  });

  it("treats canonical top-level locations without content as a list-files search result", () => {
    const search = getSearchRenderData(
      makeCall({
        toolName: "Glob",
        input: { glob: "src/**/*.ts" },
        locations: [{ path: "src/agent.ts" }, { path: "src/tool.ts" }]
      })
    );

    expect(search.mode).toBe("list_files");
    expect(search.files).toEqual(["src/agent.ts", "src/tool.ts"]);
  });

  it("extracts canonical multi-query web search inputs", () => {
    const web = getWebSearchRenderData(
      makeCall({
        toolName: "WebSearch",
        input: {
          search_query: ["today top news", "agent renderer parity"]
        }
      })
    );

    expect(web.query).toBe("today top news");
    expect(web.queries).toEqual(["today top news", "agent renderer parity"]);
  });

  it("extracts SDK web search output from canonical output text", () => {
    const web = getWebSearchRenderData(
      makeCall({
        toolName: "WebSearch",
        input: {
          query: "current weather in Tokyo Japan today"
        },
        output: {
          text: 'Web search results for query: "current weather in Tokyo Japan today"'
        }
      })
    );

    expect(web.output).toContain(
      'Web search results for query: "current weather in Tokyo Japan today"'
    );
  });

  it("extracts projected SDK web search output", () => {
    const web = getWebSearchRenderData(
      makeCall({
        toolName: "WebSearch",
        input: {
          query: "Tokyo weather now July 2026"
        },
        output: {
          text: 'Web search results for query: "Tokyo weather now July 2026"'
        }
      })
    );

    expect(web.output).toContain(
      'Web search results for query: "Tokyo weather now July 2026"'
    );
  });

  it("does not render task summary as output when output and error are missing", () => {
    const prompt =
      "Generate one random integer from 1 to 10 inclusive. Use your own randomness.";
    const data = getTaskRenderData(
      makeCall({
        toolName: "Agent",
        status: "failed",
        statusKind: "failed",
        summary: prompt,
        input: {
          prompt,
          task: prompt
        },
        output: null,
        error: null,
        task: {
          kind: "task",
          id: "call-1",
          turnId: "turn-1",
          title: prompt,
          status: "failed",
          prompt,
          delegateSessionId: null,
          steps: [],
          result: null,
          resultMarkdown: null,
          durationMs: null,
          occurredAtUnixMs: null
        }
      })
    );

    expect(data.prompt).toBe(prompt);
    expect(data.resultMarkdown).toBeNull();
    expect(data.errorMarkdown).toBeNull();
  });

  it("renders task failures from error payloads instead of output", () => {
    const data = getTaskRenderData(
      makeCall({
        toolName: "Agent",
        status: "failed",
        statusKind: "failed",
        input: {
          prompt: "Generate one random integer."
        },
        output: null,
        error: {
          message: "collab spawn failed: agent thread limit reached"
        },
        task: {
          kind: "task",
          id: "call-1",
          turnId: "turn-1",
          title: "Agent",
          status: "failed",
          prompt: "Generate one random integer.",
          delegateSessionId: null,
          steps: [],
          result: null,
          resultMarkdown: null,
          durationMs: null,
          occurredAtUnixMs: null
        }
      })
    );

    expect(data.resultMarkdown).toBeNull();
    expect(data.errorMarkdown).toBe(
      "collab spawn failed: agent thread limit reached"
    );
  });

  it("extracts canonical skill render data", () => {
    const skill = getSkillRenderData(
      makeCall({
        toolName: "Skill",
        input: {
          skill: "init",
          args: "帮我写一个 todo-list"
        },
        output: {
          commandName: "init",
          success: true
        }
      })
    );

    expect(skill).toEqual({
      skill: "init",
      args: "帮我写一个 todo-list",
      success: true,
      statusText: "Skill loaded"
    });
  });

  it("renders canonical skill failures", () => {
    const skill = getSkillRenderData(
      makeCall({
        toolName: "Skill",
        input: {
          skill: "init"
        },
        output: {
          commandName: "init",
          success: false
        }
      })
    );

    expect(skill).toEqual({
      skill: "init",
      args: null,
      success: false,
      statusText: "Failed to load skill"
    });
  });
});

function makeCall(
  overrides: Partial<AgentToolCallVM> & Record<string, unknown>
): AgentToolCallVM {
  return {
    kind: "tool-call",
    id: "call:1",
    turnId: "turn-1",
    name: "Tool",
    toolName: "Tool",
    callType: "tool",
    status: "Completed",
    statusKind: "completed",
    summary: "",
    compactSummary: null,
    payload: null,
    input: null,
    output: null,
    error: null,
    metadata: null,
    locations: null,
    rendererKind: "default",
    approval: null,
    planMode: null,
    askUserQuestion: null,
    task: null,
    occurredAtUnixMs: null,
    ...overrides
  };
}
