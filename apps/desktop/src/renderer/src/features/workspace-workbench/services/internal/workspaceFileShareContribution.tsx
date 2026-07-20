import { createElement, lazy, Suspense } from "react";
import { FileTextIcon } from "@tutti-os/ui-system";
import type {
  WorkbenchContribution,
  WorkbenchFrame,
  WorkbenchHostDockEntry
} from "@tutti-os/workbench-surface";

export const workspaceFileShareNodeID = "file-share-link";

const workspaceFileShareNodeFrame: WorkbenchFrame = {
  height: 760,
  width: 1180,
  x: 200,
  y: 60
};

const LazyFileShareLinkDemo = lazy(() =>
  import("@renderer/features/workspace-file-share/ui/FileShareLinkDemo.tsx").then(
    (module) => ({ default: module.FileShareLinkDemo })
  )
);

function FileShareLinkBody({ loadingLabel }: { loadingLabel: string }) {
  return createElement(
    Suspense,
    {
      fallback: createElement(
        "div",
        {
          className:
            "flex size-full items-center justify-center bg-[var(--background-panel)] text-sm text-[var(--text-tertiary)]"
        },
        loadingLabel
      )
    },
    createElement(LazyFileShareLinkDemo)
  );
}

export function createWorkspaceFileShareContribution(input: {
  label: string;
  loadingLabel: string;
}): WorkbenchContribution {
  return {
    dockEntries: [
      {
        icon: createElement(FileTextIcon, { className: "size-4" }),
        id: workspaceFileShareNodeID,
        label: input.label,
        launchBehavior: "enabled",
        matchNode: (node) => node.data.typeId === workspaceFileShareNodeID,
        order: 7,
        sectionId: "apps",
        typeId: workspaceFileShareNodeID,
        visibility: "always"
      } satisfies WorkbenchHostDockEntry
    ],
    id: "workspace-file-share",
    nodes: [
      {
        frame: workspaceFileShareNodeFrame,
        instance: { mode: "single" },
        renderBody: () =>
          createElement(FileShareLinkBody, {
            loadingLabel: input.loadingLabel
          }),
        title: input.label,
        typeId: workspaceFileShareNodeID,
        window: {
          closable: true,
          defaultOpen: false,
          fullscreenHeaderMode: "persistent",
          minimizedDock: { kind: "snapshot" },
          minimizable: true
        }
      }
    ],
    onLaunchRequest: (request) =>
      request.typeId === workspaceFileShareNodeID
        ? {
            defaultFrame: workspaceFileShareNodeFrame,
            dockEntryId: workspaceFileShareNodeID,
            framePolicy: "cascade",
            instanceId: workspaceFileShareNodeID,
            title: input.label,
            typeId: workspaceFileShareNodeID
          }
        : null
  };
}
