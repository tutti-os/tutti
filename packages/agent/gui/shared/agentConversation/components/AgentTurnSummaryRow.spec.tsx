import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@tutti-os/ui-system";
import type {
  AgentHostApplyWorkspaceGitPatchInput,
  AgentHostApplyWorkspaceGitPatchResult
} from "../../../host/agentHostApi";
import { AgentTurnSummaryRow } from "./AgentTurnSummaryRow";

vi.mock("../../../i18n/index", () => ({
  translate: (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key
}));

type MockTooltipProps = { children?: ReactNode };

vi.mock("@tutti-os/ui-system", () => {
  const Passthrough = ({ children }: MockTooltipProps) => <>{children}</>;

  return {
    Tooltip: Passthrough,
    TooltipProvider: Passthrough,
    TooltipTrigger: Passthrough,
    TooltipContent: ({ children }: MockTooltipProps) => (
      <div role="tooltip">{children}</div>
    ),
    toast: {
      error: vi.fn()
    }
  };
});

describe("AgentTurnSummaryRow", () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, "agentHostApi");
    vi.mocked(toast.error).mockClear();
  });

  it("applies patch batches in Codex-compatible undo and reapply order", async () => {
    const patchCalls: AgentHostApplyWorkspaceGitPatchInput[] = [];
    const applyGitPatch = vi.fn(
      async (
        input: AgentHostApplyWorkspaceGitPatchInput
      ): Promise<AgentHostApplyWorkspaceGitPatchResult> => {
        patchCalls.push(input);
        return {
          appliedPaths: ["src/app.ts"],
          conflictedPaths: [],
          skippedPaths: [],
          status: "success" as const
        };
      }
    );
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        applyGitPatch
      }
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:patch-batches",
          turnId: "turn-1",
          fileCount: 2,
          modifiedCount: 2,
          createdCount: 0,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "src/app.ts",
              path: "src/app.ts",
              fileName: "app.ts",
              directory: "src",
              changeType: "modified",
              toolName: null,
              messageId: "call:1",
              unifiedDiff:
                "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+middle\n",
              occurredAtUnixMs: 10
            },
            {
              label: "src/app.ts",
              path: "src/app.ts",
              fileName: "app.ts",
              directory: "src",
              changeType: "modified",
              toolName: null,
              messageId: "call:2",
              unifiedDiff:
                "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-middle\n+new\n",
              occurredAtUnixMs: 11
            }
          ],
          patchBatches: [
            {
              cwd: "/workspace/demo",
              toolCallId: "call:1",
              changes: [
                {
                  path: "src/app.ts",
                  changeType: "modified",
                  unifiedDiff: "@@ -1 +1 @@\n-old\n+middle"
                }
              ]
            },
            {
              cwd: "/workspace/demo",
              toolCallId: "call:2",
              changes: [
                {
                  path: "src/app.ts",
                  changeType: "modified",
                  unifiedDiff: "@@ -1 +1 @@\n-middle\n+new"
                }
              ]
            }
          ]
        }}
        workspaceRoot="/workspace/demo"
        label="Changed files"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.turnSummaryUndo"
      })
    );
    expect(screen.getByText("agentHost.agentGui.turnSummaryUndo")).toBeTruthy();

    await waitFor(() => {
      expect(applyGitPatch).toHaveBeenCalledTimes(2);
    });
    expect(patchCalls[0]).toMatchObject({
      cwd: "/workspace/demo",
      revert: true
    });
    expect(patchCalls[0]?.diff).toContain("-middle\n+new");
    expect(patchCalls[1]?.diff).toContain("-old\n+middle");
    expect(
      await screen.findByRole("button", {
        name: "agentHost.agentGui.turnSummaryReapply"
      })
    ).toBeTruthy();
    expect(
      screen.getByText("agentHost.agentGui.turnSummaryReapply")
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.turnSummaryReapply"
      })
    );

    await waitFor(() => {
      expect(applyGitPatch).toHaveBeenCalledTimes(4);
    });
    expect(patchCalls[2]).toMatchObject({
      cwd: "/workspace/demo",
      revert: false
    });
    expect(patchCalls[2]?.diff).toContain("-old\n+middle");
    expect(patchCalls[3]?.diff).toContain("-middle\n+new");
  }, 10_000);

  it("falls back to a single unified diff batch when patch batches are missing", async () => {
    const patchCalls: AgentHostApplyWorkspaceGitPatchInput[] = [];
    const applyGitPatch = vi.fn(
      async (
        input: AgentHostApplyWorkspaceGitPatchInput
      ): Promise<AgentHostApplyWorkspaceGitPatchResult> => {
        patchCalls.push(input);
        return {
          appliedPaths: ["src/app.ts"],
          conflictedPaths: [],
          skippedPaths: [],
          status: "success"
        };
      }
    );
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        applyGitPatch
      }
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:unified-fallback",
          turnId: "turn-1",
          fileCount: 1,
          modifiedCount: 1,
          createdCount: 0,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "src/app.ts",
              path: "src/app.ts",
              fileName: "app.ts",
              directory: "src",
              changeType: "modified",
              toolName: null,
              messageId: "call:1",
              unifiedDiff:
                "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
              occurredAtUnixMs: 10
            }
          ]
        }}
        workspaceRoot="/workspace/demo"
        label="Changed files"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.turnSummaryUndo"
      })
    );

    await waitFor(() => {
      expect(applyGitPatch).toHaveBeenCalledTimes(1);
    });
    expect(patchCalls[0]).toMatchObject({
      cwd: "/workspace/demo",
      revert: true
    });
    expect(patchCalls[0]?.diff).toContain(
      "diff --git a/src/app.ts b/src/app.ts"
    );
    expect(patchCalls[0]?.diff).toContain("-old\n+new");
  });

  it("builds a fallback add-file patch from created content when patch batches are missing", async () => {
    const patchCalls: AgentHostApplyWorkspaceGitPatchInput[] = [];
    const applyGitPatch = vi.fn(
      async (
        input: AgentHostApplyWorkspaceGitPatchInput
      ): Promise<AgentHostApplyWorkspaceGitPatchResult> => {
        patchCalls.push(input);
        return {
          appliedPaths: ["hello_world.md"],
          conflictedPaths: [],
          skippedPaths: [],
          status: "success"
        };
      }
    );
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        applyGitPatch
      }
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:created-content-fallback",
          turnId: "turn-1",
          fileCount: 1,
          modifiedCount: 0,
          createdCount: 1,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "hello_world.md",
              path: "/Users/demo/02-git-clean/hello_world.md",
              fileName: "hello_world.md",
              directory: "/Users/demo/02-git-clean",
              changeType: "created",
              toolName: null,
              messageId: "call:1",
              content: "# Hello, world!\n",
              occurredAtUnixMs: 10
            }
          ]
        }}
        workspaceRoot="/Users/demo/02-git-clean"
        label="Changed files"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.turnSummaryUndo"
      })
    );

    await waitFor(() => {
      expect(applyGitPatch).toHaveBeenCalledTimes(1);
    });
    expect(patchCalls[0]).toMatchObject({
      cwd: "/Users/demo/02-git-clean",
      revert: true
    });
    expect(patchCalls[0]?.diff).toContain(
      "diff --git a/hello_world.md b/hello_world.md"
    );
    expect(patchCalls[0]?.diff).toContain("new file mode 100644");
    expect(patchCalls[0]?.diff).toContain("+# Hello, world!");
  });

  it("falls back to file unified diffs when recorded patch batches are not executable", async () => {
    const patchCalls: AgentHostApplyWorkspaceGitPatchInput[] = [];
    const applyGitPatch = vi.fn(
      async (
        input: AgentHostApplyWorkspaceGitPatchInput
      ): Promise<AgentHostApplyWorkspaceGitPatchResult> => {
        patchCalls.push(input);
        return {
          appliedPaths: ["hello_world.md"],
          conflictedPaths: [],
          skippedPaths: [],
          status: "success"
        };
      }
    );
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        applyGitPatch
      }
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:bad-patch-batch-file-fallback",
          turnId: "turn-1",
          fileCount: 1,
          modifiedCount: 0,
          createdCount: 1,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "hello_world.md",
              path: "/Users/demo/02-git-clean/hello_world.md",
              fileName: "hello_world.md",
              directory: "/Users/demo/02-git-clean",
              changeType: "created",
              toolName: null,
              messageId: "call:1",
              unifiedDiff:
                "diff --git a/hello_world.md b/hello_world.md\nnew file mode 100644\n--- /dev/null\n+++ b/hello_world.md\n@@ -0,0 +1,1 @@\n+# Hello, world!\n",
              occurredAtUnixMs: 10
            }
          ],
          patchBatches: [
            {
              cwd: "/",
              toolCallId: "call:1",
              changes: [
                {
                  path: "/Users/demo/02-git-clean/hello_world.md",
                  changeType: "created"
                }
              ]
            }
          ]
        }}
        workspaceRoot="/"
        label="Changed files"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.turnSummaryUndo"
      })
    );

    await waitFor(() => {
      expect(applyGitPatch).toHaveBeenCalledTimes(1);
    });
    expect(patchCalls[0]).toMatchObject({
      cwd: "/Users/demo/02-git-clean",
      revert: true
    });
    expect(patchCalls[0]?.diff).toContain(
      "diff --git a/hello_world.md b/hello_world.md"
    );
    expect(patchCalls[0]?.diff).toContain("+# Hello, world!");
  });

  it("maps Codex /workspace patch cwd to the host workspace root before git calls", async () => {
    const patchCalls: AgentHostApplyWorkspaceGitPatchInput[] = [];
    const supportCalls: string[] = [];
    const applyGitPatch = vi.fn(
      async (
        input: AgentHostApplyWorkspaceGitPatchInput
      ): Promise<AgentHostApplyWorkspaceGitPatchResult> => {
        patchCalls.push(input);
        return {
          appliedPaths: ["hello_world.md"],
          conflictedPaths: [],
          skippedPaths: [],
          status: "success"
        };
      }
    );
    const resolveGitPatchSupport = vi.fn(async ({ cwd }: { cwd: string }) => {
      supportCalls.push(cwd);
      return {
        root: cwd,
        supported: true
      };
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        applyGitPatch,
        resolveGitPatchSupport
      }
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:mapped-workspace",
          turnId: "turn-1",
          fileCount: 1,
          modifiedCount: 0,
          createdCount: 1,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "/workspace/hello_world.md",
              path: "/workspace/hello_world.md",
              fileName: "hello_world.md",
              directory: "/workspace",
              changeType: "created",
              toolName: null,
              messageId: "call:1",
              content: "# Hello, world!\n",
              occurredAtUnixMs: 10
            }
          ],
          patchBatches: [
            {
              cwd: "/workspace",
              toolCallId: "call:1",
              changes: [
                {
                  path: "/workspace/hello_world.md",
                  changeType: "created",
                  content: "# Hello, world!\n"
                }
              ]
            }
          ]
        }}
        workspaceRoot="/Users/demo/02-git-clean"
        label="Changed files"
      />
    );

    await waitFor(() => {
      expect(resolveGitPatchSupport).toHaveBeenCalledTimes(1);
    });
    expect(supportCalls).toEqual(["/Users/demo/02-git-clean"]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.turnSummaryUndo"
      })
    );

    await waitFor(() => {
      expect(applyGitPatch).toHaveBeenCalledTimes(1);
    });
    expect(patchCalls[0]).toMatchObject({
      cwd: "/Users/demo/02-git-clean",
      revert: true
    });
    expect(patchCalls[0]?.diff).toContain(
      "diff --git a/hello_world.md b/hello_world.md"
    );
    expect(patchCalls[0]?.diff).not.toContain("/workspace");
  });

  it("shows patch failures through the host toast instead of an inline card message", async () => {
    vi.mocked(toast.error).mockClear();
    const hostToastError = vi.fn();
    const applyGitPatch = vi.fn(
      async (): Promise<AgentHostApplyWorkspaceGitPatchResult> => ({
        appliedPaths: [],
        conflictedPaths: [],
        skippedPaths: [],
        status: "error"
      })
    );
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      toast: {
        error: hostToastError
      },
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        applyGitPatch
      }
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:failed-undo",
          turnId: "turn-1",
          fileCount: 1,
          modifiedCount: 1,
          createdCount: 0,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "src/app.ts",
              path: "src/app.ts",
              fileName: "app.ts",
              directory: "src",
              changeType: "modified",
              toolName: null,
              messageId: "call:1",
              unifiedDiff:
                "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
              occurredAtUnixMs: 10
            }
          ]
        }}
        workspaceRoot="/workspace/demo"
        label="Changed files"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.turnSummaryUndo"
      })
    );

    await waitFor(() => {
      expect(hostToastError).toHaveBeenCalledWith(
        "agentHost.agentGui.turnSummaryUndoFailed"
      );
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(
      screen.queryByText("agentHost.agentGui.turnSummaryUndoFailed")
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "agentHost.agentGui.turnSummaryUndo"
      })
    ).toBeTruthy();
  });

  it("falls back to the ui-system toast when the host has no toast capability", async () => {
    vi.mocked(toast.error).mockClear();
    const applyGitPatch = vi.fn(
      async (): Promise<AgentHostApplyWorkspaceGitPatchResult> => ({
        appliedPaths: [],
        conflictedPaths: [],
        skippedPaths: [],
        status: "error"
      })
    );
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        applyGitPatch
      }
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:fallback-toast",
          turnId: "turn-1",
          fileCount: 1,
          modifiedCount: 1,
          createdCount: 0,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "src/app.ts",
              path: "src/app.ts",
              fileName: "app.ts",
              directory: "src",
              changeType: "modified",
              toolName: null,
              messageId: "call:1",
              unifiedDiff:
                "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
              occurredAtUnixMs: 10
            }
          ]
        }}
        workspaceRoot="/workspace/demo"
        label="Changed files"
      />
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "agentHost.agentGui.turnSummaryUndo"
      })
    );

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "agentHost.agentGui.turnSummaryUndoFailed"
      );
    });
  });

  it("disables undo with a git repository hint when the cwd is not a git repo", async () => {
    const applyGitPatch = vi.fn();
    const resolveGitPatchSupport = vi.fn(async () => ({
      errorCode: "not-git-repo",
      supported: false
    }));
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        applyGitPatch,
        resolveGitPatchSupport
      }
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:no-git",
          turnId: "turn-1",
          fileCount: 1,
          modifiedCount: 1,
          createdCount: 0,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "src/app.ts",
              path: "src/app.ts",
              fileName: "app.ts",
              directory: "src",
              changeType: "modified",
              toolName: null,
              messageId: "call:1",
              unifiedDiff:
                "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
              occurredAtUnixMs: 10
            }
          ]
        }}
        workspaceRoot="/workspace/no-git"
        label="Changed files"
      />
    );

    await waitFor(() => {
      expect(resolveGitPatchSupport).toHaveBeenCalledWith({
        cwd: "/workspace/no-git"
      });
    });
    const button = screen.getByRole("button", {
      name: "agentHost.agentGui.turnSummaryUndo"
    });
    await waitFor(() => {
      expect(button).toHaveAttribute("disabled");
    });
    expect(button.textContent).toContain("agentHost.agentGui.turnSummaryUndo");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "agentHost.agentGui.turnSummaryGitRequired"
    );

    fireEvent.click(button);

    expect(applyGitPatch).not.toHaveBeenCalled();
  });

  it("keeps undo available when git support probing fails", async () => {
    const applyGitPatch = vi.fn(
      async (): Promise<AgentHostApplyWorkspaceGitPatchResult> => ({
        appliedPaths: ["src/app.ts"],
        conflictedPaths: [],
        skippedPaths: [],
        status: "success"
      })
    );
    const resolveGitPatchSupport = vi.fn(async () => {
      throw new Error("probe failed");
    });
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        applyGitPatch,
        resolveGitPatchSupport
      }
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:probe-failure",
          turnId: "turn-1",
          fileCount: 1,
          modifiedCount: 1,
          createdCount: 0,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "src/app.ts",
              path: "src/app.ts",
              fileName: "app.ts",
              directory: "src",
              changeType: "modified",
              toolName: null,
              messageId: "call:1",
              unifiedDiff:
                "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n",
              occurredAtUnixMs: 10
            }
          ]
        }}
        workspaceRoot="/workspace/demo"
        label="Changed files"
      />
    );

    await waitFor(() => {
      expect(resolveGitPatchSupport).toHaveBeenCalledWith({
        cwd: "/workspace/demo"
      });
    });
    const button = screen.getByRole("button", {
      name: "agentHost.agentGui.turnSummaryUndo"
    });
    await waitFor(() => {
      expect(button).not.toHaveAttribute("disabled");
    });

    fireEvent.click(button);

    await waitFor(() => {
      expect(applyGitPatch).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps undo visible but disabled when no reversible patch data is available", () => {
    const applyGitPatch = vi.fn();
    window.agentHostApi = {
      ...(window.agentHostApi ?? {}),
      workspace: {
        ...(window.agentHostApi?.workspace ?? {}),
        applyGitPatch
      }
    } as unknown as typeof window.agentHostApi;

    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:missing-patch-data",
          turnId: "turn-1",
          fileCount: 1,
          modifiedCount: 1,
          createdCount: 0,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "hello_world.md",
              path: "/workspace/hello_world.md",
              fileName: "hello_world.md",
              directory: "/workspace",
              changeType: "modified",
              toolName: null,
              messageId: "call:1",
              occurredAtUnixMs: 10
            }
          ]
        }}
        workspaceRoot="/Users/demo/01-no-git"
        label="Changed files"
      />
    );

    const button = screen.getByRole("button", {
      name: "agentHost.agentGui.turnSummaryUndo"
    });
    expect(button).toHaveAttribute("disabled");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "agentHost.agentGui.turnSummaryPatchUnavailable"
    );

    fireEvent.click(button);

    expect(applyGitPatch).not.toHaveBeenCalled();
  });

  it("renders a change card with expandable file diff rows and dispatches workspace actions", async () => {
    const onLinkAction = vi.fn();
    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:1",
          turnId: "turn-1",
          fileCount: 2,
          modifiedCount: 2,
          createdCount: 0,
          occurredAtUnixMs: 10,
          files: [
            {
              label: "src/app.ts",
              path: "src/app.ts",
              fileName: "app.ts",
              directory: "src",
              changeType: "modified",
              toolName: "Edit",
              messageId: "call:1",
              unifiedDiff:
                "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-const ready = false\n+const ready = true\n",
              occurredAtUnixMs: 10
            },
            {
              label: "src/feature.ts",
              path: "src/feature.ts",
              fileName: "feature.ts",
              directory: "src",
              changeType: "modified",
              toolName: "Edit",
              messageId: "call:2",
              unifiedDiff:
                "diff --git a/src/feature.ts b/src/feature.ts\n--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1 +1 @@\n-export const enabled = false\n+export const enabled = true\n",
              occurredAtUnixMs: 10
            }
          ]
        }}
        workspaceRoot="/workspace/demo"
        label="Changed files"
        onLinkAction={onLinkAction}
      />
    );

    expect(
      screen.getByText("agentHost.agentGui.turnSummaryFilesChanged:2")
    ).toBeTruthy();
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("-2")).toBeTruthy();
    expect(
      screen
        .getByText("agentHost.agentGui.turnSummaryFilesChanged:2")
        .closest("div")?.className
    ).toContain("text-[15px]");
    expect(
      screen
        .getByText("agentHost.agentGui.turnSummaryFilesChanged:2")
        .closest("div")?.className
    ).toContain("text-[var(--text-primary)]");
    expect(screen.getByText("+2").parentElement?.className).toContain(
      "inline-flex"
    );
    expect(screen.getByText("+2").className).toContain(
      "workspace-agents-status-panel__detail-tool-diff-added"
    );
    expect(screen.getByText("+2").className).not.toContain(
      "tsh-ui-pill-success"
    );
    expect(screen.getByText("+2").className).not.toContain("text-emerald");
    expect(screen.getByText("-2").className).toContain(
      "workspace-agents-status-panel__detail-tool-diff-removed"
    );
    expect(screen.getByText("-2").className).not.toContain(
      "tsh-ui-pill-danger"
    );
    expect(screen.getByText("-2").className).not.toContain("text-rose");
    expect(
      screen.getByText("+2").parentElement?.parentElement?.className
    ).toContain("items-center");
    expect(screen.getByText("+2").parentElement?.parentElement).toBe(
      screen.getByText("agentHost.agentGui.turnSummaryFilesChanged:2")
        .parentElement
    );
    expect(
      screen
        .getByText("agentHost.agentGui.turnSummaryFilesChanged:2")
        .closest("section")?.firstElementChild?.className
    ).toContain("agent-turn-summary-card");
    expect(
      screen
        .getByText("agentHost.agentGui.turnSummaryFilesChanged:2")
        .closest("section")?.firstElementChild?.className
    ).not.toContain("border-[var(--line-1)]");
    expect(screen.queryByText("Changed files")).toBeNull();
    expect(
      screen.queryByText("agentHost.agentGui.turnSummaryOpenFile")
    ).toBeNull();
    const firstFileToggle = screen.getAllByRole("button", {
      name: /src\/app\.ts/i
    })[0]!;
    expect(firstFileToggle.className).toContain("items-center");
    expect(firstFileToggle.className).toContain("gap-1");
    expect(
      firstFileToggle
        .querySelector("svg")
        ?.classList.contains("lucide-chevron-right")
    ).toBe(true);
    expect(
      firstFileToggle.querySelector(".lucide-chevron-right")?.parentElement
        ?.className
    ).toContain("text-[var(--text-tertiary)]");
    expect(
      firstFileToggle.querySelector(".lucide-chevron-right")?.parentElement
        ?.className
    ).toContain("opacity-0");
    expect(
      firstFileToggle.querySelector(".lucide-chevron-right")?.parentElement
        ?.className
    ).toContain("group-hover/file-toggle:opacity-100");
    expect(
      firstFileToggle.querySelector(".lucide-chevron-right")?.className
    ).toContain("transition-transform");
    expect(firstFileToggle.querySelector(".lucide-file-text")).toBeNull();
    expect(firstFileToggle.querySelector(".lucide-file-pen-line")).toBeNull();
    expect(firstFileToggle.querySelector(".lucide-file-plus-2")).toBeNull();
    expect(screen.getByTitle("src/app.ts").className).toContain(
      "text-[var(--text-secondary)]"
    );
    expect(screen.getByTitle("src/app.ts").className).toContain("text-[13px]");
    expect(
      screen
        .getByText("agentHost.agentGui.turnSummaryFilesChanged:2")
        .closest("section")?.className
    ).toContain("workspace-agents-status-panel__detail-turn-summary");

    fireEvent.click(firstFileToggle);

    expect(
      firstFileToggle.querySelector(".lucide-chevron-right")?.className
    ).toContain("rotate-90");
    await waitFor(() => {
      expect(screen.getByText("const ready = false")).toBeTruthy();
      expect(screen.getByText("const ready = true")).toBeTruthy();
    });
    expect(
      screen
        .getByText("const ready = false")
        .closest(".workspace-agents-status-panel__detail-tool-diff")?.className
    ).toContain("border-[var(--line-2)]");
    expect(
      screen
        .getByText("const ready = false")
        .closest(".workspace-agents-status-panel__detail-tool-diff")
        ?.parentElement?.className
    ).not.toContain("bg-[color:var(--transparency-block)]");
    expect(
      screen
        .getByText("const ready = false")
        .closest(".workspace-agents-status-panel__detail-tool-diff")
        ?.parentElement?.className
    ).toContain("rounded-none");
    await waitFor(() => {
      expect(
        screen
          .getByText("const ready = false")
          .closest(".agent-collapsible-reveal")
      ).toHaveAttribute("data-expanded", "true");
    });

    const openFileButton = screen.getByRole("button", {
      name: /agentHost\.workspaceAgentSessionDetailOpenFile:src\/app\.ts/i
    });

    expect(openFileButton.className).toContain("h-7");
    expect(openFileButton.className).toContain("w-7");
    expect(openFileButton.className).not.toContain("h-8");
    expect(openFileButton.className).not.toContain("w-8");

    fireEvent.click(openFileButton);

    expect(
      openFileButton.querySelector('svg[data-tutti-chrome-glyph="fill"]')
    ).toBeTruthy();
    expect(
      openFileButton
        .querySelector('svg[data-tutti-chrome-glyph="fill"]')
        ?.getAttribute("class")
    ).toContain("text-[var(--text-secondary)]");

    expect(onLinkAction).toHaveBeenCalled();
  });

  it("animates the overflow file list when there are more than three files", async () => {
    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:2",
          turnId: "turn-2",
          fileCount: 4,
          modifiedCount: 4,
          createdCount: 0,
          occurredAtUnixMs: 20,
          files: Array.from({ length: 4 }, (_, index) => ({
            label: `src/file-${index + 1}.ts`,
            path: `src/file-${index + 1}.ts`,
            fileName: `file-${index + 1}.ts`,
            directory: "src",
            changeType: "modified" as const,
            toolName: "Edit",
            messageId: `call:${index + 1}`,
            unifiedDiff: `diff --git a/src/file-${index + 1}.ts b/src/file-${index + 1}.ts\n--- a/src/file-${index + 1}.ts\n+++ b/src/file-${index + 1}.ts\n@@ -1 +1 @@\n-export const value = ${index}\n+export const value = ${index + 1}\n`,
            occurredAtUnixMs: 20
          }))
        }}
        workspaceRoot="/workspace/demo"
        label="Changed files"
      />
    );

    expect(screen.queryByTitle("src/file-4.ts")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: /agentHost\.agentGui\.turnSummaryShowMoreFiles:1/i
      })
    );

    await waitFor(() => {
      expect(screen.getByTitle("src/file-4.ts")).toBeTruthy();
    });
    expect(
      screen.getByTitle("src/file-4.ts").closest(".agent-collapsible-reveal")
    ).toHaveAttribute("data-expanded", "true");
    expect(
      screen.getByRole("button", {
        name: /agentHost\.agentGui\.turnSummaryShowFewerFiles/i
      })
    ).toBeTruthy();
  });

  it("dispatches workspace actions for external absolute file changes", async () => {
    const onLinkAction = vi.fn();
    const externalPath =
      "/var/folders/17/demo/T/codex-presentations/test-note.md";
    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:external",
          turnId: "turn-external",
          fileCount: 1,
          modifiedCount: 0,
          createdCount: 1,
          occurredAtUnixMs: 25,
          files: [
            {
              label: externalPath,
              path: externalPath,
              fileName: "test-note.md",
              directory: "/var/folders/17/demo/T/codex-presentations",
              changeType: "created",
              toolName: "write_file",
              messageId: "call:external",
              content: "# Test note",
              newString: "# Test note",
              occurredAtUnixMs: 25
            }
          ]
        }}
        workspaceRoot="/Users/demo/project"
        label="Changed files"
        onLinkAction={onLinkAction}
      />
    );

    fireEvent.click(
      screen.getAllByRole("button", {
        name: /test-note\.md/i
      })[0]!
    );

    const openFileButton = await screen.findByRole("button", {
      name: /agentHost\.workspaceAgentSessionDetailOpenFile:\/var\/folders\/17\/demo\/T\/codex-presentations\/test-note\.md/i
    });
    fireEvent.click(openFileButton);

    expect(onLinkAction).toHaveBeenCalledWith(
      expect.objectContaining({
        path: externalPath,
        type: "open-workspace-file"
      })
    );
  });

  it("renders created edit-file content without falling back to monaco loading", async () => {
    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:3",
          turnId: "turn-3",
          fileCount: 1,
          modifiedCount: 0,
          createdCount: 1,
          occurredAtUnixMs: 30,
          files: [
            {
              label: "/workspace/today.txt",
              path: "/workspace/today.txt",
              fileName: "today.txt",
              directory: "/workspace",
              changeType: "created",
              toolName: "Edit",
              messageId: "call:3",
              content: "2026-05-19",
              newString: "2026-05-19",
              occurredAtUnixMs: 30
            }
          ]
        }}
        workspaceRoot="/workspace"
        label="Changed files"
      />
    );

    expect(
      screen.getByText("agentHost.agentGui.turnSummaryFilesChanged:1")
    ).toBeTruthy();
    expect(screen.getAllByText("+1")).toHaveLength(2);
    expect(screen.queryByText("-1")).toBeNull();
    expect(
      screen.queryByText("agentHost.agentGui.turnSummaryCreatedTag")
    ).toBeNull();

    fireEvent.click(
      screen.getAllByRole("button", {
        name: /today\.txt/i
      })[0]!
    );

    await waitFor(() => {
      expect(screen.getByText("2026-05-19")).toBeTruthy();
    });
    expect(
      screen.queryByText("agentHost.agentTool.details.loadingDiff")
    ).toBeNull();
  });

  it("renders deleted file content as removed lines", async () => {
    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:deleted",
          turnId: "turn-deleted",
          fileCount: 1,
          modifiedCount: 1,
          createdCount: 0,
          occurredAtUnixMs: 35,
          files: [
            {
              label: "/workspace/a.md",
              path: "/workspace/a.md",
              fileName: "a.md",
              directory: "/workspace",
              changeType: "deleted",
              toolName: "apply_patch",
              messageId: "call:deleted",
              oldString: "aaaaa",
              newString: "",
              occurredAtUnixMs: 35
            }
          ]
        }}
        workspaceRoot="/workspace"
        label="Changed files"
      />
    );

    expect(screen.getAllByText("-1")).toHaveLength(2);
    expect(screen.queryByText("+1")).toBeNull();
    expect(screen.getByTitle("/workspace/a.md").className).toContain(
      "line-through"
    );

    expect(
      screen.queryByText("agentHost.agentGui.turnSummaryCreatedTag")
    ).toBeNull();
  });

  it("marks long file paths as shrinkable so truncation can prevent overflow", () => {
    render(
      <AgentTurnSummaryRow
        row={{
          kind: "turn-summary",
          id: "turn-summary:4",
          turnId: "turn-4",
          fileCount: 1,
          modifiedCount: 1,
          createdCount: 0,
          occurredAtUnixMs: 40,
          files: [
            {
              label:
                "/workspace/very/deep/path/to/a/file/with/a/really-long-name/today_news_summary_2026-05-20.txt",
              path: "/workspace/very/deep/path/to/a/file/with/a/really-long-name/today_news_summary_2026-05-20.txt",
              fileName: "today_news_summary_2026-05-20.txt",
              directory:
                "/workspace/very/deep/path/to/a/file/with/a/really-long-name",
              changeType: "modified",
              toolName: "Edit",
              messageId: "call:4",
              unifiedDiff:
                "diff --git a/today_news_summary_2026-05-20.txt b/today_news_summary_2026-05-20.txt\n--- a/today_news_summary_2026-05-20.txt\n+++ b/today_news_summary_2026-05-20.txt\n@@ -1 +1 @@\n-old\n+new\n",
              occurredAtUnixMs: 40
            }
          ]
        }}
        workspaceRoot="/workspace"
        label="Changed files"
      />
    );

    const pathLabel = screen.getByTitle(
      "/workspace/very/deep/path/to/a/file/with/a/really-long-name/today_news_summary_2026-05-20.txt"
    );
    const directoryLabel = pathLabel.querySelector(
      ".agent-turn-summary-card__path-directory"
    );
    const fileNameLabel = pathLabel.querySelector(
      ".agent-turn-summary-card__path-file"
    );
    const pathToggle = pathLabel.closest("button");
    const pathContainer = pathLabel.parentElement;
    const fileRow = pathToggle?.closest(".agent-turn-summary-card__file");
    const summarySection = screen
      .getByText("agentHost.agentGui.turnSummaryFilesChanged:1")
      .closest("section");

    expect(pathLabel.className).toContain("flex");
    expect(pathLabel.className).toContain("min-w-0");
    expect(pathLabel.className).toContain("overflow-hidden");
    expect(pathLabel.className).toContain("whitespace-nowrap");
    expect(directoryLabel?.textContent).toBe(
      "/workspace/very/deep/path/to/a/file/with/a/really-long-name/"
    );
    expect(directoryLabel?.className).toContain(
      "agent-turn-summary-card__path-directory"
    );
    expect(fileNameLabel?.textContent).toBe(
      "today_news_summary_2026-05-20.txt"
    );
    expect(fileNameLabel?.className).toContain(
      "agent-turn-summary-card__path-file"
    );
    expect(pathContainer?.className).toContain("flex-1");
    expect(pathContainer?.className).toContain("overflow-hidden");
    expect(pathToggle?.className).toContain("flex-1");
    expect(pathToggle?.className).toContain("overflow-hidden");
    expect(fileRow?.firstElementChild?.className).toContain("overflow-hidden");
    expect(fileRow?.firstElementChild?.className).toContain(
      "agent-turn-summary-card__file-row"
    );
    expect(summarySection?.firstElementChild?.className).toContain("w-full");
  });
});
