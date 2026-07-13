import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopRuntimeApi } from "@preload/types";
import { createDesktopWorkbenchDiagnosticsPort } from "./desktopWorkbenchDiagnosticsPort.ts";

test("desktop workbench diagnostics adapter preserves product logging ownership", async () => {
  const diagnostics: unknown[] = [];
  const port = createDesktopWorkbenchDiagnosticsPort({
    runtimeApi: {
      logRendererDiagnostic(input) {
        diagnostics.push(input);
        return Promise.resolve();
      }
    } as Pick<DesktopRuntimeApi, "logRendererDiagnostic">,
    workspaceId: "workspace-1"
  });

  await port.report({
    error: new Error("cleanup failed"),
    event: "workbench.host.session.dispose_failed"
  });

  assert.deepEqual(diagnostics, [
    {
      details: { error: "cleanup failed" },
      event: "workbench.host.session.dispose_failed",
      level: "warn",
      source: "workbench-host-session",
      workspaceId: "workspace-1"
    }
  ]);
});
