import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import { resolveProviderIconAsset } from "@tutti-os/agent-gui/provider-icons";
import { useService } from "@tutti-os/infra/di";
import { INotificationService } from "@tutti-os/ui-notifications";
import { ArrowRightIcon, Button, StatusDot, Switch } from "@tutti-os/ui-system";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import type { DesktopFeatureFlags } from "@shared/preferences";
import type { AgentExtensionActivationFlag } from "../../../../../shared/featureFlags/catalog.ts";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../../workspace-agent/services/agentProviderStatusService.interface.ts";
import type {
  AgentsSnapshot,
  IAgentsService
} from "../../workspace-agent/services/agentsService.interface.ts";
import {
  desktopAgentProviderManageDialogProviders,
  projectDesktopAgentProviderManageRows,
  type DesktopAgentProviderManageRow
} from "../../workspace-agent/ui/desktopAgentProviderManageDialogModel.ts";
import {
  resolveStatusDotTone,
  statusLabelKeys
} from "../../workspace-agent/ui/DesktopAgentProviderManageDialog.tsx";
import {
  isWorkspaceAgentGuiEarlyAccessProvider,
  resolveWorkspaceAgentGuiLabel
} from "../services/workspaceAgentProviderCatalog.ts";
import {
  filterVisibleAgentProviders,
  resolveAgentDeepLinkOutcome
} from "./workspaceAgentsSettingsTabModel.ts";
import {
  formatAgentProviderUpdateSummary,
  resolveAgentProviderUpdateRowPresentation
} from "./workspaceAgentsSettingsUpdateModel.ts";
import { projectWorkspaceAgentExtensionSettingsRows } from "./workspaceAgentExtensionSettingsModel.ts";

const emptyAgentProviderStatusSnapshot: AgentProviderStatusSnapshot = {
  capturedAt: null,
  defaultProvider: null,
  error: null,
  isLoading: false,
  pendingActions: [],
  statuses: []
};

const emptyAgentsSnapshot: AgentsSnapshot = {
  agents: [],
  agentTargets: [],
  capturedAtUnixMs: null,
  error: null,
  status: "idle"
};

const managedAgentProviders = [...desktopAgentProviderManageDialogProviders];

// Settings > Agents resolves icons with the same priority as AgentGUI's
// composer (resolveComposerProviderTargetIconUrl): the agent target's own
// iconUrl first, then the shared rounded/manage provider icon assets.
// Icons render with a uniform 6px corner radius.
function resolveAgentSettingsIconUrl(
  provider: string,
  agentTarget: { iconUrl?: string | null } | null | undefined
): string | null {
  const identity = resolveAgentGUIProviderCatalogIdentity(provider);
  return (
    agentTarget?.iconUrl?.trim() ||
    resolveProviderIconAsset(identity?.iconKey, "rounded") ||
    resolveProviderIconAsset(identity?.iconKey, "manage")
  );
}

// Shared column template so the header row and every data row line up as one
// grid. Mirrors the DesktopAgentProviderManageDialog table, adapted for the
// narrower Settings panel: Environment collapses into the Agent cell on small
// screens, always keeping the Agent name + enabled toggle usable without
// horizontal scrolling.
const agentsTableColumnsClass = cn(
  "grid gap-3 grid-cols-[minmax(0,1.6fr)_180px_128px]",
  "max-[560px]:grid-cols-[minmax(0,1fr)_128px]"
);

function AgentConnectionStatus({
  className,
  environmentLabel,
  label,
  onOpenEnvironment,
  status
}: {
  className?: string;
  environmentLabel: string;
  label: string;
  onOpenEnvironment?: () => void;
  status: DesktopAgentProviderManageRow["status"];
}) {
  const content = (
    <>
      <StatusDot
        pulse={status === "checking"}
        size="xs"
        tone={resolveStatusDotTone(status)}
      />
      <span className="truncate font-medium">{label}</span>
    </>
  );

  if (!onOpenEnvironment) {
    return (
      <span
        className={cn(
          "min-w-0 items-center gap-1.5 text-[var(--text-primary)]",
          className
        )}
      >
        {content}
      </span>
    );
  }

  return (
    <button
      aria-label={environmentLabel}
      className={cn(
        "min-w-0 items-center gap-1.5 border-0 bg-transparent p-0 text-left text-[var(--text-primary)] outline-none transition-opacity hover:opacity-75 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--border-focus)]",
        className
      )}
      type="button"
      onClick={onOpenEnvironment}
    >
      {content}
      <ArrowRightIcon aria-hidden="true" className="shrink-0" size={13} />
    </button>
  );
}

