import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReferenceSourceAggregator } from "@tutti-os/workspace-file-reference/core";

import { useAgentGUIWorkspaceReferencePicker } from "./useAgentGUIWorkspaceReferencePicker";

function createInput(
  projectDirectorySourceAggregator: ReferenceSourceAggregator
): Parameters<typeof useAgentGUIWorkspaceReferencePicker>[0] {
  return {
    onWorkspaceFileReferencesAdded: undefined,
    projectDirectorySourceAggregator,
    referenceSourceAggregator: {} as ReferenceSourceAggregator,
    resolveMentionReferenceTarget: undefined,
    resolveWorkspaceReferenceInitialTarget: undefined,
    viewModel: {
      composer: {
        composerSettings: { selectedProjectPath: null }
      },
      rail: {
        activeConversation: null,
        userProjects: []
      },
      shell: { workspaceId: "workspace-1" }
    } as unknown as Parameters<
      typeof useAgentGUIWorkspaceReferencePicker
    >[0]["viewModel"],
    workspaceFileReferenceAdapter: undefined,
    workspaceFileReferenceCopy: undefined
  };
}

describe("useAgentGUIWorkspaceReferencePicker project directory purpose", () => {
  it("opens the shared picker with the directory aggregator and resolves one folder", async () => {
    const projectDirectorySourceAggregator = {} as ReferenceSourceAggregator;
    const { result } = renderHook(() =>
      useAgentGUIWorkspaceReferencePicker(
        createInput(projectDirectorySourceAggregator)
      )
    );
    let selectionPromise!: Promise<{ path: string } | null>;

    act(() => {
      selectionPromise = result.current.requestProjectDirectory();
    });

    expect(result.current.workspaceReferencePickerOpen).toBe(true);
    expect(result.current.workspaceReferencePickerPurpose).toBe("directory");
    expect(result.current.workspaceReferencePickerAggregator).toBe(
      projectDirectorySourceAggregator
    );
    expect(
      result.current.isWorkspaceReferencePickerNodeSelectable({
        displayName: "folder",
        kind: "folder",
        ref: { nodeId: "/workspace/folder", sourceId: "workspace-file" }
      })
    ).toBe(true);
    expect(
      result.current.isWorkspaceReferencePickerNodeSelectable({
        displayName: "file",
        kind: "file",
        ref: { nodeId: "/workspace/file", sourceId: "workspace-file" }
      })
    ).toBe(false);

    act(() => {
      result.current.confirmWorkspaceReferencePicker([
        {
          kind: "folder",
          path: "/workspace/folder",
          sourceId: "workspace-file"
        }
      ]);
    });

    await expect(selectionPromise).resolves.toEqual({
      path: "/workspace/folder"
    });
    expect(result.current.workspaceReferencePickerOpen).toBe(false);
    expect(result.current.workspaceReferencePickerPurpose).toBe("reference");
  });
});
