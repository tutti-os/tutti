import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  WorkspaceAgentProvider,
  WorkspaceSummary
} from "@tutti-os/client-tuttid-ts";
import { AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT } from "@tutti-os/agent-gui/workbench/contribution";
import { ExternalAgentSessionImportPrompt } from "./ExternalAgentSessionImportPrompt.tsx";
import { ExternalAgentSessionImportWizard } from "./ExternalAgentSessionImportWizard.tsx";

export function useWorkspaceExternalAgentSessionImportHost(input: {
  enabled?: boolean;
  workspace: WorkspaceSummary;
}): {
  host: ReactNode;
  openExternalAgentImport(providers?: WorkspaceAgentProvider[]): void;
} {
  const enabled = input.enabled !== false;
  const [initialProviders, setInitialProviders] =
    useState<WorkspaceAgentProvider[]>();
  const [open, setOpen] = useState(false);
  const openExternalAgentImport = useCallback(
    (providers?: WorkspaceAgentProvider[]) => {
      if (!enabled) {
        return;
      }
      setInitialProviders(providers);
      setOpen(true);
    },
    [enabled]
  );

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const openImportWizard = (): void => openExternalAgentImport();
    window.addEventListener(
      AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT,
      openImportWizard
    );
    return () => {
      window.removeEventListener(
        AGENT_GUI_WORKBENCH_OPEN_EXTERNAL_IMPORT_EVENT,
        openImportWizard
      );
    };
  }, [enabled, openExternalAgentImport]);

  return {
    host: enabled ? (
      <>
        <ExternalAgentSessionImportPrompt
          workspaceId={input.workspace.id}
          onOpenImport={openExternalAgentImport}
        />
        <ExternalAgentSessionImportWizard
          initialProviders={initialProviders}
          open={open}
          workspace={input.workspace}
          onOpenChange={setOpen}
        />
      </>
    ) : null,
    openExternalAgentImport
  };
}
