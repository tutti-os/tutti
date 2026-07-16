import { useEffect, type ReactNode } from "react";
import { InstantiationContext } from "@tutti-os/infra/di";
import { AnalyticsDebugFloatingEntryGate } from "@renderer/features/analytics-debug";
import { useTranslation } from "../../../i18n";
import { Toast } from "../../../lib/toast";
import type { WorkspaceWindowContainerResult } from "./createWorkspaceWindowContainer";

export interface WorkspaceWindowContainerHostInput extends WorkspaceWindowContainerResult {
  workspaceID: string | null;
}

export function WorkspaceWindowContainerHost({
  children,
  containerInput
}: {
  children: (input: WorkspaceWindowContainerHostInput) => ReactNode;
  containerInput: WorkspaceWindowContainerResult;
}) {
  const { container, hostWindowApi, startupWorkspaceID } = containerInput;
  const requestedWorkspaceID = new URLSearchParams(window.location.search).get(
    "workspaceId"
  );
  const workspaceID = requestedWorkspaceID || startupWorkspaceID;
  const { t } = useTranslation();

  useEffect(() => {
    containerInput.markCommitted();
  }, [containerInput]);

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
