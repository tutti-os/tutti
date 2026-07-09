import { useEffect, useMemo, useState } from "react";
import { createWorkbenchMissionControlI18nRuntime } from "../mission-control/workbenchMissionControlI18n.ts";
import { createWorkbenchWindowChromeI18nRuntime } from "../react/workbenchWindowI18n.ts";
import type { WorkbenchController } from "../store/types.ts";
import { createWorkbenchHostMissionControlAdapter } from "./missionControlAdapter.ts";
import type { ResolvedWorkbenchHostConfig } from "./hostConfig.ts";
import { createWorkbenchHostSession } from "./session.ts";
import type {
  WorkbenchHostChromeRenderContext,
  WorkbenchHostNodeData,
  WorkbenchHostProps
} from "./types.ts";
import { createWorkbenchHostI18nRuntime } from "./workbenchHostI18n.ts";

export function useWorkbenchHostRuntime({
  debugDiagnostics,
  externalStateSource,
  i18n,
  missionControlEnabled,
  nodes,
  onHandleReady,
  onLaunchRequest,
  onMissionControlAdapterReady,
  onNodeCloseRequest,
  projectedNodes,
  snapshotRepository,
  workspaceId
}: Pick<
  WorkbenchHostProps,
  | "debugDiagnostics"
  | "i18n"
  | "onHandleReady"
  | "onMissionControlAdapterReady"
  | "projectedNodes"
  | "snapshotRepository"
  | "workspaceId"
> &
  Pick<
    ResolvedWorkbenchHostConfig,
    "externalStateSource" | "nodes" | "onLaunchRequest" | "onNodeCloseRequest"
  > & {
    missionControlEnabled: boolean;
  }) {
  const [externalStateRevision, bumpExternalStateRevision] = useState(0);
  const [, bumpHydrationRevision] = useState(0);
  const hostSession = useMemo(() => {
    logWorkbenchHostDebug("create-session", debugDiagnostics, {
      nodeTypeIDs: nodes.map((node) => node.typeId),
      projectedNodeCount: projectedNodes?.length ?? 0,
      workspaceId
    });
    return createWorkbenchHostSession({
      debugDiagnostics,
      externalStateSource,
      nodes,
      onLaunchRequest,
      onNodeCloseRequest,
      projectedNodes: projectedNodes ?? [],
      snapshotRepository,
      workspaceId
    });
  }, [
    debugDiagnostics,
    externalStateSource,
    nodes,
    onLaunchRequest,
    onNodeCloseRequest,
    snapshotRepository,
    workspaceId
  ]);
  const hostI18n = useMemo(() => createWorkbenchHostI18nRuntime(i18n), [i18n]);
  const missionControlI18n = useMemo(
    () => createWorkbenchMissionControlI18nRuntime(i18n),
    [i18n]
  );
  const windowChromeI18n = useMemo(
    () => createWorkbenchWindowChromeI18nRuntime(i18n),
    [i18n]
  );
  const nodeDefinitionByType = useMemo(
    () => new Map(nodes.map((definition) => [definition.typeId, definition])),
    [nodes]
  );
  const isHydrating = hostSession.isHydrating?.() ?? false;
  const missionControlAdapter = useMemo(
    () =>
      missionControlEnabled && !isHydrating
        ? createWorkbenchHostMissionControlAdapter({
            activateNode: hostSession.activateNode.bind(hostSession),
            controller: hostSession.controller
          })
        : null,
    [hostSession.controller, isHydrating, missionControlEnabled]
  );
  const chromeController = useMemo(
    () =>
      isHydrating
        ? createReadOnlyWorkbenchController(hostSession.controller)
        : hostSession.controller,
    [hostSession.controller, isHydrating]
  );
  const chromeContext = useMemo<WorkbenchHostChromeRenderContext>(
    () => ({
      activateNode: hostSession.activateNode.bind(hostSession),
      controller: chromeController,
      focusNode: hostSession.focusNode.bind(hostSession),
      launchNode: hostSession.launchNode.bind(hostSession)
    }),
    [chromeController, hostSession]
  );

  useEffect(() => {
    let isCurrent = true;
    void hostSession.load().finally(() => {
      if (isCurrent) {
        bumpHydrationRevision((revision) => revision + 1);
      }
    });

    return () => {
      isCurrent = false;
      logWorkbenchHostDebug("dispose-session", debugDiagnostics, {
        workspaceId
      });
      hostSession.dispose();
    };
  }, [debugDiagnostics, hostSession, workspaceId]);

  useEffect(() => {
    onHandleReady?.(hostSession);
    return () => {
      onHandleReady?.(null);
    };
  }, [hostSession, onHandleReady]);

  useEffect(() => {
    if (!onMissionControlAdapterReady) {
      return undefined;
    }

    onMissionControlAdapterReady(missionControlAdapter);
    return () => {
      onMissionControlAdapterReady(null);
    };
  }, [missionControlAdapter, onMissionControlAdapterReady]);

  useEffect(() => {
    hostSession.reconcileProjectedNodes(projectedNodes ?? []);
  }, [hostSession, projectedNodes]);

  useEffect(() => {
    if (!externalStateSource?.subscribe) {
      return undefined;
    }

    return externalStateSource.subscribe(() => {
      bumpExternalStateRevision((revision) => revision + 1);
    });
  }, [externalStateSource, workspaceId]);

  return {
    chromeContext,
    externalStateRevision,
    hostI18n,
    isHydrating,
    hostSession,
    missionControlI18n,
    missionControlAdapter,
    nodeDefinitionByType,
    windowChromeI18n
  };
}

const noop = () => {};

const readOnlyWorkbenchCommands = new Proxy(
  {},
  {
    get: () => noop
  }
) as WorkbenchController<WorkbenchHostNodeData>["commands"];

function createReadOnlyWorkbenchController(
  controller: WorkbenchController<WorkbenchHostNodeData>
): WorkbenchController<WorkbenchHostNodeData> {
  return {
    commands: readOnlyWorkbenchCommands,
    dispatch: noop,
    getSnapshot: controller.getSnapshot.bind(controller),
    subscribe: controller.subscribe.bind(controller)
  };
}

function logWorkbenchHostDebug(
  event: string,
  debugDiagnostics: WorkbenchHostProps["debugDiagnostics"],
  payload: Record<string, unknown>
): void {
  if (!debugDiagnostics?.isEnabled()) {
    return;
  }

  console.info("[workbench:host]", {
    event,
    ...payload
  });
  void Promise.resolve(
    debugDiagnostics.log?.({
      details: payload,
      event,
      level: "info",
      source: "workbench-host",
      workspaceId:
        typeof payload.workspaceId === "string" ? payload.workspaceId : null
    })
  ).catch(() => undefined);
}
