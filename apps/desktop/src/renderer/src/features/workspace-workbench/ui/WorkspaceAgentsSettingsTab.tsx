import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { agentGuiDockIconUrls } from "@tutti-os/agent-gui/dock-icons";
import {
  changeAgentGUIProviderManagerVisibility,
  normalizeAgentGUIProviderRailHiddenTargetIds,
  useAgentGUIProviderRailPreferences
} from "@tutti-os/agent-gui/agent-sidebar-preferences";
import { resolveAgentGUIProviderCatalogIdentity } from "@tutti-os/agent-gui/provider-catalog";
import { useService } from "@tutti-os/infra/di";
import { INotificationService } from "@tutti-os/ui-notifications";
import {
  Button,
  MoreHorizontalIcon,
  StatusDot,
  Switch
} from "@tutti-os/ui-system";
import { useTranslation } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../../workspace-agent/services/agentProviderStatusService.interface.ts";
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
  isWorkspaceAgentGuiPreviewProvider,
  resolveWorkspaceAgentGuiLabel
} from "../services/workspaceAgentProviderCatalog.ts";
import {
  filterVisibleAgentProviders,
  resolveAgentDeepLinkOutcome
} from "./workspaceAgentsSettingsTabModel.ts";

const emptyAgentProviderStatusSnapshot: AgentProviderStatusSnapshot = {
  capturedAt: null,
  defaultProvider: null,
  error: null,
  isLoading: false,
  pendingActions: [],
  statuses: []
};

const managedAgentProviders = [...desktopAgentProviderManageDialogProviders];

function agentTargetId(provider: string): string | null {
  return resolveAgentGUIProviderCatalogIdentity(provider)?.target.id ?? null;
}

/**
 * The "Agents" tab of the agent settings section. Rows are rendered from the
 * authoritative identity catalog + live provider status service (never a copied
 * registry). Sidebar visibility is backed by the shared provider-rail
 * preferences so this tab and the sidebar rail read/write one source.
 */
export function WorkspaceAgentsSettingsTab({
  agentProviderStatusService,
  focusProvider,
  focusRequestID,
  previewEnabled
}: {
  agentProviderStatusService: IAgentProviderStatusService;
  focusProvider: string | null;
  focusRequestID: number;
  previewEnabled: boolean;
}) {
  const { t } = useTranslation();
  const notifications = useService(INotificationService);
  const { preferences, persistPreferences } =
    useAgentGUIProviderRailPreferences();
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedProvider, setHighlightedProvider] = useState<string | null>(
    null
  );
  // Reserved selection for a future per-agent advanced page; not navigated yet.
  const [, setSelectedProvider] = useState<string | null>(null);

  const snapshot = useSyncExternalStore(
    (listener) => agentProviderStatusService.subscribe(listener),
    () => agentProviderStatusService.getSnapshot(),
    () => emptyAgentProviderStatusSnapshot
  );

  useEffect(() => {
    void agentProviderStatusService
      .ensureLoaded({ providers: managedAgentProviders })
      .catch(() => null);
  }, [agentProviderStatusService]);

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
    () => filterVisibleAgentProviders(managedAgentProviders, previewEnabled),
    [previewEnabled]
  );

  const allTargetIds = useMemo(
    () =>
      managedAgentProviders
        .map((provider) => agentTargetId(provider))
        .filter((targetId): targetId is string => targetId !== null),
    []
  );

  const effectiveHiddenTargetIds = useMemo(
    () =>
      normalizeAgentGUIProviderRailHiddenTargetIds(
        allTargetIds,
        preferences.hiddenTargetIds
      ),
    [allTargetIds, preferences.hiddenTargetIds]
  );

  const isShownInSidebar = useCallback(
    (provider: string): boolean => {
      const targetId = agentTargetId(provider);
      return targetId !== null && !effectiveHiddenTargetIds.includes(targetId);
    },
    [effectiveHiddenTargetIds]
  );

  const toggleSidebarVisibility = useCallback(
    (provider: string, visible: boolean) => {
      const targetId = agentTargetId(provider);
      if (!targetId) {
        return;
      }
      persistPreferences(
        changeAgentGUIProviderManagerVisibility({
          currentTargetIds: allTargetIds,
          preferences,
          targetId,
          visible
        })
      );
    },
    [allTargetIds, persistPreferences, preferences]
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
      previewEnabled,
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
      title: t("workspace.settings.agent.agents.previewHiddenHint", {
        agent: resolveWorkspaceAgentGuiLabel(outcome.provider)
      })
    });
    // Intentionally no row focus: the row is hidden until Preview Agents is on.
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
    <div
      className="flex flex-col gap-1"
      data-testid="workspace-settings-agents-list"
    >
      {visibleProviders.map((provider) => {
        const row = rowByProvider.get(provider);
        const status = row?.status ?? "unknown";
        const label = resolveWorkspaceAgentGuiLabel(provider);
        const iconUrl = agentGuiDockIconUrls[provider];
        const shownInSidebar = isShownInSidebar(provider);
        const isPreview = isWorkspaceAgentGuiPreviewProvider(provider);
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
              "flex items-center gap-3 rounded-md px-2 py-2 transition-colors duration-150",
              highlightedProvider === provider
                ? "bg-[var(--transparency-block)]"
                : "bg-transparent"
            )}
            data-agent-provider={provider}
          >
            {iconUrl ? (
              <img
                alt=""
                aria-hidden="true"
                className="size-6 shrink-0 rounded"
                src={iconUrl}
              />
            ) : (
              <span className="size-6 shrink-0 rounded bg-[var(--transparency-block)]" />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <strong className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                  {label}
                </strong>
                {isPreview ? (
                  <span className="rounded-full border border-[var(--border-1)] px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none text-[var(--text-secondary)]">
                    {t("workspace.settings.agent.agents.previewBadge")}
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                <StatusDot size="xs" tone={resolveStatusDotTone(status)} />
                <span className="text-[12px] text-[var(--text-secondary)]">
                  {t(statusLabelKeys[status])}
                </span>
                {status !== "checking" && status !== "unknown" ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="text-[12px] text-[var(--text-tertiary)]"
                    >
                      ·
                    </span>
                    <span className="text-[12px] text-[var(--text-secondary)]">
                      {t(
                        row?.configDetected
                          ? "workspace.workbenchDesktop.agentProviders.manageConfigDetected"
                          : "workspace.workbenchDesktop.agentProviders.manageConfigMissing"
                      )}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <label className="flex shrink-0 items-center gap-2 text-[12px] text-[var(--text-secondary)]">
              <span className="max-[560px]:sr-only">
                {t("workspace.settings.agent.agents.showInSidebar")}
              </span>
              <Switch
                aria-label={t(
                  "workspace.settings.agent.agents.showInSidebarFor",
                  { agent: label }
                )}
                checked={shownInSidebar}
                size="sm"
                onCheckedChange={(next) =>
                  toggleSidebarVisibility(provider, next)
                }
              />
            </label>
            <Button
              aria-label={t("workspace.settings.agent.agents.moreFor", {
                agent: label
              })}
              size="icon-sm"
              title={t("workspace.settings.agent.agents.moreFor", {
                agent: label
              })}
              type="button"
              variant="ghost"
              onClick={() => {
                // Route seam only: reserves the selected agent for a future
                // per-agent advanced settings page. No navigation yet.
                setSelectedProvider(provider);
              }}
            >
              <MoreHorizontalIcon aria-hidden="true" size={16} />
            </Button>
          </div>
        );
      })}
    </div>
  );
}
