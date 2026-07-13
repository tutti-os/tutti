import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import { Button, CloseIcon, toast } from "@tutti-os/ui-system";
import { useService } from "@tutti-os/infra/di";
import { IAgentProviderStatusService } from "@renderer/features/workspace-agent/services/agentProviderStatusService.interface.ts";
import { useTranslation } from "@renderer/i18n";
import { resolveWorkspaceAgentGuiLabel } from "../services/workspaceAgentProviderCatalog";

const externalImportPromptProviders: WorkspaceAgentProvider[] = [
  "codex",
  "claude-code"
];

export function ExternalAgentSessionImportPrompt({
  onOpenImport,
  workspaceId
}: {
  onOpenImport: (providers: WorkspaceAgentProvider[]) => void;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const agentProviderStatusService = useService(IAgentProviderStatusService);
  const shownToastIds = useRef<Set<string>>(new Set());
  const snapshot = useSyncExternalStore(
    (listener) => agentProviderStatusService.subscribe(listener),
    () => agentProviderStatusService.getSnapshot(),
    () => agentProviderStatusService.getSnapshot()
  );
  const readyProviders = useMemo(
    () =>
      externalImportPromptProviders.filter((provider) => {
        const status = snapshot.statuses.find(
          (candidate) => candidate.provider === provider
        );
        return status?.availability.status === "ready";
      }),
    [snapshot.statuses]
  );

  useEffect(() => {
    void agentProviderStatusService.ensureLoaded({
      providers: externalImportPromptProviders
    });
  }, [agentProviderStatusService]);

  useEffect(() => {
    const providers = readyProviders.filter((provider) => {
      const promptKey = externalImportPromptKey(workspaceId, provider);
      return (
        !externalImportPromptMarked(workspaceId, provider) &&
        !shownToastIds.current.has(promptKey)
      );
    });
    if (providers.length === 0) {
      return;
    }
    for (const provider of providers) {
      shownToastIds.current.add(externalImportPromptKey(workspaceId, provider));
      markExternalImportPrompt(workspaceId, provider);
    }
    const providerNames = providers
      .map((provider) => resolveWorkspaceAgentGuiLabel(provider))
      .join(" / ");
    toast.custom(
      (id) => (
        <article className="relative w-full min-w-0 overflow-visible rounded-[12px] border border-[var(--line-2)] bg-[var(--background-fronted)] p-3.5 shadow-[0_14px_40px_var(--shadow-elevated)]">
          <Button
            type="button"
            aria-label={t("common.close")}
            className="workspace-agent-decision-toast__close absolute top-0 right-0 z-[2] size-6 translate-x-[35%] -translate-y-[35%] rounded-full border-[var(--line-2)] bg-[var(--background-panel)] text-[var(--text-secondary)] shadow-sm hover:bg-[var(--background-fronted)] hover:text-[var(--text-primary)] focus-visible:ring-[color-mix(in_srgb,var(--border-focus)_30%,transparent)]"
            size="icon-xs"
            variant="chrome"
            onClick={() => toast.dismiss(id)}
          >
            <CloseIcon className="size-4" />
          </Button>
          <div className="workspace-agent-decision-toast__content relative z-[1] grid min-w-0 gap-3 transition-opacity">
            <div className="grid min-w-0 gap-1 pr-3">
              <h3 className="m-0 text-[13px] font-semibold leading-5 text-[var(--text-primary)]">
                {t("workspace.externalImport.promptTitle")}
              </h3>
              <p className="m-0 text-[12px] font-normal leading-5 text-[var(--text-secondary)]">
                {t("workspace.externalImport.promptDescription", {
                  provider: providerNames
                })}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => toast.dismiss(id)}
              >
                {t("workspace.externalImport.promptLater")}
              </Button>
              <Button
                size="sm"
                type="button"
                onClick={() => {
                  toast.dismiss(id);
                  onOpenImport(providers);
                }}
              >
                {t("workspace.externalImport.promptImport")}
              </Button>
            </div>
          </div>
        </article>
      ),
      {
        className: "workspace-agent-decision-toast",
        duration: 16000
      }
    );
  }, [onOpenImport, readyProviders, t, workspaceId]);

  return null;
}

function externalImportPromptMarked(
  workspaceId: string,
  provider: WorkspaceAgentProvider
): boolean {
  return (
    localStorage.getItem(externalImportPromptKey(workspaceId, provider)) === "1"
  );
}

function markExternalImportPrompt(
  workspaceId: string,
  provider: WorkspaceAgentProvider
): void {
  localStorage.setItem(externalImportPromptKey(workspaceId, provider), "1");
}

function externalImportPromptKey(
  workspaceId: string,
  provider: WorkspaceAgentProvider
): string {
  return `tutti.externalAgentImportPrompt.v1.${workspaceId}.${provider}`;
}
