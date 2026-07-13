import { useEffect, useMemo, type ReactNode } from "react";
import { InstantiationContext } from "@tutti-os/infra/di";
import { AnalyticsDebugFloatingEntryGate } from "@renderer/features/analytics-debug";
import { useTranslation } from "../../../i18n";
import { Toast } from "../../../lib/toast";
import {
  createWorkspaceWindowContainer,
  type WorkspaceWindowContainerResult
} from "./createWorkspaceWindowContainer";
import { createDeferredWorkspaceContainerDispose } from "./deferredWorkspaceContainerDispose";

export interface WorkspaceWindowContainerHostInput extends WorkspaceWindowContainerResult {
  workspaceID: string | null;
}

export function WorkspaceWindowContainerHost({
  children
}: {
  children: (input: WorkspaceWindowContainerHostInput) => ReactNode;
}) {
  const containerInput = useMemo(() => createWorkspaceWindowContainer(), []);
  const { container, hostWindowApi, startupWorkspaceID } = containerInput;
  const containerDispose = useMemo(
    () => createDeferredWorkspaceContainerDispose(() => container.dispose()),
    [container]
  );
  const requestedWorkspaceID = new URLSearchParams(window.location.search).get(
    "workspaceId"
  );
  const workspaceID = requestedWorkspaceID || startupWorkspaceID;
  const { t } = useTranslation();

  useEffect(() => {
    containerDispose.cancel();
    return () => {
      containerDispose.schedule();
    };
  }, [containerDispose]);

  useEffect(() => {
    return hostWindowApi.onQuitShortcutToast(() => {
      Toast.tips(t("desktop.quitShortcut.confirmToastTitle"));
    });
  }, [hostWindowApi, t]);

  return (
    <InstantiationContext instantiationService={container}>
      {children({ ...containerInput, workspaceID })}
      <AnalyticsDebugFloatingEntryGate />
    </InstantiationContext>
  );
}
