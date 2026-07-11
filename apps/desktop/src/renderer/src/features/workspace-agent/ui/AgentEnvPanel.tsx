import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX
} from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  RefreshIcon,
  StatusDot,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UnderlineTabs
} from "@tutti-os/ui-system";
import {
  closeAgentEnvPanel,
  projectAgentEnvProvider,
  useAgentEnvPanelRequest,
  type AgentEnvProviderStatusKind
} from "@tutti-os/agent-gui/agent-env";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences";
import { useTranslation } from "@renderer/i18n";
import type { IAgentProviderStatusService } from "../services/agentProviderStatusService.interface";
import { desktopManagedAgentProviders } from "../services/internal/desktopManagedAgentProviders.ts";
import { useAgentEnvWizard } from "./useAgentEnvWizard";
import { AgentEnvSetupTrack } from "./AgentEnvSetupTrack";
import { AgentEnvReportConsent } from "./AgentEnvReportConsent";
import { resolveProviderLabel } from "./agentEnvPanelText";
import {
  resolveAgentEnvPanelProviderSelection,
  type AgentEnvPanelProviderSelection
} from "./agentEnvPanelSelection";

interface AgentEnvPanelProps {
  agentProviderStatusService: IAgentProviderStatusService;
  workspaceId: string;
  workbenchHost?: unknown;
}

