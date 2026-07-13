import { useCallback, useEffect, type ReactNode } from "react";
import { Button } from "@tutti-os/ui-system";
import type {
  DesktopApi,
  DesktopWorkspaceAppExternalHostApi
} from "@preload/types";
import type { DesktopFusionWindowKind } from "@shared/contracts/fusion.ts";
import { useWorkspaceCatalogService } from "@renderer/features/workspace-catalog";
import { useTranslation } from "@renderer/i18n";
import { FusionFallbackWindowChrome } from "./FusionFallbackWindowChrome.tsx";
import { StandaloneWorkbenchNodeWindow } from "./StandaloneWorkbenchNodeWindow.tsx";

export interface FusionToolWindowProps {
  desktopApi: DesktopApi;
  kind: DesktopFusionWindowKind;
  launchPayload?: unknown;
  resourceId?: string | null;
  windowInstanceId: string;
  workspaceAppExternalApi?: DesktopWorkspaceAppExternalHostApi;
  workspaceId: string;
}

export function FusionToolWindow(props: FusionToolWindowProps): ReactNode {
  const { service, state } = useWorkspaceCatalogService();
  const { t } = useTranslation();
  const load = useCallback(() => {
    void service.loadWorkspaceWindow(props.workspaceId, "fusion-tool");
  }, [props.workspaceId, service]);

  useEffect(() => {
    load();
  }, [load]);

  if (state.status === "unavailable") {
    return (
      <FusionFallbackWindowChrome
        desktopApi={props.desktopApi}
        title={t("workspace.fusion.toolUnavailableTitle")}
      >
        <div className="grid h-full place-items-center p-8 text-center">
          <div className="flex max-w-md flex-col items-center gap-3">
            <h1 className="m-0 text-base font-semibold text-[var(--text-primary)]">
              {t("workspace.fallback.unavailableTitle")}
            </h1>
            <p className="m-0 text-sm text-[var(--text-secondary)]">
              {t("workspace.fusion.toolUnavailable")}
            </p>
            <Button onClick={load}>
              {t("workspace.fallback.retryAction")}
            </Button>
          </div>
        </div>
      </FusionFallbackWindowChrome>
    );
  }

  if (state.status === "loading" || !state.workspace) {
    return (
      <FusionFallbackWindowChrome
        desktopApi={props.desktopApi}
        title={t("workspace.fusion.toolLoading")}
      >
        <div className="grid h-full place-items-center p-8 text-center">
          <div className="flex max-w-md flex-col items-center gap-2">
            <h1 className="m-0 text-base font-semibold text-[var(--text-primary)]">
              {t("workspace.fallback.loadingTitle")}
            </h1>
            <p className="m-0 text-sm text-[var(--text-secondary)]">
              {t("workspace.fallback.loadingDescription")}
            </p>
          </div>
        </div>
      </FusionFallbackWindowChrome>
    );
  }

  return (
    <StandaloneWorkbenchNodeWindow
      desktopApi={props.desktopApi}
      kind={props.kind}
      launchPayload={props.launchPayload}
      resourceId={props.resourceId}
      windowInstanceId={props.windowInstanceId}
      workspace={state.workspace}
      workspaceAppExternalApi={props.workspaceAppExternalApi}
    />
  );
}
