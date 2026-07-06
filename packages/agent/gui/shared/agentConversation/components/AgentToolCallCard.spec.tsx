import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAgentGuiI18nTestLocale } from "../../../i18n/testUtils";
import type { WorkspaceAgentSessionDetailToolCall } from "../../workspaceAgentSessionDetailViewModel";
import { projectAgentToolCall } from "../projection/agentToolProjection";
import { AgentAskUserQuestionCard } from "./AgentAskUserQuestionCard";
import { AgentEnterPlanModeCard } from "./AgentEnterPlanModeCard";
import { AgentExitPlanModeCard } from "./AgentExitPlanModeCard";
import { AgentTaskCallCard } from "./AgentTaskCallCard";
import { AgentToolCallCard } from "./AgentToolCallCard";

describe("Agent specialized tool cards", () => {
  afterEach(async () => {
    setAgentGuiI18nTestLocale("zh-CN");
  });

  it("expands waiting ask-user cards by default", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentAskUserQuestionCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "AskUserQuestion",
            callType: "interactive",
            status: "waiting_input",
            payload: {
              input: {
                questions: [
                  {
                    id: "scope",
                    question: "Which scope should we use?",
                    options: [
                      { label: "Typed renderer", description: "Keep going" }
                    ]
                  }
                ]
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Questions")).toBeTruthy();
    expect(screen.getByText("Which scope should we use?")).toBeTruthy();
    expect(screen.queryByRole("button", { expanded: true })).toBeNull();
  });

  it("renders enter-plan cards as always-visible detail blocks", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentEnterPlanModeCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "EnterPlanMode",
            callType: "interactive",
            payload: {
              input: {
                content: "Exploring codebase and planning the renderer rewrite."
              }
            }
          })
        )}
      />
    );

    expect(
      screen.getByText("Exploring codebase and planning the renderer rewrite.")
    ).toBeTruthy();
    expect(screen.queryByRole("button", { expanded: true })).toBeNull();
  });

  it("renders exit-plan cards as always-visible detail blocks", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentExitPlanModeCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "ExitPlanMode",
            callType: "interactive",
            payload: {
              input: {
                plan: "1. Finalize the projection layer\\n2. Wire the shared renderer"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText(/Finalize the projection layer/)).toBeTruthy();
    expect(screen.queryByRole("button", { expanded: true })).toBeNull();
  });

  it("renders running task cards as always-visible detail blocks", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentTaskCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "Task",
            callType: "subagent",
            status: "running",
            payload: {
              metadata: {
                status: "running",
                steps: [
                  {
                    toolUseId: "step-1",
                    toolName: "Read",
                    status: "Completed",
                    toolInput: { path: "/workspace/demo/src/App.tsx" },
                    toolResult: { text: "loaded" }
                  }
                ]
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("Steps")).toBeTruthy();
    expect(screen.queryByRole("button", { expanded: true })).toBeNull();
  });

  it("shows failed task status and fallback error when provider omits details", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentTaskCallCard
        defaultExpanded
        call={projectAgentToolCall(
          toolCall({
            name: "Agent",
            toolName: "Agent",
            callType: "tool",
            status: "Failed",
            statusKind: null,
            summary:
              "Generate exactly one random integer from 1 to 10 inclusive.",
            payload: {
              input: {
                prompt:
                  "Generate exactly one random integer from 1 to 10 inclusive."
              }
            }
          })
        )}
      />
    );

    expect(
      screen.getByRole("button", { name: /Agent Failed Generate exactly/i })
    ).toBeTruthy();
    expect(screen.getAllByText(/Failed/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Error")).toBeTruthy();
    expect(
      screen.getByText("The provider reported failure without details.")
    ).toBeTruthy();
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("keeps task step output hidden until the step expands", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentTaskCallCard
        defaultExpanded
        call={projectAgentToolCall(
          toolCall({
            toolName: "Task",
            callType: "subagent",
            status: "completed",
            payload: {
              output: {
                steps: [
                  {
                    toolUseId: "step-1",
                    toolName: "Read",
                    status: "Completed",
                    toolInput: { path: "/workspace/demo/README.md" },
                    toolResult: { output: "Loaded docs chunk" }
                  }
                ]
              }
            }
          })
        )}
      />
    );

    expect(screen.queryByText("Loaded docs chunk")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Read Completed/i }));

    expect(screen.getByText("Loaded docs chunk")).toBeTruthy();
  });

  it("shows diff stats in the tool call header for structured edit patches", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "Edit",
            payload: {
              output: {
                structuredPatch: [
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

    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
  });

  it("does not show edit diff stats on approval tool headers", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            name: "Approval",
            toolName: "Approval",
            callType: "approval",
            status: "Completed",
            statusKind: "completed",
            payload: {
              input: {
                toolCall: {
                  input: {
                    file_path: "/workspace/generated.md",
                    old_string: "const ready = false",
                    new_string: "const ready = true"
                  },
                  name: "Edit",
                  title: "Edit",
                  toolName: "Edit"
                }
              }
            }
          })
        )}
      />
    );

    expect(screen.queryByText("+1")).toBeNull();
    expect(screen.queryByText("-1")).toBeNull();
  });

  it("renders tool header icons at the shared 16px size", async () => {
    setAgentGuiI18nTestLocale("en");

    const { container } = render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "CustomTool",
            name: "Use tool"
          })
        )}
      />
    );

    const icon = container.querySelector(
      ".workspace-agents-status-panel__detail-tool-row-icon svg"
    );

    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
  });

  it("uses explicit MCP target fields as the approval-wrapped tool title", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            name: "Approval",
            toolName: "Approval",
            callType: "tool",
            status: "Failed",
            statusKind: "failed",
            payload: {
              input: {
                requestId: "request-1",
                server: "playwright",
                tool: "browser_close",
                options: [{ optionId: "approved", name: "Allow" }]
              },
              error: {
                stdout: "Browser is already in use"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("playwright / browser_close")).toBeTruthy();
    expect(screen.queryByText("Approval")).toBeNull();
  });

  it("uses the shared tools icon for completed tool calls", async () => {
    setAgentGuiI18nTestLocale("en");

    const { container } = render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "CustomTool",
            name: "Use tool"
          })
        )}
      />
    );

    const icon = container.querySelector(
      ".workspace-agents-status-panel__detail-tool-row-icon svg"
    );
    expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon?.querySelector("path")?.getAttribute("d")).toContain(
      "M12.5166 2"
    );
  });

  it("uses the document icon for completed read file calls", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "read_file",
            name: "Read file",
            status: "Completed",
            statusKind: "completed"
          })
        )}
      />
    );

    const icon = screen.getByTestId("agent-tool-read-icon");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon.querySelector("path")?.getAttribute("d")).toContain(
      "M14.04 1.00098"
    );
  });

  it("uses the file text loading icon for active read file calls", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "read_file",
            name: "Read file",
            status: "Running",
            statusKind: "working"
          })
        )}
      />
    );

    const icon = screen.getByTestId("agent-tool-read-loading-icon");
    expect(icon.querySelector("svg")).toHaveAttribute("width", "16");
    expect(icon.querySelector("svg")).toHaveAttribute("height", "16");
  });

  it("uses the file text loading icon for active edit calls", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "Edit",
            name: "Edit file",
            status: "Running",
            statusKind: "working"
          })
        )}
      />
    );

    const icon = screen.getByTestId("agent-tool-edit-loading-icon");
    expect(icon.querySelector("svg")).toHaveAttribute("width", "16");
    expect(icon.querySelector("svg")).toHaveAttribute("height", "16");
  });

  it("uses the file pen loading icon for active write calls", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "Write",
            name: "Write file",
            status: "Running",
            statusKind: "working"
          })
        )}
      />
    );

    const icon = screen.getByTestId("agent-tool-write-loading-icon");
    expect(icon.querySelector("svg")).toHaveAttribute("width", "16");
    expect(icon.querySelector("svg")).toHaveAttribute("height", "16");
  });

  it("keeps the write-lined icon for active write stdin calls", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "write_stdin",
            name: "Write Stdin",
            status: "Running",
            statusKind: "working"
          })
        )}
      />
    );

    const icon = screen.getByTestId("agent-tool-stdin-write-icon");
    expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon.querySelector("path")?.getAttribute("d")).toContain(
      "M19.1816 1"
    );
  });

  it("uses the network icon for active web tool calls", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebFetch",
            name: "Fetch webpage",
            status: "Running",
            statusKind: "working"
          })
        )}
      />
    );

    const icon = screen.getByTestId("agent-tool-web-loading-icon");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon.querySelector("path")?.getAttribute("d")).toContain("M12 1");
  });

  it("uses the network icon for completed web tool calls", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "WebFetch",
            name: "Fetch webpage",
            status: "Completed",
            statusKind: "completed"
          })
        )}
      />
    );

    const icon = screen.getByTestId("agent-tool-web-icon");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon.querySelector("path")?.getAttribute("d")).toContain("M12 1");
  });

  it("uses the image generation icon for active image generation calls", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "image_generation",
            name: "Image Generation",
            status: "Running",
            statusKind: "working"
          })
        )}
      />
    );

    const icon = screen.getByTestId("agent-tool-image-generation-loading-icon");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon.querySelector("path")?.getAttribute("d")).toContain(
      "M14.04 1.00098"
    );
    expect(screen.getByText("Image generation")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("uses the image generation icon when only the display name identifies the tool", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: null,
            name: "Image Generation",
            status: "Completed",
            statusKind: "completed"
          })
        )}
      />
    );

    const icon = screen.getByTestId("agent-tool-image-generation-icon");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon.querySelector("path")?.getAttribute("d")).toContain(
      "M14.04 1.00098"
    );
    expect(screen.getByText("Image generation")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
  });

  it("renders image generation prompt and preview output", async () => {
    setAgentGuiI18nTestLocale("en");
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tool-image-preview")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentToolCallCard
        defaultExpanded
        call={projectAgentToolCall(
          toolCall({
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
          })
        )}
      />
    );

    expect(screen.getByText(/Revised prompt:/)).toBeTruthy();
    expect(
      await screen.findByRole("img", { name: "Image generation preview" })
    ).toHaveAttribute("src", "blob:tool-image-preview");
    expect(screen.getByText("Output")).toBeTruthy();
    expect(readFile).toHaveBeenCalledWith({
      path: "/workspace/output/generated.png"
    });
  });

  it("does not show an output loading placeholder for active image generation cards", async () => {
    setAgentGuiI18nTestLocale("en");
    const readFile = vi
      .fn()
      .mockRejectedValue(new Error("ENOENT: generated image not ready"));
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;

    render(
      <AgentToolCallCard
        defaultExpanded
        call={projectAgentToolCall(
          toolCall({
            toolName: "ig_05eb62dbe723c910016a1336ad3de881919216a6f64051a5e2",
            name: "ig_05eb62dbe723c910016a1336ad3de881919216a6f64051a5e2",
            status: "Running",
            statusKind: "working",
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
          })
        )}
      />
    );

    expect(screen.getByText(/Revised prompt:/)).toBeTruthy();
    expect(screen.queryByText("Loading preview...")).toBeNull();
    expect(
      screen.queryByRole("img", { name: "Image generation preview" })
    ).toBeNull();
    await waitFor(() => {
      expect(readFile).toHaveBeenCalledWith({
        path: "/workspace/output/generated.png"
      });
    });
  });

  it("renders image generation preview even when the tool output has no prompt text", async () => {
    setAgentGuiI18nTestLocale("en");
    const readFile = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([137, 80, 78, 71])
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        readFile
      }
    } as typeof window.agentHostApi;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:image-only-preview")
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <AgentToolCallCard
        defaultExpanded
        call={projectAgentToolCall(
          toolCall({
            toolName: "image_generation",
            payload: {
              content: [
                {
                  type: "content",
                  content: {
                    type: "image",
                    uri: "/workspace/output/generated-only.png",
                    mimeType: "image/png"
                  }
                }
              ]
            }
          })
        )}
      />
    );

    expect(
      await screen.findByRole("img", { name: "Image generation preview" })
    ).toHaveAttribute("src", "blob:image-only-preview");
    expect(screen.queryByText("Input")).toBeNull();
    expect(screen.getByText("Output")).toBeTruthy();
    expect(readFile).toHaveBeenCalledWith({
      path: "/workspace/output/generated-only.png"
    });
  });

  it("does not allow expanding web fetch cards without displayable content", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            name: "Fetch webpage",
            toolName: "WebFetch",
            status: "Running",
            statusKind: "working"
          })
        )}
      />
    );

    expect(screen.getByText("Fetch webpage")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
    expect(screen.queryByRole("button", { name: /Fetch webpage/ })).toBeNull();
    expect(
      document.querySelector(".workspace-agents-status-panel__detail-tool-body")
    ).not.toBeInTheDocument();
  });

  it("does not allow expanding edit cards without displayable file content", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            name: "Edit file",
            toolName: "Edit",
            status: "Completed",
            statusKind: "completed"
          })
        )}
      />
    );

    expect(screen.getByText("Edit file")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
    expect(
      document.querySelector(".workspace-agents-status-panel__detail-tool-body")
    ).not.toBeInTheDocument();
  });

  it("shows added-line stats for write content without a diff patch", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "Write",
            payload: {
              input: {
                file_path: "src/routes.ts",
                content: "line one\nline two\n"
              }
            }
          })
        )}
      />
    );

    expect(screen.getByText("+2")).toBeTruthy();
  });

  it("keeps edit cards collapsed by default and expands detail on demand", async () => {
    setAgentGuiI18nTestLocale("en");

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "Edit",
            payload: {
              output: {
                detailedContent:
                  "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const ready = false\n+const ready = true\n"
              }
            }
          })
        )}
      />
    );

    const toggle = screen.getByRole("button", { expanded: false });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      document.querySelector(".workspace-agents-status-panel__detail-tool-body")
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);
    await flushCollapsibleRevealFrames();

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("app.ts")).toBeTruthy();
    const changedLine = screen.getByText("const ready = true");
    expect(changedLine).toBeTruthy();
    await waitFor(() =>
      expect(changedLine.closest(".agent-collapsible-reveal")).toHaveAttribute(
        "data-expanded",
        "true"
      )
    );
  });

  it("keeps collapsed tool card details unmounted while idle", async () => {
    setAgentGuiI18nTestLocale("en");
    let idleCallback: IdleRequestCallback | null = null;
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idleCallback = callback;
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", () => undefined);

    render(
      <AgentToolCallCard
        call={projectAgentToolCall(
          toolCall({
            toolName: "Edit",
            payload: {
              output: {
                detailedContent:
                  "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const ready = false\n+const ready = true\n"
              }
            }
          })
        )}
      />
    );

    expect(screen.queryByText("@@ -1 +1 @@")).toBeNull();

    act(() => {
      idleCallback?.({
        didTimeout: false,
        timeRemaining: () => 50
      });
    });

    expect(
      document.querySelector(".workspace-agents-status-panel__detail-tool-body")
    ).not.toBeInTheDocument();
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
    id: "call:1",
    name: "Tool",
    toolName: null,
    callType: "tool",
    status: "Completed",
    statusKind: "completed",
    summary: "",
    payload: null,
    ...overrides
  };
}
