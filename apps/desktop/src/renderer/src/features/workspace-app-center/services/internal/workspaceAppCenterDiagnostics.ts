import { normalizeTuttidError } from "@tutti-os/client-tuttid-ts";
import type { DesktopRuntimeApi } from "@preload/types";
import type { WorkspaceAppCenterOperationDetails } from "@tutti-os/workspace-app-center/core";
import { getDesktopErrorCode } from "../../../../lib/desktopErrors.ts";

export function recordWorkspaceAppCenterOperationFailure(input: {
  details: WorkspaceAppCenterOperationDetails;
  error: unknown;
  runtimeApi?: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
  toastMessage: string;
}): void {
  if (!input.runtimeApi) {
    return;
  }

  const protocolError = normalizeTuttidError(input.error);
  void input.runtimeApi
    .logRendererDiagnostic({
      details: {
        ...input.details,
        developerMessage:
          protocolError?.developerMessage ??
          (input.error instanceof Error ? input.error.message : null),
        errorCode:
          protocolError?.code ?? getDesktopErrorCode(input.error) ?? null,
        params: protocolError?.params ?? null,
        reason: protocolError?.reason ?? null,
        retryable: protocolError?.retryable ?? null,
        statusCode: protocolError?.statusCode ?? null,
        toastMessage: input.toastMessage,
        uiAction: input.details.uiAction ?? input.details.operation
      },
      event: "workspace_app_center_operation_failed",
      level: "warn",
      source: "workspace-app-center",
      workspaceId: input.details.workspaceId
    })
    .catch(() => undefined);
}
