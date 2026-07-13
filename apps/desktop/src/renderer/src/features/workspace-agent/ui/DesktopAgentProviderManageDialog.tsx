import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { agentGuiDockIconUrls } from "@tutti-os/agent-gui/dock-icons";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  LoadingIcon,
  StatusDot,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@tutti-os/ui-system";
import type { DesktopI18nKey } from "@shared/i18n";
import { useDesktopPreferencesService } from "@renderer/features/desktop-preferences";
import { useTranslation, type TranslateFn } from "@renderer/i18n";
import { cn } from "@renderer/lib/format";
import { useAccountService } from "../../workspace-workbench/ui/useAccountService.ts";
import type {
  AgentProviderStatusPendingAction,
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../services/agentProviderStatusService.interface";
import {
  desktopAgentProviderManageDialogProviders,
  projectDesktopAgentProviderManageRows,
  type DesktopAgentProviderManageRow,
  type DesktopAgentProviderManageRowAction,
  type DesktopAgentProviderManageRowStatus
} from "./desktopAgentProviderManageDialogModel.ts";
import { isDesktopAgentAccountLoginAction } from "./desktopAgentAccountLoginAction.ts";
import { desktopManagedAgentVisibilityGate } from "../services/internal/desktopManagedAgentProviders.ts";

interface DesktopAgentProviderManageDialogProps {
  agentProviderStatusService: IAgentProviderStatusService;
  focusedProvider: WorkspaceAgentProvider | null;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workbenchHost: unknown;
  workspaceId: string;
}

const emptyAgentProviderStatusSnapshot: AgentProviderStatusSnapshot = {
  capturedAt: null,
  defaultProvider: null,
  error: null,
  isLoading: false,
  pendingActions: [],
  statuses: []
};

const providerLabelKeys = {
  "claude-code":
    "workspace.workbenchDesktop.agentProviders.manageProviderClaudeCode",
  codex: "workspace.workbenchDesktop.agentProviders.manageProviderCodex",
  cursor: "workspace.workbenchDesktop.agentProviders.manageProviderCursor",
  hermes: "workspace.workbenchDesktop.agentProviders.manageProviderHermes",
  nexight: "workspace.workbenchDesktop.agentProviders.manageProviderTutti",
  openclaw: "workspace.workbenchDesktop.agentProviders.manageProviderOpenClaw",
  opencode: "workspace.workbenchDesktop.agentProviders.manageProviderOpenCode",
  "tutti-agent":
    "workspace.workbenchDesktop.agentProviders.manageProviderTuttiAgent"
} as const satisfies Record<WorkspaceAgentProvider, DesktopI18nKey>;

const statusLabelKeys = {
  auth_required:
    "workspace.workbenchDesktop.agentProviders.manageStatusAuthRequired",
  available: "workspace.workbenchDesktop.agentProviders.manageStatusAvailable",
  checking: "workspace.workbenchDesktop.agentProviders.manageStatusChecking",
  connected: "workspace.workbenchDesktop.agentProviders.manageStatusConnected",
  unknown: "workspace.workbenchDesktop.agentProviders.manageStatusUnknown",
  unsupported:
    "workspace.workbenchDesktop.agentProviders.manageStatusUnsupported"
} as const satisfies Record<
  DesktopAgentProviderManageRowStatus,
  DesktopI18nKey
>;

export function DesktopAgentProviderManageDialog({
  agentProviderStatusService,
  focusedProvider,
  onOpenChange,
  open,
  workbenchHost,
  workspaceId
}: DesktopAgentProviderManageDialogProps) {
  const { t } = useTranslation();
  const { service: accountService } = useAccountService();
  const { state: desktopPreferencesState } = useDesktopPreferencesService();
  const hiddenProviders = useMemo<ReadonlySet<WorkspaceAgentProvider>>(
    () =>
      new Set<WorkspaceAgentProvider>(
        desktopAgentProviderManageDialogProviders.filter((provider) => {
          switch (desktopManagedAgentVisibilityGate(provider)) {
            case "cursor_preview":
              return !desktopPreferencesState.enableCursorAgent;
            case "opencode_preview":
              return !desktopPreferencesState.enableOpenCodeAgent;
            default:
              return false;
          }
        })
      ),
    [
      desktopPreferencesState.enableCursorAgent,
      desktopPreferencesState.enableOpenCodeAgent
    ]
  );
  const rowElementsRef = useRef(
    new Map<WorkspaceAgentProvider, HTMLDivElement>()
  );
  const inflightActionKeysRef = useRef(new Set<string>());
  const [localPendingActions, setLocalPendingActions] = useState<
    AgentProviderStatusPendingAction[]
  >([]);
  const snapshot = useSyncExternalStore(
    (listener) => agentProviderStatusService.subscribe(listener),
    () => agentProviderStatusService.getSnapshot(),
    getEmptyAgentProviderStatusSnapshot
  );
  const pendingActions = useMemo(
    () => mergePendingActions(snapshot.pendingActions, localPendingActions),
    [localPendingActions, snapshot.pendingActions]
  );
  const rows = useMemo(
    () =>
      projectDesktopAgentProviderManageRows({
        hiddenProviders,
        isLoading: snapshot.isLoading,
        pendingActions,
        statuses: snapshot.statuses
      }),
    [hiddenProviders, pendingActions, snapshot.isLoading, snapshot.statuses]
  );

  useEffect(() => {
    if (!open) {
      setLocalPendingActions([]);
      return;
    }

    void agentProviderStatusService
      .ensureLoaded({
        providers: [...desktopAgentProviderManageDialogProviders]
      })
      .catch(() => null);
  }, [agentProviderStatusService, open]);

  useEffect(() => {
    if (!open || !focusedProvider) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      rowElementsRef.current
        .get(focusedProvider)
        ?.scrollIntoView({ block: "center" });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusedProvider, open]);

  const setRowElement = useCallback(
    (provider: WorkspaceAgentProvider, element: HTMLDivElement | null) => {
      if (element) {
        rowElementsRef.current.set(provider, element);
        return;
      }
      rowElementsRef.current.delete(provider);
    },
    []
  );

  const runAction = useCallback(
    async (row: DesktopAgentProviderManageRow) => {
      if (row.actionDisabled || !row.primaryActionId) {
        return;
      }

      const actionKey = createPendingActionKey(
        row.provider,
        row.primaryActionId
      );
      if (inflightActionKeysRef.current.has(actionKey)) {
        return;
      }
      inflightActionKeysRef.current.add(actionKey);
      const pendingAction = {
        actionId: row.primaryActionId,
        provider: row.provider
      };
      setLocalPendingActions((current) =>
        current.some(
          (action) =>
            action.actionId === pendingAction.actionId &&
            action.provider === pendingAction.provider
        )
          ? current
          : [...current, pendingAction]
      );

      if (row.primaryActionId === "login") {
        onOpenChange(false);
      }

      try {
        if (
          row.primaryActionId === "login" &&
          isDesktopAgentAccountLoginAction(
            agentProviderStatusService.getStatus(row.provider)
          )
        ) {
          await accountService.startLogin();
        } else {
          await agentProviderStatusService.runAction(
            row.provider,
            row.primaryActionId,
            {
              workbenchHost,
              workspaceId
            }
          );
        }
      } catch {
        // The status service owns user-facing error notifications.
      } finally {
        inflightActionKeysRef.current.delete(actionKey);
        setLocalPendingActions((current) =>
          current.filter(
            (action) =>
              action.actionId !== pendingAction.actionId ||
              action.provider !== pendingAction.provider
          )
        );
      }
    },
    [
      accountService,
      agentProviderStatusService,
      onOpenChange,
      workbenchHost,
      workspaceId
    ]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(720px,calc(100vh-32px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]">
        <DialogHeader className="shrink-0 border-b border-[var(--border-1)] px-5 py-4">
          <DialogTitle>
            {t("workspace.workbenchDesktop.agentProviders.manageTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          <div
            className="min-w-[700px]"
            data-agent-provider-manage-dialog=""
            role="table"
          >
            <div
              className="grid grid-cols-[minmax(240px,1.4fr)_170px_minmax(190px,1fr)_132px] border-b border-[var(--border-1)] px-5 py-3 text-[12px] font-medium text-[var(--text-tertiary)]"
              role="row"
            >
              <div role="columnheader">
                {t(
                  "workspace.workbenchDesktop.agentProviders.manageColumnAgent"
                )}
              </div>
              <div role="columnheader">
                {t(
                  "workspace.workbenchDesktop.agentProviders.manageColumnConnection"
                )}
              </div>
              <div role="columnheader">
                {t(
                  "workspace.workbenchDesktop.agentProviders.manageColumnConfig"
                )}
              </div>
              <div className="sr-only" role="columnheader">
                {t(
                  "workspace.workbenchDesktop.agentProviders.manageColumnAction"
                )}
              </div>
            </div>
            <div role="rowgroup">
              {rows.map((row) => (
                <DesktopAgentProviderManageRowView
                  key={row.provider}
                  focused={row.provider === focusedProvider}
                  row={row}
                  setRowElement={setRowElement}
                  t={t}
                  onAction={runAction}
                />
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DesktopAgentProviderManageRowView({
  focused,
  onAction,
  row,
  setRowElement,
  t
}: {
  focused: boolean;
  onAction: (row: DesktopAgentProviderManageRow) => void;
  row: DesktopAgentProviderManageRow;
  setRowElement: (
    provider: WorkspaceAgentProvider,
    element: HTMLDivElement | null
  ) => void;
  t: TranslateFn;
}) {
  const statusLabel = t(statusLabelKeys[row.status]);

  return (
    <div
      ref={(element) => setRowElement(row.provider, element)}
      className={cn(
        "grid min-h-[92px] grid-cols-[minmax(240px,1.4fr)_170px_minmax(190px,1fr)_132px] items-center border-b border-[var(--border-1)] px-5 py-3 text-[13px] last:border-b-0",
        focused && "bg-[var(--transparency-block)]"
      )}
      data-focused={focused ? "true" : undefined}
      data-provider={row.provider}
      role="row"
    >
      <div className="flex min-w-0 items-center gap-3" role="cell">
        <img
          alt=""
          className="size-10 shrink-0 rounded-[10px]"
          draggable={false}
          src={agentGuiDockIconUrls[row.provider]}
        />
        <span className="truncate text-[14px] font-semibold text-[var(--text-primary)]">
          {t(providerLabelKeys[row.provider])}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2" role="cell">
        <StatusDot
          pulse={row.status === "checking"}
          tone={resolveStatusDotTone(row.status)}
        />
        <span className="truncate font-medium text-[var(--text-primary)]">
          {statusLabel}
        </span>
      </div>
      <div
        className="truncate font-medium text-[var(--text-secondary)]"
        role="cell"
      >
        {row.configDetected
          ? t("workspace.workbenchDesktop.agentProviders.manageConfigDetected")
          : t("workspace.workbenchDesktop.agentProviders.manageConfigMissing")}
      </div>
      <div className="flex justify-end" role="cell">
        <DesktopAgentProviderManageActionButton
          row={row}
          t={t}
          onAction={onAction}
        />
      </div>
    </div>
  );
}

function DesktopAgentProviderManageActionButton({
  onAction,
  row,
  t
}: {
  onAction: (row: DesktopAgentProviderManageRow) => void;
  row: DesktopAgentProviderManageRow;
  t: TranslateFn;
}) {
  const actionLabelKey = resolveActionLabelKey(row);
  if (!actionLabelKey) {
    return <span className="text-[var(--text-tertiary)]">-</span>;
  }

  const disabled = row.actionDisabled;
  const tooltipKey = resolveActionTooltipKey(row);
  const button = (
    <Button
      className="min-w-[104px]"
      disabled={disabled}
      size="dialog"
      type="button"
      onClick={() => {
        void onAction(row);
      }}
    >
      {row.pending ? <LoadingIcon className="size-4 animate-spin" /> : null}
      {t(actionLabelKey)}
    </Button>
  );

  if (!tooltipKey) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent side="left">{t(tooltipKey)}</TooltipContent>
    </Tooltip>
  );
}

function resolveActionLabelKey(
  row: DesktopAgentProviderManageRow
): DesktopI18nKey | null {
  if (row.pending) {
    return row.primaryActionId === "login"
      ? "workspace.workbenchDesktop.agentProviders.manageActionOpeningLogin"
      : "workspace.workbenchDesktop.agentProviders.installing";
  }

  const actionId =
    row.primaryActionId ?? resolveFallbackActionIdForStatus(row.status);
  if (actionId === "install") {
    return "workspace.workbenchDesktop.agentProviders.manageActionConnect";
  }
  if (actionId === "login") {
    return "workspace.workbenchDesktop.agentProviders.manageActionLogin";
  }
  return null;
}

function resolveFallbackActionIdForStatus(
  status: DesktopAgentProviderManageRowStatus
): DesktopAgentProviderManageRowAction | null {
  if (status === "available" || status === "unsupported") {
    return "install";
  }
  if (status === "auth_required") {
    return "login";
  }
  return null;
}

function resolveActionTooltipKey(
  row: DesktopAgentProviderManageRow
): DesktopI18nKey | null {
  if (row.pending || !row.actionDisabled) {
    return null;
  }
  if (row.status === "unsupported") {
    return "workspace.workbenchDesktop.agentProviders.manageUnsupportedTooltip";
  }
  return "workspace.workbenchDesktop.agentProviders.manageActionUnavailableTooltip";
}

function resolveStatusDotTone(
  status: DesktopAgentProviderManageRowStatus
): "amber" | "blue" | "green" | "neutral" {
  switch (status) {
    case "connected":
      return "green";
    case "available":
      return "blue";
    case "auth_required":
    case "unsupported":
      return "amber";
    case "checking":
      return "blue";
    case "unknown":
      return "neutral";
  }
}

function mergePendingActions(
  servicePendingActions: readonly AgentProviderStatusPendingAction[],
  localPendingActions: readonly AgentProviderStatusPendingAction[]
): AgentProviderStatusPendingAction[] {
  const merged = [...servicePendingActions];
  for (const action of localPendingActions) {
    if (
      !merged.some(
        (candidate) =>
          candidate.actionId === action.actionId &&
          candidate.provider === action.provider
      )
    ) {
      merged.push(action);
    }
  }
  return merged;
}

function createPendingActionKey(
  provider: WorkspaceAgentProvider,
  actionId: DesktopAgentProviderManageRowAction
): string {
  return `${provider}:${actionId}`;
}

function getEmptyAgentProviderStatusSnapshot(): AgentProviderStatusSnapshot {
  return emptyAgentProviderStatusSnapshot;
}
