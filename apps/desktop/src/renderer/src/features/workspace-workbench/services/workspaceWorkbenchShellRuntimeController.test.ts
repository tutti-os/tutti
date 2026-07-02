import assert from "node:assert/strict";
import test from "node:test";
import type {
  WorkbenchHostHandle,
  WorkbenchHostNodeData,
  WorkbenchMissionControlAdapter
} from "@tutti-os/workbench-surface";
import type { I18nRuntime } from "@tutti-os/ui-i18n-runtime";
import type { WorkspaceWorkbenchDesktopI18nRuntime } from "@shared/i18n";
import type { ReporterEventInput } from "../../analytics/services/reporterService.interface.ts";
import type {
  IWorkspaceWorkbenchHostService,
  WorkspaceWorkbenchHostInput
} from "./workspaceWorkbenchHostService.interface";
import type {
  WorkspaceWallpaperDisplayMode,
  WorkspaceWallpaperId
} from "./workspaceWallpaper.ts";
import { createWorkspaceWorkbenchShellRuntimeController } from "./workspaceWorkbenchShellRuntimeController.ts";

test("workspace workbench shell runtime controller combines child snapshots", async () => {
  const controller = createWorkspaceWorkbenchShellRuntimeController({
    hostInput: createShellHostInput({
      hostInput: createHostInput("workspace-1")
    }),
    wallpaperSelection: createWallpaperInput({
      workspaceId: "workspace-1",
      wallpaperId: "default"
    })
  });
  const modes: (string | null)[] = [];
  controller.subscribe(() => {
    modes.push(controller.getSnapshot().missionControl.mode);
  });

  controller.missionControl.setAdapter(createMissionControlAdapter(2));
  controller.missionControl.open("activate");

  assert.equal(controller.getSnapshot().missionControl.mode, "activate");
  assert.equal(controller.getSnapshot().missionControl.isOpen, true);
  assert.deepEqual(modes, [null, "activate"]);

  const confirmation = controller.closeDialog.requestConfirmation({
    cancelLabel: "Cancel",
    confirmLabel: "Close",
    description: "There is work running.",
    scope: "window",
    title: "Close?"
  });
  assert.equal(controller.getSnapshot().closeDialog.request?.title, "Close?");

  controller.closeDialog.confirm();
  assert.equal(await confirmation, true);
  assert.equal(controller.getSnapshot().closeDialog.request, null);
});

test("workspace workbench shell runtime controller updates wallpaper input", () => {
  const controller = createWorkspaceWorkbenchShellRuntimeController({
    hostInput: createShellHostInput({
      hostInput: createHostInput("workspace-1")
    }),
    wallpaperSelection: createWallpaperInput({
      workspaceId: "workspace-1",
      wallpaperId: "sky"
    })
  });

  controller.updateWallpaperSelection(
    createWallpaperInput({
      workspaceId: "workspace-2",
      wallpaperId: "ocean"
    })
  );

  assert.equal(
    controller.getSnapshot().wallpaperSelection.selectedWallpaperID,
    "ocean"
  );
});

test("workspace workbench shell runtime controller passes reporter to close guard dialog", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const controller = createWorkspaceWorkbenchShellRuntimeController({
    hostInput: createShellHostInput({
      hostInput: createHostInput("workspace-1")
    }),
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => 1749124800000,
    wallpaperSelection: createWallpaperInput({
      workspaceId: "workspace-1",
      wallpaperId: "default"
    })
  });
  const confirmation = controller.closeDialog.requestConfirmation({
    cancelLabel: "Cancel",
    confirmLabel: "Close",
    description: "There is work running.",
    scope: "window",
    title: "Close?"
  });

  controller.closeDialog.confirm();

  assert.equal(await confirmation, true);
  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "workspace.close_guard_shown",
        params: {}
      }
    ],
    [
      {
        clientTS: 1749124800000,
        name: "workspace.close_guard_confirmed",
        params: {}
      }
    ]
  ]);
});

