import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../../../i18n/testUtils";
import { type WorkspaceAgentSessionDetailToolCall } from "../../../workspaceAgentSessionDetailViewModel";
import { projectAgentToolCall } from "../../projection/agentToolProjection";
import { AgentExpandedToolContent } from "./AgentExpandedToolContent";
import { ToolMarkdownBlock } from "./agentToolContentShared";

describe("AgentExpandedToolContent", () => {
  afterEach(async () => {
    setAgentGuiI18nTestLocale("zh-CN");
  });

  it("does not render inline approval options without a file preview payload", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            callType: "approval",
            toolName: "Approval",
            payload: {
              input: {
                options: [
                  {
                    id: "allow_once",
                    label: "Allow once",
                    description: "Only for this call"
                  }
                ]
              }
            }
          })
        )}
      />
    );

    expect(screen.queryByText("Approval options")).toBeNull();
    expect(screen.queryByText("Allow once")).toBeNull();
    expect(screen.queryByText("Only for this call")).toBeNull();
  });

  it("renders approval file previews from nested toolCall edit payloads", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            callType: "approval",
            toolName: "Approval",
            status: "Completed",
            statusKind: "completed",
            payload: {
              input: {
                options: [{ id: "allow_once", label: "Allow once" }],
                toolCall: {
                  kind: "edit",
                  title: "Edit /workspace/note.txt",
                  status: "pending",
                  rawInput: {
                    changes: {
                      "/workspace/note.txt": {
                        type: "add",
                        content: "hello from approval preview\n"
                      }
                    }
                  },
                  content: [
                    {
                      type: "diff",
                      path: "/workspace/note.txt",
                      newText: "hello from approval preview\n"
                    }
                  ],
                  locations: [{ path: "/workspace/note.txt" }]
                }
              }
            }
          })
        )}
      />
    );

    expect(screen.queryByText("Approval options")).toBeNull();
    expect(screen.getByText("note.txt")).toBeTruthy();
    expect(screen.getByText("hello from approval preview")).toBeTruthy();
    expect(screen.queryByText("Allow once")).toBeNull();
  });

  it("renders ask-user options and selected answer from the typed ask-user vm", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            callType: "interactive",
            toolName: "AskUserQuestion",
            payload: {
              input: {
                questions: [
                  {
                    id: "approach",
                    question: "Which implementation path should we take?",
                    options: [
                      {
                        label: "Keep the shared renderer",
                        description:
                          "Add typed tool bodies on top of the existing shell."
                      }
                    ]
                  }
                ]
              },
              output: {
                answersByQuestionId: {
                  approach: "Keep the shared renderer"
                }
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Questions")).toBeTruthy();
    expect(
      screen.getByText("Which implementation path should we take?")
    ).toBeTruthy();
    expect(screen.getByText("Keep the shared renderer")).toBeTruthy();
    expect(
      screen.getByText("Add typed tool bodies on top of the existing shell.")
    ).toBeTruthy();
    expect(screen.getByText("Answer: Keep the shared renderer")).toBeTruthy();
  });

  it("renders task steps through the new task renderer path", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Task",
            callType: "subagent",
            payload: {
              metadata: {
                steps: [
                  {
                    toolUseId: "step-read",
                    toolName: "Read",
                    status: "Completed",
                    toolInput: { path: "/workspace/src/agent.ts" },
                    toolResult: { text: "Loaded agent conversation contract." }
                  }
                ]
              }
            }
          })
        )}
      />
    );

    const stepButton = screen.getByRole("button", { name: /Read.*Completed/i });
    fireEvent.click(stepButton);
    await flushCollapsibleRevealFrames();

    const pathLabel = screen.getByTitle("/workspace/src/agent.ts");
    expect(
      pathLabel.querySelector(".agent-path-tail-label__directory")?.textContent
    ).toBe("/workspace/src/");
    expect(
      pathLabel.querySelector(".agent-path-tail-label__file")?.textContent
    ).toBe("agent.ts");
    expect(
      screen.getAllByText("Loaded agent conversation contract.").length
    ).toBeGreaterThan(0);
  });

  it("renders ask-user task steps through the shared renderer matrix", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Task",
            callType: "subagent",
            payload: {
              metadata: {
                steps: [
                  {
                    toolUseId: "step-ask",
                    toolName: "AskUserQuestion",
                    status: "Waiting",
                    toolInput: {
                      questions: [
                        {
                          id: "q1",
                          header: "Choice",
                          question: "Which renderer should we use?",
                          options: [
                            {
                              label: "Shared renderer",
                              description:
                                "Use the canonical tool renderer path."
                            }
                          ]
                        }
                      ]
                    },
                    toolResult: {
                      answersByQuestionId: {
                        q1: "Shared renderer"
                      }
                    }
                  }
                ]
              }
            }
          })
        )}
      />
    );

    const stepButton = screen.getByRole("button", {
      name: /Ask User Question.*Waiting/i
    });
    fireEvent.click(stepButton);
    await flushCollapsibleRevealFrames();

    expect(screen.getByText("Questions")).toBeTruthy();
    expect(screen.getByText("Which renderer should we use?")).toBeTruthy();
    expect(screen.getByText("Shared renderer")).toBeTruthy();
    expect(screen.getByText("Answer: Shared renderer")).toBeTruthy();
  });

  it("renders read tool body from typed tool vm", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Read",
            payload: {
              input: { path: "/workspace/src/app.ts" },
              output: { text: "const app = true" }
            }
          })
        )}
      />
    );

    const pathLabel = screen.getByTitle("/workspace/src/app.ts");
    expect(
      pathLabel.querySelector(".agent-path-tail-label__directory")?.textContent
    ).toBe("/workspace/src/");
    expect(
      pathLabel.querySelector(".agent-path-tail-label__file")?.textContent
    ).toBe("app.ts");
    expect(screen.getByText(/typescript/i)).toBeTruthy();
    expect(screen.getByText(/1 lines/i)).toBeTruthy();
    expect(screen.getByText("const app = true")).toBeTruthy();
  });

  it("renders structured read metadata without dumping full file content by default", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Read",
            payload: {
              input: { path: "/workspace/src/app.ts" },
              output: {
                file: { startLine: 2, numLines: 3, totalLines: 10 }
              }
            }
          })
        )}
      />
    );

    const pathLabel = screen.getByTitle("/workspace/src/app.ts");
    expect(
      pathLabel.querySelector(".agent-path-tail-label__directory")?.textContent
    ).toBe("/workspace/src/");
    expect(
      pathLabel.querySelector(".agent-path-tail-label__file")?.textContent
    ).toBe("app.ts");
    expect(screen.getByText(/L2-4/i)).toBeTruthy();
    expect(screen.getByText(/10 lines/i)).toBeTruthy();
    expect(screen.queryByText("const app = true")).toBeNull();
  });

  it("renders write tool content as a simplified code block", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Write",
            payload: {
              input: {
                file_path: "/workspace/src/routes.ts",
                content: "export const routes = []\n"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("export const routes = []")).toBeTruthy();
  });

  it("renders a write-created file only once when both content and synthetic diff are present", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Write",
            payload: {
              output: {
                changes: {
                  "/workspace/src/plan.md": {
                    type: "add",
                    content: "# Plan\nFirst line\n"
                  }
                }
              }
            }
          })
        )}
      />
    );

    expect(screen.getAllByText("First line")).toHaveLength(1);
  });

  it("renders multiple write patches as separate file cards", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Write",
            payload: {
              output: {
                structuredPatch: [
                  {
                    filePath: "src/routes.ts",
                    kind: "add",
                    newString: "export const routes = []"
                  },
                  {
                    filePath: "src/app.ts",
                    diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const ready = false\n+const ready = true\n"
                  }
                ]
              }
            }
          })
        )}
      />
    );

    expect(screen.queryByText("Content")).toBeNull();
    expect(screen.getByText("app.ts")).toBeTruthy();
    expect(screen.getByText("routes.ts")).toBeTruthy();
    expect(screen.getByText("export const routes = []")).toBeTruthy();
    expect(screen.getByText("const ready = true")).toBeTruthy();
  });

  it("renders edit unified diff output through the patch viewer", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Edit",
            payload: {
              output: {
                detailedContent:
                  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const ready = false\n+const ready = true\n"
              }
            }
          })
        )}
      />
    );

    expect(screen.queryByText("Patch")).toBeNull();
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByText("const ready = false")).toBeTruthy();
    expect(screen.getByText("const ready = true")).toBeTruthy();
    expect(
      screen.getByText("const ready = true").closest(".grid")?.className
    ).toContain("agent-tool-diff__line");
    expect(
      screen.getByText("const ready = true").closest(".grid")?.className
    ).toContain("border-l-[var(--state-success)]");
    expect(
      screen.getByText("const ready = false").closest(".grid")?.className
    ).toContain("border-l-[var(--state-danger)]");
  });

  it("renders edit old/new string pairs through the patch viewer path", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Edit",
            payload: {
              input: {
                file_path: "/workspace/src/app.ts",
                old_string: "const ready = false",
                new_string: "const ready = true"
              }
            }
          })
        )}
      />
    );

    expect(screen.queryByText("Patch")).toBeNull();
    expect(screen.getByText("app.ts")).toBeTruthy();
    expect(screen.getByText("const ready = false")).toBeTruthy();
    expect(screen.getByText("const ready = true")).toBeTruthy();
  });

  it("renders canonical bash calls through the bash renderer without raw JSON fallback", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Bash",
            status: "Failed",
            statusKind: "failed",
            payload: {
              input: {
                command: "pwd",
                cwd: "/workspace/app"
              },
              output: {
                stdout: "/workspace/app\n",
                stderr: "permission denied\n",
                exit_code: 127,
                duration_ms: 42
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("pwd")).toBeTruthy();
    expect(screen.getByText(/\/workspace\/app/)).toBeTruthy();
    expect(screen.getByText(/permission denied/)).toBeTruthy();
    expect(screen.queryByText("Path")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
    expect(screen.queryByText("exit 127")).toBeNull();
    expect(screen.queryByText("42 ms")).toBeNull();
    expect(screen.queryByText("failed")).toBeNull();
    expect(screen.queryByText(/call-pwd|command/)).toBeNull();
  });

  it("renders canonical failed search calls through the search renderer without raw JSON fallback", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Grep",
            status: "Failed",
            statusKind: "failed",
            summary: "ls -la",
            payload: {
              input: {
                pattern: "ls -la"
              },
              error: {
                stdout: "missing-tool: not found\n",
                exit_code: 127
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText(/missing-tool: not found/)).toBeTruthy();
    expect(screen.queryByText(/call-list/)).toBeNull();
  });

  it("renders structured search file lists and no-match states", async () => {
    setAgentGuiI18nTestLocale("en");

    const { rerender } = render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Grep",
            payload: {
              input: {
                pattern: "ready",
                path: "/workspace/src"
              },
              output: {
                mode: "files_with_matches",
                filenames: ["src/app.ts", "src/routes.ts"]
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Results")).toBeTruthy();
    expect(screen.getByText("src/app.ts")).toBeTruthy();
    expect(screen.getByText("src/routes.ts")).toBeTruthy();
    expect(screen.queryByText("Raw payload")).toBeNull();

    rerender(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Glob",
            payload: {
              input: {
                glob: "**/*.md"
              },
              output: {
                mode: "list_files",
                content: ""
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("renders structured search content and count modes", async () => {
    setAgentGuiI18nTestLocale("en");

    const { rerender } = render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Grep",
            payload: {
              input: {
                pattern: "ready"
              },
              output: {
                mode: "content",
                content: "src/app.ts:42: const ready = true"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("src/app.ts:42: const ready = true")).toBeTruthy();

    rerender(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Grep",
            payload: {
              input: {
                pattern: "ready"
              },
              output: {
                mode: "count",
                content: "3"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("3")).toBeTruthy();
  });

  it("renders web search results from stdout link payloads", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebSearch",
            payload: {
              input: {
                query: "agent renderer parity"
              },
              output: {
                stdout:
                  'Links: [{"title":"Renderer guide","url":"https://example.com/docs/renderer"}]\\n\\nSummary **markdown**'
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("agent renderer parity")).toBeTruthy();
    expect(screen.getByText(/example\.com/)).toBeTruthy();
    expect(screen.getByText("Renderer guide")).toBeTruthy();
    expect(screen.getByText(/Summary/)).toBeTruthy();
  });

  it("renders canonical multi-query web search inputs from search_query", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebSearch",
            payload: {
              input: {
                search_query: ["today top news", "agent renderer parity"]
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText(/today top news/)).toBeTruthy();
    expect(screen.getByText(/agent renderer parity/)).toBeTruthy();
    expect(screen.queryByText("Results")).toBeNull();
  });

  it("renders the query when web search carries no results payload", async () => {
    setAgentGuiI18nTestLocale("en");

    // Mirrors the Codex daemon path (codex_appserver_events.go): web search
    // events carry only the query under input, never an output/results payload.
    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebSearch",
            payload: {
              input: {
                query: "agent renderer parity",
                action: { type: "search", query: "agent renderer parity" }
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("agent renderer parity")).toBeTruthy();
  });

  it("does not mirror a web search query into results or output", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebSearch",
            summary: "agent renderer parity",
            payload: {
              input: {
                query: "agent renderer parity",
                action: { type: "search", query: "agent renderer parity" }
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Query")).toBeTruthy();
    expect(screen.getByText("agent renderer parity")).toBeTruthy();
    expect(screen.queryByText("Results")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("does not render an empty body when web search has no results", async () => {
    setAgentGuiI18nTestLocale("en");

    const { container } = render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebSearch",
            payload: { input: {}, output: {} }
          })
        )}
      />
    );

    expect(
      container.querySelector(
        ".workspace-agents-status-panel__detail-tool-body"
      )
    ).toBeNull();
  });

  it("dedupes repeated default tool input and output sections", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "CustomTool",
            payload: {
              input: {
                query: "same content"
              },
              output: {
                output: "same content"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("same content")).toBeTruthy();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("renders web fetch content with truncation notice", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebFetch",
            payload: {
              input: {
                url: "https://docs.example.com/very/long/page"
              },
              output: {
                content: `# Title\n\n${"a".repeat(3200)}`
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("docs.example.com")).toBeTruthy();
    expect(screen.getByText("Content truncated")).toBeTruthy();
  });

  it("does not mirror a web fetch domain summary into content", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebFetch",
            summary: "forecast.weather.gov",
            payload: {
              input: {
                url: "https://forecast.weather.gov/zipcity.php?inputstring=10002"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("URL")).toBeTruthy();
    expect(
      screen.getAllByText(/forecast\.weather\.gov/).length
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Content")).toBeNull();
  });

  it("falls back to structured error content when a failed typed renderer has no body", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebFetch",
            status: "Failed",
            statusKind: "failed",
            payload: {
              error: {
                message: "network request failed"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Error")).toBeTruthy();
    expect(screen.getByText("network request failed")).toBeTruthy();
  });

  it("keeps real web fetch page content", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebFetch",
            summary: "forecast.weather.gov",
            payload: {
              input: {
                url: "https://forecast.weather.gov/zipcity.php?inputstring=10002"
              },
              output: {
                content:
                  "Detailed Forecast\n\nWednesday: Sunny, with a high near 82."
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Content")).toBeTruthy();
    expect(screen.getByText(/Detailed Forecast/)).toBeTruthy();
  });

  it("renders todo items with semantic statuses instead of raw json", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "TodoWrite",
            payload: {
              input: {
                todos: [
                  { content: "Ship renderer parity", status: "completed" },
                  { content: "Run smoke test", status: "in_progress" },
                  { content: "Polish fallback UI", status: "pending" }
                ]
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Ship renderer parity")).toBeTruthy();
    expect(screen.getByText("Run smoke test")).toBeTruthy();
    expect(screen.getByText("Polish fallback UI")).toBeTruthy();
    expect(screen.queryByText(/"todos"|rawInput/)).toBeNull();
  });

  it("renders tool search, skill, and plan parity details", async () => {
    setAgentGuiI18nTestLocale("en");

    const { rerender } = render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "ToolSearch",
            payload: {
              input: {
                query: "select:read_file"
              },
              output: {
                matches: ["read_file"],
                total_deferred_tools: 12
              }
            }
          })
        )}
      />
    );

    expect(screen.getAllByText("read_file").length).toBeGreaterThan(0);
    expect(screen.getByText("direct")).toBeTruthy();
    expect(screen.getByText("1 loaded · 12 available")).toBeTruthy();

    rerender(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Skill",
            payload: {
              input: {
                skill: "openai-docs",
                args: "latest-models"
              },
              output: {
                success: false,
                commandName: "openai-docs"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("openai-docs")).toBeTruthy();
    expect(screen.getByText("Failed to load skill")).toBeTruthy();

    rerender(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "ExitPlanMode",
            callType: "interactive",
            payload: {
              input: {
                filePath: "/workspace/plans/renderer.md",
                plan: "1. Normalize payloads\\n2. Render typed views"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("renderer.md")).toBeTruthy();
    expect(screen.getByText(/Normalize payloads/)).toBeTruthy();
  });

  it("renders MCP results from structured objects, json strings, text blocks, and stdout fallback", async () => {
    setAgentGuiI18nTestLocale("en");

    const { rerender } = render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "mcp__Atlassian__searchJiraIssuesUsingJql",
            callType: "mcp",
            payload: {
              metadata: {
                server: "Atlassian",
                toolName: "searchJiraIssuesUsingJql"
              },
              output: {
                structuredContent: {
                  issues: [{ key: "ENG-42", summary: "Fix renderer parity" }]
                }
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("ENG-42")).toBeTruthy();
    expect(screen.getByText("Fix renderer parity")).toBeTruthy();

    rerender(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "mcp__context7__queryDocs",
            callType: "mcp",
            payload: {
              metadata: {
                server: "context7",
                toolName: "queryDocs"
              },
              output: {
                content: JSON.stringify({
                  docs: [
                    { title: "Renderer docs", description: "Detailed guide" }
                  ]
                })
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Renderer docs")).toBeTruthy();
    expect(screen.getByText("Detailed guide")).toBeTruthy();

    rerender(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "mcp__filesystem__read_file",
            callType: "mcp",
            payload: {
              metadata: {
                server: "filesystem",
                toolName: "read_file"
              },
              output: {
                content: [{ text: "Loaded docs chunk" }]
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Loaded docs chunk")).toBeTruthy();

    rerender(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "mcp__filesystem__read_file",
            callType: "mcp",
            payload: {
              metadata: {
                server: "filesystem",
                toolName: "read_file"
              },
              output: {
                stdout: "Plain stdout fallback"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Plain stdout fallback")).toBeTruthy();

    rerender(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "mcp__filesystem__read_file",
            callType: "mcp",
            payload: {
              metadata: {
                server: "filesystem",
                toolName: "read_file"
              },
              output: {
                output: "Nested output fallback"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Nested output fallback")).toBeTruthy();
  });

  it("moves unknown structured payloads behind an explicit raw payload section", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "CurrentTask",
            payload: {
              input: {
                nested: {
                  noisy: true
                }
              }
            }
          })
        )}
      />
    );

    const rawPayloadToggle = screen.getByRole("button", {
      name: "Raw payload"
    });
    expect(rawPayloadToggle).toHaveAttribute("aria-expanded", "false");
    expect(rawPayloadToggle.firstElementChild).toHaveTextContent("Raw payload");
    expect(rawPayloadToggle.querySelector("svg")).toHaveClass("opacity-0");
    expect(rawPayloadToggle.querySelector("svg")).toHaveClass(
      "group-hover/raw-payload:opacity-100"
    );
    expect(screen.queryByText(/"noisy": true/)).toBeNull();
    fireEvent.click(rawPayloadToggle);
    await flushCollapsibleRevealFrames();
    expect(rawPayloadToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/"noisy": true/).closest("pre")).toHaveClass(
      "workspace-agents-status-panel__detail-scroll-region"
    );
    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("renders collapsible tool markdown lists with secondary text color", () => {
    const { container } = render(
      <ToolMarkdownBlock
        content={"- **output:** ./hello-world/README.md\n\n1. exit_code: 0"}
        collapsible
      />
    );

    const markdown = container.querySelector(
      '[data-workspace-agent-markdown="true"]'
    );
    expect(markdown?.className).toContain(
      "[&_ul]:text-[var(--text-secondary)]"
    );
    expect(markdown?.className).toContain(
      "[&_ol]:text-[var(--text-secondary)]"
    );
  });

  it("routes nested task steps through the mcp renderer when metadata identifies an mcp tool", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Task",
            callType: "subagent",
            payload: {
              metadata: {
                steps: [
                  {
                    toolUseId: "step-mcp",
                    toolName: "custom_tool",
                    status: "Completed",
                    toolInput: { query: "renderer parity" },
                    toolResult: { stdout: "Found issue TSH-123" },
                    metadata: {
                      server: "Atlassian"
                    }
                  }
                ]
              }
            }
          })
        )}
      />
    );

    const stepButton = screen.getByRole("button", {
      name: /Custom Tool.*Completed/i
    });
    fireEvent.click(stepButton);
    await flushCollapsibleRevealFrames();

    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.getByText(/Server: Atlassian/i)).toBeTruthy();
    expect(screen.getByText("Found issue TSH-123")).toBeTruthy();
  });

  it("routes nested task steps through the mcp renderer when callType is explicitly mcp", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExpandedToolContent
        call={projectAgentToolCall(
          toolCall({
            toolName: "Task",
            callType: "subagent",
            payload: {
              metadata: {
                steps: [
                  {
                    toolUseId: "step-mcp-calltype",
                    toolName: "custom_tool",
                    callType: "mcp",
                    status: "Completed",
                    toolResult: { stdout: "Found issue TSH-456" }
                  }
                ]
              }
            }
          })
        )}
      />
    );

    const stepButton = screen.getByRole("button", {
      name: /Custom Tool.*Completed/i
    });
    fireEvent.click(stepButton);
    await flushCollapsibleRevealFrames();

    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.getByText("Found issue TSH-456")).toBeTruthy();
  });
});

async function flushCollapsibleRevealFrames(): Promise<void> {
  await flushAnimationFrame();
  await flushAnimationFrame();
}

async function flushAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function toolCall(
  overrides: Partial<WorkspaceAgentSessionDetailToolCall> = {}
): WorkspaceAgentSessionDetailToolCall {
  return {
    id: "call-1",
    name: "Use tool",
    toolName: null,
    callType: "tool",
    status: "Completed",
    statusKind: "completed",
    summary: "",
    payload: null,
    ...overrides
  };
}