function agentTargetId(provider: string): string | null {
  return resolveAgentGUIProviderCatalogIdentity(provider)?.target.id ?? null;
}

/**
 * The "Agents" tab of the agent settings section. Rows are rendered from the
 * authoritative identity catalog + live provider status service (never a copied
 * registry). Enabled state comes from daemon-owned Agent Targets, so the same
 * switch controls desktop discovery and CLI launch eligibility.
 */
export function WorkspaceAgentsSettingsTab({
  autoCheckEnabled,
  autoCheckPending,
  agentProviderStatusService,
  agentsService,
  earlyAccessEnabled,
  featureFlags,
  featureFlagsPending,
  focusProvider,
  focusRequestID,
  tuttiAgentSwitchEnabled,
  onAgentEnabledChange,
  onAutoCheckEnabledChange,
  onOpenEnvironment,
  onExtensionEnabledChange
}: {
  autoCheckEnabled: boolean;
  autoCheckPending: boolean;
  agentProviderStatusService: IAgentProviderStatusService;
  agentsService: IAgentsService;
  earlyAccessEnabled: boolean;
  featureFlags: DesktopFeatureFlags;
  featureFlagsPending: boolean;
  focusProvider: string | null;
  focusRequestID: number;
  tuttiAgentSwitchEnabled: boolean;
  onAgentEnabledChange: (
    agentTargetID: string,
    enabled: boolean
  ) => Promise<void>;
  onAutoCheckEnabledChange: (enabled: boolean) => void;
  onOpenEnvironment: (provider: WorkspaceAgentProvider) => void;
  onExtensionEnabledChange: (
    flag: AgentExtensionActivationFlag,
    enabled: boolean
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const notifications = useService(INotificationService);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedProvider, setHighlightedProvider] = useState<string | null>(
    null
  );
  const [pendingAgentTargetIDs, setPendingAgentTargetIDs] = useState<
    ReadonlySet<string>
  >(new Set());

  const snapshot = useSyncExternalStore(
    (listener) => agentProviderStatusService.subscribe(listener),
    () => agentProviderStatusService.getSnapshot(),
    () => emptyAgentProviderStatusSnapshot
  );

  const agentsSnapshot = useSyncExternalStore(
    (listener) => agentsService.subscribe(listener),
    () => agentsService.getSnapshot(),
    () => emptyAgentsSnapshot
  );

  useEffect(() => {
    void agentProviderStatusService
      .ensureLoaded({ providers: managedAgentProviders })
      .catch(() => null);
  }, [agentProviderStatusService]);

  useEffect(() => {
    void agentsService.load().catch(() => null);
  }, [agentsService]);

  useEffect(() => {
    if (!autoCheckEnabled) {
      return;
    }
    void agentProviderStatusService
      .ensureLoaded({
        includeUpdates: true,
        providers: managedAgentProviders
      })
      .catch(() => null);
  }, [agentProviderStatusService, autoCheckEnabled]);

  const checkUpdates = useCallback(async () => {
    try {
      await agentProviderStatusService.checkUpdates(managedAgentProviders);
    } catch (error) {
      notifications.error({
        description:
          error instanceof Error && error.message.trim()
            ? error.message
            : undefined,
        title: t("workspace.settings.agent.agents.checkUpdatesFailed")
      });
    }
  }, [agentProviderStatusService, notifications, t]);

  const rowByProvider = useMemo(() => {
    const rows = projectDesktopAgentProviderManageRows({
      isLoading: snapshot.isLoading,
      pendingActions: snapshot.pendingActions,
      statuses: snapshot.statuses
    });
    return new Map<string, DesktopAgentProviderManageRow>(
      rows.map((row) => [row.provider, row])
    );
  }, [snapshot.isLoading, snapshot.pendingActions, snapshot.statuses]);

  const visibleProviders = useMemo(
    () =>
      filterVisibleAgentProviders(
        managedAgentProviders,
        earlyAccessEnabled,
        tuttiAgentSwitchEnabled
      ),
    [earlyAccessEnabled, tuttiAgentSwitchEnabled]
  );

  const checkingUpdates = agentProviderStatusService.isCheckingUpdates();
  const agentUpdatePending = snapshot.pendingActions.some(
    (action) => action.actionId === "update"
  );

  const agentTargetByID = useMemo(
    () =>
      new Map(
        agentsSnapshot.agentTargets.map((target) => [
          target.agentTargetId,
          target
        ])
      ),
    [agentsSnapshot.agentTargets]
  );

  const extensionRows = useMemo(
    () =>
      projectWorkspaceAgentExtensionSettingsRows({
        agentTargets: agentsSnapshot.agentTargets,
        directoryLoading: agentsSnapshot.status === "loading",
        earlyAccessEnabled,
        featureFlags
      }),
    [
      agentsSnapshot.agentTargets,
      agentsSnapshot.status,
      earlyAccessEnabled,
      featureFlags
    ]
  );

  const toggleAgentEnabled = useCallback(
    async (provider: string, enabled: boolean) => {
      const targetID = agentTargetId(provider);
      if (!targetID || pendingAgentTargetIDs.has(targetID)) {
        return;
      }
      setPendingAgentTargetIDs((current) => new Set(current).add(targetID));
      try {
        await onAgentEnabledChange(targetID, enabled);
      } catch (error) {
        notifications.error({
          description:
            error instanceof Error && error.message.trim()
              ? error.message
              : undefined,
          title: t("workspace.settings.agent.agents.enableChangeFailed", {
            agent: resolveWorkspaceAgentGuiLabel(provider)
          })
        });
      } finally {
        setPendingAgentTargetIDs((current) => {
          const next = new Set(current);
          next.delete(targetID);
          return next;
        });
      }
    },
    [notifications, onAgentEnabledChange, pendingAgentTargetIDs, t]
  );

  const focusRow = useCallback((provider: string) => {
    const element = rowRefs.current.get(provider);
    element?.scrollIntoView({ block: "nearest" });
    setHighlightedProvider(provider);
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedProvider(null);
      highlightTimerRef.current = null;
    }, 2000);
  }, []);

  useEffect(
    () => () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    },
    []
  );

  // Deep-link focus/highlight, driven by a bumped request id so repeat links to
  // the same provider re-trigger. A hidden preview target surfaces a hint.
  useEffect(() => {
    if (focusRequestID === 0) {
      return;
    }
    const outcome = resolveAgentDeepLinkOutcome({
      earlyAccessEnabled,
      provider: focusProvider,
      visibleProviders
    });
    if (!outcome) {
      return;
    }
    if (outcome.kind === "focus") {
      focusRow(outcome.provider);
      return;
    }
    notifications.info({
      title: t("workspace.settings.agent.agents.earlyAccessHiddenHint", {
        agent: resolveWorkspaceAgentGuiLabel(outcome.provider)
      })
    });
    // Intentionally no row focus: the row is hidden until Early Access is on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequestID]);

  if (visibleProviders.length === 0) {
    return (
      <p className="m-0 py-4 text-[13px] text-[var(--text-secondary)]">
        {t("workspace.settings.agent.agents.empty")}
      </p>
    );
  }

  return (
    <div className="pb-[22px]" data-testid="workspace-settings-agents-list">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--transparency-block)] px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Switch
            aria-label={t("workspace.settings.agent.agents.autoCheckUpdates")}
            checked={autoCheckEnabled}
            disabled={autoCheckPending}
            size="sm"
            onCheckedChange={onAutoCheckEnabledChange}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[12px] font-medium text-[var(--text-primary)]">
              {t("workspace.settings.agent.agents.autoCheckUpdates")}
            </span>
            <span className="text-[11px] text-[var(--text-tertiary)]">
              {t("workspace.settings.agent.agents.autoCheckUpdatesHint")}
            </span>
          </span>
        </div>
        <Button
          className="h-7 shrink-0 px-2.5 text-[12px]"
          disabled={checkingUpdates || agentUpdatePending}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            void checkUpdates();
          }}
        >
          {checkingUpdates
            ? t("workspace.settings.agent.agents.checkingUpdates")
            : t("workspace.settings.agent.agents.checkUpdates")}
        </Button>
      </div>
      <div
        className="overflow-hidden rounded-[12px] border border-[var(--line-1)]"
        role="table"
      >
        <div
          className={cn(
            agentsTableColumnsClass,
            "items-center border-b border-[var(--border-1)] px-2 pb-2 text-[12px] font-medium text-[var(--text-tertiary)]"
          )}
          role="row"
        >
          <div role="columnheader">
            {t("workspace.workbenchDesktop.agentProviders.manageColumnAgent")}
          </div>
          <div className="max-[560px]:hidden" role="columnheader">
            {t("workspace.settings.agent.agents.environmentColumn")}
          </div>
          <div className="text-right" role="columnheader">
            {t("workspace.settings.agent.agents.enabledColumn")}
          </div>
        </div>
        <div role="rowgroup">
          {visibleProviders.map((provider) => {
            const row = rowByProvider.get(provider);
            const status = row?.status ?? "unknown";
            const label = resolveWorkspaceAgentGuiLabel(provider);
            const targetID = agentTargetId(provider);
            const agentTarget = targetID ? agentTargetByID.get(targetID) : null;
            const iconUrl = resolveAgentSettingsIconUrl(provider, agentTarget);
            const agentEnabled = agentTarget?.enabled ?? false;
            const agentEnabledPending = targetID
              ? pendingAgentTargetIDs.has(targetID)
              : false;
            const isEarlyAccess =
              isWorkspaceAgentGuiEarlyAccessProvider(provider);
            const environmentLabel = t("workspace.agentEnv.configTitle", {
              provider: label
            });
            const providerStatus = snapshot.statuses.find(
              (item) => item.provider === provider
            );
            const updatePresentation =
              resolveAgentProviderUpdateRowPresentation(providerStatus);
            const updateSummary = formatAgentProviderUpdateSummary({
              checkFailed: updatePresentation.checkFailed,
              currentVersion: updatePresentation.currentVersion,
              latestVersion: updatePresentation.latestVersion,
              t,
              updateAvailable: updatePresentation.updateAvailable
            });
            return (
              <div
                key={provider}
                ref={(element) => {
                  if (element) {
                    rowRefs.current.set(provider, element);
                  } else {
                    rowRefs.current.delete(provider);
                  }
                }}
                className={cn(
                  agentsTableColumnsClass,
                  "items-center border-b border-[var(--border-1)] px-2 py-2.5 text-[13px] transition-colors duration-150 last:border-b-0",
                  highlightedProvider === provider
                    ? "bg-[var(--transparency-block)]"
                    : "bg-transparent"
                )}
                data-agent-provider={provider}
                role="row"
              >
                <div className="flex min-w-0 items-center gap-2.5" role="cell">
                  {iconUrl ? (
                    <img
                      alt=""
                      aria-hidden="true"
                      className="size-7 shrink-0 rounded-[6px]"
                      src={iconUrl}
                    />
                  ) : (
                    <span className="size-7 shrink-0 rounded-[6px] bg-[var(--transparency-block)]" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-semibold text-[var(--text-primary)]">
                        {label}
                      </span>
                      {isEarlyAccess ? (
                        <span className="shrink-0 rounded-full border border-[var(--border-1)] px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-[var(--text-secondary)]">
                          {t(
                            "workspace.settings.agent.agents.earlyAccessBadge"
                          )}
                        </span>
                      ) : null}
                    </span>
                    {updateSummary ? (
                      <span
                        className="truncate text-[11px] text-[var(--text-tertiary)]"
                        data-testid={`workspace-settings-agents-update-summary-${provider}`}
                      >
                        {updateSummary}
                      </span>
                    ) : null}
                    <AgentConnectionStatus
                      className="hidden w-fit text-[11px] text-[var(--text-secondary)] max-[560px]:flex"
                      environmentLabel={environmentLabel}
                      label={t(statusLabelKeys[status])}
                      status={status}
                      onOpenEnvironment={() => onOpenEnvironment(provider)}
                    />
                  </span>
                </div>
                <div
                  className="flex min-w-0 items-center gap-1.5 max-[560px]:hidden"
                  role="cell"
                >
                  <AgentConnectionStatus
                    className="flex"
                    environmentLabel={environmentLabel}
                    label={t(statusLabelKeys[status])}
                    status={status}
                    onOpenEnvironment={() => onOpenEnvironment(provider)}
                  />
                </div>
                <div
                  className="flex items-center justify-end gap-2"
                  role="cell"
                >
                  <span className="text-[11px] text-[var(--text-secondary)]">
                    {agentEnabled
                      ? t("workspace.settings.agent.agents.enabled")
                      : t("workspace.settings.agent.agents.disabled")}
                  </span>
                  <Switch
                    aria-label={t(
                      "workspace.settings.agent.agents.enableAgent",
                      {
                        agent: label
                      }
                    )}
                    checked={agentEnabled}
                    disabled={
                      agentsSnapshot.status === "loading" ||
                      !agentTarget ||
                      agentEnabledPending
                    }
                    size="sm"
                    onCheckedChange={(next) => {
                      void toggleAgentEnabled(provider, next);
                    }}
                  />
                </div>
              </div>
            );
          })}
          {extensionRows.map((row) => {
            const label = t(row.labelKey);
            const environmentLabel = t("workspace.agentEnv.configTitle", {
              provider: label
            });
            const statusLabel = row.enabled
              ? row.status === "unknown"
                ? t("workspace.settings.agent.agents.extensionPreparing")
                : t(statusLabelKeys[row.status])
              : t("workspace.settings.agent.agents.extensionEnableToSetUp");
            return (
              <div
                key={row.key}
                className={cn(
                  agentsTableColumnsClass,
                  "items-center border-b border-[var(--border-1)] px-2 py-2.5 text-[13px] last:border-b-0"
                )}
                data-agent-target={row.agentTargetId}
                role="row"
              >
                <div className="flex min-w-0 items-center gap-2.5" role="cell">
                  {row.iconUrl ? (
                    <img
                      alt=""
                      aria-hidden="true"
                      className="size-7 shrink-0 rounded-[6px]"
                      src={row.iconUrl}
                    />
                  ) : (
                    <span className="size-7 shrink-0 rounded-[6px] bg-[var(--transparency-block)]" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-semibold text-[var(--text-primary)]">
                        {label}
                      </span>
                      <span className="shrink-0 rounded-full border border-[var(--border-1)] px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-[var(--text-secondary)]">
                        {t("workspace.settings.agent.agents.earlyAccessBadge")}
                      </span>
                    </span>
                    <AgentConnectionStatus
                      className="hidden w-fit text-[11px] text-[var(--text-secondary)] max-[560px]:flex"
                      environmentLabel={environmentLabel}
                      label={statusLabel}
                      status={row.status}
                    />
                  </span>
                </div>
                <div
                  className="flex min-w-0 items-center gap-1.5 max-[560px]:hidden"
                  role="cell"
                >
                  <AgentConnectionStatus
                    className="flex"
                    environmentLabel={environmentLabel}
                    label={statusLabel}
                    status={row.status}
                  />
                </div>
                <div
                  className="flex items-center justify-end gap-2"
                  role="cell"
                >
                  <span className="text-[11px] text-[var(--text-secondary)]">
                    {row.enabled
                      ? t("workspace.settings.agent.agents.enabled")
                      : t("workspace.settings.agent.agents.disabled")}
                  </span>
                  <Switch
                    aria-label={t(
                      "workspace.settings.agent.agents.enableAgent",
                      {
                        agent: label
                      }
                    )}
                    checked={row.enabled}
                    disabled={featureFlagsPending}
                    size="sm"
                    onCheckedChange={(enabled) => {
                      void onExtensionEnabledChange(
                        row.activationFlag,
                        enabled
                      );
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