test("workspace workbench shell runtime controller passes reporter to mission control", () => {
  const reporterCalls: ReporterEventInput[][] = [];
  let now = 1749124800000;
  const controller = createWorkspaceWorkbenchShellRuntimeController({
    hostInput: createShellHostInput({
      hostInput: createHostInput("workspace-1")
    }),
    reporterService: createReporterService(reporterCalls),
    reporterNow: () => now,
    wallpaperSelection: createWallpaperInput({
      workspaceId: "workspace-1",
      wallpaperId: "default"
    })
  });

  controller.missionControl.setAdapter(createMissionControlAdapter(2));
  controller.missionControl.open("activate", "keyboard");
  now = 1749124800123;
  controller.missionControl.close();

  assert.deepEqual(reporterCalls, [
    [
      {
        clientTS: 1749124800000,
        name: "mission_control.activated",
        params: {
          mode: "activate",
          trigger: "keyboard",
          window_count: 2
        }
      }
    ],
    [
      {
        clientTS: 1749124800123,
        name: "mission_control.deactivated",
        params: {
          duration_ms: 123
        }
      }
    ]
  ]);
});

function createReporterService(calls: ReporterEventInput[][] = []) {
  return {
    async trackEvents(events: ReporterEventInput[]) {
      calls.push(events);
    }
  };
}

test("workspace workbench shell runtime controller keeps subscriptions after dispose cleanup", () => {
  const controller = createWorkspaceWorkbenchShellRuntimeController({
    hostInput: createShellHostInput({
      hostInput: createHostInput("workspace-1")
    }),
    wallpaperSelection: createWallpaperInput({
      workspaceId: "workspace-1",
      wallpaperId: "default"
    })
  });
  const modes: (string | null)[] = [];
  controller.subscribe(() => {
    modes.push(controller.getSnapshot().missionControl.mode);
  });

  controller.dispose();
  controller.missionControl.setAdapter(createMissionControlAdapter(2));
  controller.missionControl.open("layout");

  assert.equal(controller.getSnapshot().missionControl.mode, "layout");
  assert.deepEqual(modes, [null, "layout"]);
});

test("workspace workbench shell runtime controller dispose cancels pending close confirmation", async () => {
  const controller = createWorkspaceWorkbenchShellRuntimeController({
    hostInput: createShellHostInput({
      hostInput: createHostInput("workspace-1")
    }),
    wallpaperSelection: createWallpaperInput({
      workspaceId: "workspace-1",
      wallpaperId: "default"
    })
  });
  const confirmation = controller.closeDialog.requestConfirmation({
    cancelLabel: "Cancel",
    confirmLabel: "Close",
    description: "There is work running.",
    scope: "window",
    title: "Close?"
  });

  controller.dispose();

  assert.equal(await confirmation, false);
  assert.equal(controller.getSnapshot().closeDialog.request, null);
});

test("workspace workbench shell runtime controller requests window close with latest host input", async () => {
  const firstHost = createHost("host-1");
  const secondHost = createHost("host-2");
  const firstHostInput = createHostInput("workspace-1");
  const secondHostInput = createHostInput("workspace-2");
  const closeRequests: {
    host: WorkbenchHostHandle | null;
    hostInput: WorkspaceWorkbenchHostInput;
  }[] = [];
  const controller = createWorkspaceWorkbenchShellRuntimeController({
    hostInput: createShellHostInput({
      closeRequests,
      hostInput: firstHostInput
    }),
    wallpaperSelection: createWallpaperInput({
      workspaceId: "workspace-1",
      wallpaperId: "default"
    })
  });

  controller.setWorkbenchHost(firstHost);
  await controller.requestWindowClose();

  controller.setWorkbenchHost(secondHost);
  controller.updateHostInput(
    createShellHostInput({
      closeRequests,
      hostInput: secondHostInput
    })
  );
  await controller.requestWindowClose();

  assert.deepEqual(closeRequests, [
    {
      host: firstHost,
      hostInput: firstHostInput
    },
    {
      host: secondHost,
      hostInput: secondHostInput
    }
  ]);
});

