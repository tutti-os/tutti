import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { WorkbenchSnapshot } from "@tutti-os/workbench-snapshot";
import { WorkbenchHost } from "./WorkbenchHost.tsx";
import type {
  WorkbenchContribution,
  WorkbenchHostDockEntryPresentationOverrides,
  WorkbenchHostHandle,
  WorkbenchHostSnapshotRepository
} from "./types.ts";

describe("WorkbenchHost", () => {
  it("keeps the host session when Dock presentation overrides change identity", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onHandleReady = vi.fn<(handle: WorkbenchHostHandle | null) => void>();
    const contribution: WorkbenchContribution = {
      dockEntries: [
        {
          icon: null,
          id: "browser",
          label: "Browser",
          typeId: "browser"
        }
      ],
      id: "browser"
    };
    const contributions = [contribution];
    const snapshotRepository: WorkbenchHostSnapshotRepository = {
      async load() {
        return null;
      },
      save(_workspaceId: string, snapshot: WorkbenchSnapshot) {
        return snapshot;
      }
    };
    const firstOverrides: WorkbenchHostDockEntryPresentationOverrides = {
      browser: { visibility: "always" }
    };
    const secondOverrides: WorkbenchHostDockEntryPresentationOverrides = {
      browser: {
        dockRetention: {
          actionId: "workspace-dock-retention:browser",
          retained: false
        },
        visibility: "when-open"
      }
    };
    const previousActEnvironment = (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT;
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <WorkbenchHost
            contributions={contributions}
            dockEntryPresentationOverrides={firstOverrides}
            onHandleReady={onHandleReady}
            snapshotRepository={snapshotRepository}
            workspaceId="workspace-1"
          />
        );
      });
      const firstHandle = onHandleReady.mock.calls[0]?.[0];
      expect(firstHandle).toBeTruthy();
      expect(onHandleReady).toHaveBeenCalledTimes(1);

      await act(async () => {
        root.render(
          <WorkbenchHost
            contributions={contributions}
            dockEntryPresentationOverrides={secondOverrides}
            onHandleReady={onHandleReady}
            snapshotRepository={snapshotRepository}
            workspaceId="workspace-1"
          />
        );
      });

      expect(onHandleReady).toHaveBeenCalledTimes(1);
      expect(onHandleReady.mock.calls[0]?.[0]).toBe(firstHandle);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      (
        globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
});
