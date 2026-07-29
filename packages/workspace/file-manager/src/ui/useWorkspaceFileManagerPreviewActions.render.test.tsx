import { createI18nRuntime } from "@tutti-os/ui-i18n-runtime";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceFileManagerI18nRuntime,
  workspaceFileManagerI18nResources
} from "../i18n/workspaceFileManagerI18n.ts";
import type { WorkspaceFileManagerSession } from "../services/workspaceFileManagerService.interface.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileManagerCapabilities,
  WorkspaceFileManagerState
} from "../services/workspaceFileManagerTypes.ts";
import { useWorkspaceFileManagerPreviewActions } from "./useWorkspaceFileManagerPreviewActions.tsx";
import type {
  WorkspaceFileManagerPreviewAction,
  WorkspaceFileManagerPreviewActionsConfig
} from "./workspaceFileManagerPreviewActionTypes.ts";

const entry: WorkspaceFileEntry = {
  hasChildren: false,
  kind: "file",
  mtimeMs: null,
  name: "notes.txt",
  path: "/workspace/notes.txt",
  sizeBytes: 12
};

const copy = createWorkspaceFileManagerI18nRuntime(
  createI18nRuntime({ dictionaries: [workspaceFileManagerI18nResources.en] })
);

function createCapabilities(
  overrides: Partial<WorkspaceFileManagerCapabilities> = {}
): WorkspaceFileManagerCapabilities {
  return {
    canCopy: true,
    canCreateDirectory: true,
    canCreateFile: true,
    canDelete: true,
    canMove: true,
    canOpenInAppBrowser: true,
    canOpenInDefaultBrowser: true,
    canOpenWith: true,
    canPickOtherOpenWithApplication: true,
    canRevealInFolder: true,
    canRename: true,
    canSearch: true,
    ...overrides
  };
}

function createState(
  overrides: Partial<WorkspaceFileManagerState> = {}
): WorkspaceFileManagerState {
  return {
    busyAction: null,
    capabilities: createCapabilities(),
    isLoading: false,
    isMutating: false,
    locationSections: [],
    selectedLocationId: null,
    ...overrides
  } as WorkspaceFileManagerState;
}

