import type { DesktopRuntimeApi } from "@preload/types";
import type { WorkbenchDiagnosticsPort } from "../workbenchHostPorts.ts";

export function createDesktopWorkbenchDiagnosticsPort(input: {
  readonly runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
  readonly workspaceId: string;
}): WorkbenchDiagnosticsPort {
  return {
    report(diagnostic) {
      return input.runtimeApi.logRendererDiagnostic({
        details: { error: formatDiagnosticError(diagnostic.error) },
        event: diagnostic.event,
        level: "warn",
        source:
          diagnostic.event === "workbench.host.session.dispose_failed"
            ? "workbench-host-session"
            : "workbench-host-coordinator",
        workspaceId: input.workspaceId
      });
    }
  };
}

function formatDiagnosticError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
