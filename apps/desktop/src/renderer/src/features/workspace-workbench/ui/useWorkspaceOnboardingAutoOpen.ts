import { useEffect, useRef } from "react";
import type { WorkbenchHostHandle } from "@tutti-os/workbench-surface";
import { workspaceOnboardingAppId } from "../services/workspaceOnboarding.ts";
import type { IWorkspaceWorkbenchHostService } from "../services/workspaceWorkbenchHostService.interface.ts";

interface WorkspaceOnboardingApp {
  appId: string;
  installed?: boolean;
}

interface WorkspaceOnboardingAppCenterService {
  readonly store: {
    readonly apps: readonly WorkspaceOnboardingApp[];
  };
  refresh(workspaceId: string): Promise<void>;
  refreshCatalog(workspaceId: string): Promise<void>;
  installApp(input: { appId: string; workspaceId: string }): Promise<void>;
  openApp(input: { appId: string; workspaceId: string }): Promise<boolean>;
}

export type WorkspaceOnboardingAutoOpenResult =
  | "already-opened"
  | "canceled"
  | "not-found"
  | "not-opened"
  | "opened";

interface OpenWorkspaceOnboardingInput {
  appCenterService: WorkspaceOnboardingAppCenterService;
  appId?: string;
  isCanceled?: () => boolean;
  maxAttempts?: number;
  wait?: (delayMs: number) => Promise<void>;
  workbenchHostService: Pick<
    IWorkspaceWorkbenchHostService,
    "hasWorkspaceOnboardingAutoOpened" | "markWorkspaceOnboardingAutoOpened"
  >;
  workspaceId: string;
}

export async function openWorkspaceOnboardingIfNeeded({
  appCenterService,
  appId = workspaceOnboardingAppId,
  isCanceled = () => false,
  maxAttempts = 20,
  wait = defaultWait,
  workbenchHostService,
  workspaceId
}: OpenWorkspaceOnboardingInput): Promise<WorkspaceOnboardingAutoOpenResult> {
  if (isCanceled()) {
    return "canceled";
  }
  if (
    await workbenchHostService.hasWorkspaceOnboardingAutoOpened(workspaceId)
  ) {
    return "already-opened";
  }

  await appCenterService.refreshCatalog(workspaceId);

  let openAttempted = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isCanceled()) {
      return "canceled";
    }
    await appCenterService.refresh(workspaceId);
    const app = appCenterService.store.apps.find(
      (candidate) => candidate.appId === appId
    );
    if (!app) {
      await wait(500);
      continue;
    }
    if (!app.installed) {
      await appCenterService.installApp({ appId, workspaceId });
      await wait(500);
      continue;
    }

    openAttempted = true;
    const opened = await appCenterService.openApp({ appId, workspaceId });
    if (!opened) {
      await wait(500);
      continue;
    }
    if (isCanceled()) {
      return "canceled";
    }
    await workbenchHostService.markWorkspaceOnboardingAutoOpened(workspaceId);
    return "opened";
  }

  if (isCanceled()) {
    return "canceled";
  }
  return openAttempted ? "not-opened" : "not-found";
}

export function useWorkspaceOnboardingAutoOpen({
  appCenterService,
  workbenchHost,
  workbenchHostService,
  workspaceId
}: {
  appCenterService: WorkspaceOnboardingAppCenterService;
  workbenchHost: WorkbenchHostHandle | null;
  workbenchHostService: OpenWorkspaceOnboardingInput["workbenchHostService"];
  workspaceId: string;
}): void {
  const activeWorkspaceIdsRef = useRef(new Set<string>());

  useEffect(() => {
    const normalizedWorkspaceId = workspaceId.trim();
    if (!workbenchHost || !normalizedWorkspaceId) {
      return;
    }
    if (activeWorkspaceIdsRef.current.has(normalizedWorkspaceId)) {
      return;
    }

    let canceled = false;
    activeWorkspaceIdsRef.current.add(normalizedWorkspaceId);
    void openWorkspaceOnboardingIfNeeded({
      appCenterService,
      isCanceled: () => canceled,
      workbenchHostService,
      workspaceId: normalizedWorkspaceId
    })
      .catch(() => {})
      .finally(() => {
        activeWorkspaceIdsRef.current.delete(normalizedWorkspaceId);
      });

    return () => {
      canceled = true;
      activeWorkspaceIdsRef.current.delete(normalizedWorkspaceId);
    };
  }, [appCenterService, workbenchHost, workbenchHostService, workspaceId]);
}

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