/** Renders the hook and returns the resolved descriptors. */
async function resolveActions({
  config,
  onCopyEntry,
  selectedEntry = entry,
  session,
  state = createState()
}: {
  config: WorkspaceFileManagerPreviewActionsConfig | undefined;
  onCopyEntry?: () => Promise<void> | void;
  selectedEntry?: WorkspaceFileEntry | null;
  session?: Partial<WorkspaceFileManagerSession>;
  state?: WorkspaceFileManagerState;
}): Promise<readonly WorkspaceFileManagerPreviewAction[]> {
  let resolved: readonly WorkspaceFileManagerPreviewAction[] = [];

  function Probe(): null {
    resolved = useWorkspaceFileManagerPreviewActions({
      config,
      copy,
      entry: selectedEntry,
      onCopyEntry,
      session: (session ?? {}) as WorkspaceFileManagerSession,
      state
    });
    return null;
  }

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const previousActEnvironment = (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT;
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  try {
    await act(async () => {
      root.render(<Probe />);
    });
    return resolved;
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
}

describe("useWorkspaceFileManagerPreviewActions", () => {
  it("resolves nothing without a config", async () => {
    expect(await resolveActions({ config: undefined })).toEqual([]);
  });

  it("resolves nothing without a selected entry", async () => {
    expect(
      await resolveActions({
        config: { copy: true, open: true },
        selectedEntry: null
      })
    ).toEqual([]);
  });

  it("renders only the opted-in actions, in the default order", async () => {
    const actions = await resolveActions({
      config: {
        copy: true,
        open: true,
        onDownload: () => {},
        onShare: () => {}
      }
    });

    expect(actions.map((action) => action.id)).toEqual([
      "copy",
      "open",
      "download",
      "share"
    ]);
    expect(actions.map((action) => action.label)).toEqual([
      "Copy",
      "Open",
      "Download",
      "Share"
    ]);
  });

  it("omits copy and open when the host does not opt in", async () => {
    const actions = await resolveActions({
      config: { onDownload: () => {}, onShare: () => {} }
    });

    expect(actions.map((action) => action.id)).toEqual(["download", "share"]);
  });

  it("omits download and share when the host passes no handler", async () => {
    const actions = await resolveActions({
      config: { copy: true, open: true }
    });

    expect(actions.map((action) => action.id)).toEqual(["copy", "open"]);
  });

  it("omits copy when the host cannot copy", async () => {
    const actions = await resolveActions({
      config: { copy: true, open: true },
      state: createState({
        capabilities: createCapabilities({ canCopy: false })
      })
    });

    expect(actions.map((action) => action.id)).toEqual(["open"]);
  });

  it("omits copy on external locations", async () => {
    const actions = await resolveActions({
      config: { copy: true, open: true },
      state: createState({
        locationSections: [
          {
            id: "external",
            label: "External",
            locations: [
              {
                externalType: "remote",
                id: "remote",
                kind: "external",
                label: "Remote",
                metadata: {}
              }
            ]
          }
        ],
        selectedLocationId: "remote"
      } as Partial<WorkspaceFileManagerState>)
    });

    expect(actions.map((action) => action.id)).toEqual(["open"]);
  });

  it("honours a custom order", async () => {
    const actions = await resolveActions({
      config: {
        copy: true,
        open: true,
        onDownload: () => {},
        order: ["download", "open", "copy"]
      }
    });

    expect(actions.map((action) => action.id)).toEqual([
      "download",
      "open",
      "copy"
    ]);
  });

  it.each([
    ["busyAction", { busyAction: "view" }],
    ["isLoading", { isLoading: true }],
    ["isMutating", { isMutating: true }]
  ] as const)("disables every action while %s", async (_label, overrides) => {
    const actions = await resolveActions({
      config: { copy: true, open: true, onDownload: () => {} },
      state: createState(overrides as Partial<WorkspaceFileManagerState>)
    });

    expect(actions).not.toHaveLength(0);
    expect(actions.every((action) => action.disabled)).toBe(true);
  });

  it("does not notify the host when the copy did not reach the clipboard", async () => {
    const onCopyEntry = vi.fn();
    const actions = await resolveActions({
      config: { copy: true },
      onCopyEntry,
      session: { copyToClipboard: vi.fn(async () => false) }
    });

    await act(async () => {
      actions[0]?.onSelect();
    });

    expect(onCopyEntry).not.toHaveBeenCalled();
  });

  it("dispatches copy through the session and then notifies the host", async () => {
    const calls: string[] = [];
    const copyToClipboard = vi.fn(async () => {
      calls.push("session");
      return true;
    });
    const onCopyEntry = vi.fn(async () => {
      calls.push("host");
    });
    const actions = await resolveActions({
      config: { copy: true },
      onCopyEntry,
      session: { copyToClipboard }
    });

    await act(async () => {
      actions[0]?.onSelect();
    });

    expect(copyToClipboard).toHaveBeenCalledWith(entry);
    expect(calls).toEqual(["session", "host"]);
  });

  it("dispatches open through the session", async () => {
    const openEntry = vi.fn(async () => {});
    const actions = await resolveActions({
      config: { open: true },
      session: { openEntry }
    });

    await act(async () => {
      actions[0]?.onSelect();
    });

    expect(openEntry).toHaveBeenCalledWith(entry);
  });

  it.each([
    ["download", "onDownload"],
    ["share", "onShare"]
  ] as const)("forwards %s to the host handler", async (id, handlerKey) => {
    const handler = vi.fn();
    const actions = await resolveActions({
      config: { [handlerKey]: handler }
    });

    await act(async () => {
      actions[0]?.onSelect();
    });

    expect(actions[0]?.id).toBe(id);
    expect(handler).toHaveBeenCalledWith(entry);
  });
});