export function AgentEnvPanel({
  agentProviderStatusService,
  workspaceId,
  workbenchHost
}: AgentEnvPanelProps): JSX.Element | null {
  const { t } = useTranslation();
  const request = useAgentEnvPanelRequest();
  const snapshot = useSyncExternalStore(
    (listener) => agentProviderStatusService.subscribe(listener),
    () => agentProviderStatusService.getSnapshot()
  );
  const { state: desktopPreferencesState } = useDesktopPreferencesService();
  const visibleProviders = useMemo(
    () =>
      desktopManagedAgentProviders.filter(
        (candidate) =>
          (candidate !== "cursor" ||
            desktopPreferencesState.enableCursorAgent) &&
          (candidate !== "opencode" ||
            desktopPreferencesState.enableOpenCodeAgent)
      ),
    [
      desktopPreferencesState.enableCursorAgent,
      desktopPreferencesState.enableOpenCodeAgent
    ]
  );
  const lastSelectedProviderRef = useRef<WorkspaceAgentProvider | null>(null);
  const [selection, setSelection] = useState<AgentEnvPanelProviderSelection>({
    provider: "codex",
    requestSequence: -1
  });
  const resolvedSelection = useMemo(
    () =>
      resolveAgentEnvPanelProviderSelection({
        current: selection,
        defaultProvider: snapshot.defaultProvider,
        lastSelectedProvider: lastSelectedProviderRef.current,
        requestedProvider: request.provider,
        requestSequence: request.requestSequence,
        visibleProviders
      }),
    [
      request.provider,
      request.requestSequence,
      selection,
      snapshot.defaultProvider,
      visibleProviders
    ]
  );

  useEffect(() => {
    if (!request.open || !resolvedSelection) {
      return;
    }
    lastSelectedProviderRef.current = resolvedSelection.provider;
    if (
      selection.provider !== resolvedSelection.provider ||
      selection.requestSequence !== resolvedSelection.requestSequence
    ) {
      setSelection(resolvedSelection);
    }
  }, [request.open, resolvedSelection, selection]);

  useEffect(() => {
    if (!request.open || visibleProviders.length === 0) {
      return;
    }
    void agentProviderStatusService
      .ensureLoaded({ providers: [...visibleProviders] })
      .catch(() => null);
  }, [agentProviderStatusService, request.open, visibleProviders]);

  const {
    open,
    provider,
    isSupported,
    viewModel,
    reportState,
    copied,
    logExpanded,
    actions
  } = useAgentEnvWizard({
    activeProvider: resolvedSelection?.provider ?? "codex",
    service: agentProviderStatusService,
    workspaceId,
    workbenchHost
  });
  const providerLabel = resolveProviderLabel(provider);
  const statusByProvider = useMemo(
    () => new Map(snapshot.statuses.map((status) => [status.provider, status])),
    [snapshot.statuses]
  );
  const tabs = useMemo(
    () =>
      visibleProviders.map((candidate) => {
        const pendingActionIds = new Set(
          snapshot.pendingActions
            .filter((action) => action.provider === candidate)
            .map((action) => action.actionId)
        );
        const projection = projectAgentEnvProvider({
          isLoading: snapshot.isLoading,
          pendingActionIds,
          provider: candidate,
          status: statusByProvider.get(candidate) ?? null
        });
        const statusLabel = resolveStatusLabel(projection.status, t);
        return {
          value: candidate,
          label: (
            <span className="inline-flex items-center gap-1.5">
              <span>{resolveProviderLabel(candidate)}</span>
              <StatusDot
                ariaLabel={statusLabel}
                pulse={projection.status === "checking"}
                title={statusLabel}
                tone={resolveStatusDotTone(projection.status)}
              />
            </span>
          )
        };
      }),
    [
      snapshot.isLoading,
      snapshot.pendingActions,
      statusByProvider,
      t,
      visibleProviders
    ]
  );

  // Re-detect is disabled while an install runs (busy) or a detect is already in
  // flight (redetecting). Surface WHY via a tooltip — a disabled button with no
  // hint reads as broken.
  const redetectDisabled = viewModel.redetecting || viewModel.busy;
  const redetectDisabledReason = viewModel.busy
    ? t("workspace.agentEnv.redetectDisabledInstalling")
    : viewModel.redetecting
      ? t("workspace.agentEnv.redetectDisabledChecking")
      : null;
  const redetectButton = (
    <Button
      size="dialog"
      type="button"
      disabled={redetectDisabled}
      onClick={actions.redetect}
    >
      <RefreshIcon className="size-4" />
      {t("workspace.agentEnv.actionDetect")}
    </Button>
  );
  const redetectControl = redetectDisabledReason ? (
    <Tooltip>
      {/* A disabled <button> emits no hover events, so the tooltip hangs off a
          <span> wrapper that does. */}
      <TooltipTrigger asChild>
        <span className="inline-flex">{redetectButton}</span>
      </TooltipTrigger>
      <TooltipContent>{redetectDisabledReason}</TooltipContent>
    </Tooltip>
  ) : (
    redetectButton
  );

  // Do NOT early-return null when closed. This <Dialog> is a controlled Radix
  // dialog with disableOutsidePointerEvents; it must observe the open→false
  // transition to restore document.body pointer-events and the scroll lock.
  // Unmounting it while it still believes it is open strands the whole app
  // with `pointer-events: none` — clicks register nowhere and the wizard can
  // never be reopened until reload. Let the `open` prop drive visibility; the
  // DialogContent wrapper unmounts its own subtree after the close animation.
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeAgentEnvPanel();
      }}
    >
      <DialogContent className="flex max-h-[min(640px,calc(100vh-32px))] flex-col gap-0 overflow-hidden bg-[var(--background-fronted)] p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 border-b border-[var(--border-1)] px-5 py-4">
          <DialogTitle>
            {t("workspace.workbenchDesktop.agentProviders.manageTitle")}
          </DialogTitle>
          <DialogDescription>
            {viewModel.ready
              ? t("workspace.agentEnv.configDescription", {
                  provider: providerLabel
                })
              : t("workspace.agentEnv.wizardDescription", {
                  provider: providerLabel
                })}
          </DialogDescription>
        </DialogHeader>

        <UnderlineTabs
          ariaLabel={t(
            "workspace.workbenchDesktop.agentProviders.manageColumnAgent"
          )}
          className="shrink-0 px-5 pt-1"
          tabs={tabs}
          value={provider}
          onValueChange={(nextProvider) => {
            lastSelectedProviderRef.current = nextProvider;
            setSelection({
              provider: nextProvider,
              requestSequence: request.requestSequence
            });
          }}
        />

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!isSupported ? (
            <p className="m-0 text-[13px] text-[var(--text-secondary)]">
              {t("workspace.agentEnv.providerUnsupported")}
            </p>
          ) : (
            <AgentEnvSetupTrack
              viewModel={viewModel}
              providerLabel={providerLabel}
              copied={copied}
              logExpanded={logExpanded}
              actions={actions}
              t={t}
            />
          )}
        </div>

        {reportState === "confirming" ? (
          <AgentEnvReportConsent
            onCancel={actions.dismissReport}
            onAgree={actions.confirmReport}
            t={t}
          />
        ) : null}

        {isSupported ? (
          <DialogFooter className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--border-1)] px-5 py-4">
            {redetectControl}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function resolveStatusLabel(
  status: AgentEnvProviderStatusKind,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  switch (status) {
    case "auth_required":
      return t(
        "workspace.workbenchDesktop.agentProviders.manageStatusAuthRequired"
      );
    case "available":
      return t(
        "workspace.workbenchDesktop.agentProviders.manageStatusAvailable"
      );
    case "checking":
      return t(
        "workspace.workbenchDesktop.agentProviders.manageStatusChecking"
      );
    case "connected":
      return t(
        "workspace.workbenchDesktop.agentProviders.manageStatusConnected"
      );
    case "unsupported":
      return t(
        "workspace.workbenchDesktop.agentProviders.manageStatusUnsupported"
      );
    case "unknown":
      return t("workspace.workbenchDesktop.agentProviders.manageStatusUnknown");
  }
}

function resolveStatusDotTone(
  status: AgentEnvProviderStatusKind
): "amber" | "blue" | "green" | "neutral" {
  switch (status) {
    case "connected":
      return "green";
    case "available":
    case "checking":
      return "blue";
    case "auth_required":
    case "unsupported":
      return "amber";
    case "unknown":
      return "neutral";
  }
}