test("workspace workbench shell runtime controller publishes host input updates", () => {
  const firstHostInput = createHostInput("workspace-1");
  const secondHostInput = createHostInput("workspace-2");
  const controller = createWorkspaceWorkbenchShellRuntimeController({
    hostInput: createShellHostInput({
      hostInput: firstHostInput
    }),
    wallpaperSelection: createWallpaperInput({
      workspaceId: "workspace-1",
      wallpaperId: "default"
    })
  });
  const workspaceIds: string[] = [];
  controller.subscribe(() => {
    workspaceIds.push(controller.getSnapshot().hostInput.workspaceId);
  });

  controller.updateHostInput(
    createShellHostInput({
      hostInput: secondHostInput,
      workspaceId: "workspace-2"
    })
  );

  assert.equal(controller.getSnapshot().hostInput, secondHostInput);
  assert.deepEqual(workspaceIds, ["workspace-2"]);
});

function createWallpaperInput(input: {
  displayMode?: WorkspaceWallpaperDisplayMode;
  wallpaperId: WorkspaceWallpaperId;
  workspaceId: string;
}) {
  return {
    appearance: "light" as const,
    customWallpaperUrl: null,
    readDisplayMode: () => input.displayMode ?? "original",
    readWallpaperId: () => input.wallpaperId,
    workspaceId: input.workspaceId,
    writeDisplayMode() {
      return undefined;
    },
    writeWallpaperId() {
      return undefined;
    }
  };
}

function createHost(id: string): WorkbenchHostHandle {
  return {
    activateNode() {
      return undefined;
    },
    closeNode() {
      return undefined;
    },
    collectWindowCloseEffects: async () => [],
    dispose() {
      return undefined;
    },
    exitFullscreenNode() {
      return undefined;
    },
    focusNode() {
      return undefined;
    },
    getSnapshot() {
      return { id } as never;
    },
    launchNode: async () => null,
    load: async () => undefined,
    minimizeNode() {
      return undefined;
    },
    reconcileProjectedNodes() {
      return undefined;
    },
    requestNodeClose() {
      return undefined;
    },
    setNodeRuntimeState() {
      return undefined;
    },
    setNodeSizeConstraints() {
      return undefined;
    },
    setSnapshotNodeState() {
      return undefined;
    },
    setNodeTitle() {
      return undefined;
    }
  };
}

function createHostInput(workspaceId: string): WorkspaceWorkbenchHostInput {
  return {
    snapshotRepository: {} as never,
    workspaceId
  };
}

function createShellHostInput(input: {
  closeRequests?: {
    host: WorkbenchHostHandle | null;
    hostInput: WorkspaceWorkbenchHostInput;
  }[];
  hostInput: WorkspaceWorkbenchHostInput;
  workspaceId?: string;
}) {
  return {
    appI18n: {} as I18nRuntime<string>,
    agentDockLayout: "legacySplit" as const,
    createHostInput: () => input.hostInput,
    dockIconStyle: "default" as const,
    i18n: {} as WorkspaceWorkbenchDesktopI18nRuntime,
    renderFilesNodeBody: () => null,
    requestWindowClose: async (
      request: Parameters<
        IWorkspaceWorkbenchHostService["requestWindowClose"]
      >[0]
    ) => {
      input.closeRequests?.push({
        host: request.host,
        hostInput: request.hostInput
      });
      return "approved" as const;
    },
    themeAppearance: "light" as const,
    workspaceId: input.workspaceId ?? input.hostInput.workspaceId
  };
}

function createMissionControlAdapter(
  visibleNodeCount: number
): WorkbenchMissionControlAdapter<WorkbenchHostNodeData> {
  return {
    applyLayoutPreset() {},
    focusNode() {},
    getSnapshot() {
      return {
        layoutConstraints: {
          minHeight: 160,
          minWidth: 280,
          safeArea: {
            bottom: 88,
            left: 0,
            right: 0,
            top: 52
          },
          surfacePadding: 0
        },
        surfaceSize: {
          height: 600,
          width: 800
        },
        visibleNodes: Array.from({ length: visibleNodeCount }, (_, index) => ({
          id: `node-${index}`
        })) as never
      };
    },
    subscribe() {
      return () => {};
    }
  };
}
