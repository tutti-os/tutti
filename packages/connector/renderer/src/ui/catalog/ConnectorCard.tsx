import {
  Badge,
  Button,
  Card,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
  StatusDot
} from "@tutti-os/ui-system/components";
import { MoreHorizontalIcon, UninstallIcon } from "@tutti-os/ui-system/icons";
import { useState } from "react";
import { useSnapshot } from "valtio";

import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import type { ConnectorCardView } from "../../application/services/view/connectorMarketViewTypes.ts";
import { useConnectorMarketServices } from "../ConnectorMarketServicesContext.tsx";
import {
  connectorCardActionStartsInstallation,
  connectorCardBusyActionLabelKey
} from "./connectorCardAction.ts";
import { ConnectorIcon } from "./ConnectorIcon.tsx";

export function ConnectorCard({ connectorKey }: { connectorKey: string }) {
  const { i18n, market, onError, uiState, view } = useConnectorMarketServices();
  const [disconnecting, setDisconnecting] = useState(false);
  const card = useSnapshot(view.dataStore).cardsByKey[connectorKey];
  if (!card) {
    return null;
  }

  const actionLabel = resolveActionLabel(card, i18n.t);
  const showStatus = card.status !== "not_installed";
  const status = showStatus ? resolveStatus(card.status, i18n.t) : null;
  const handleAction = () => {
    if (card.action === "disconnect") {
      if (disconnecting) {
        return;
      }
      setDisconnecting(true);
      void market
        .disconnectAuthorization(connectorKey)
        .catch(() => onError?.(i18n.t("connectorDisconnectFailed")))
        .finally(() => setDisconnecting(false));
      return;
    }
    if (connectorCardActionStartsInstallation(card.action)) {
      void market.install(connectorKey).catch(() => {
        onError?.(
          i18n.t(
            card.action === "update"
              ? "connectorUpdateFailed"
              : "connectorInstallFailed"
          )
        );
      });
      return;
    }
    if (card.action !== "busy") {
      uiState.openConnector(connectorKey);
    }
  };

  return (
    <Card
      className="min-h-[132px] justify-between gap-3 bg-[var(--background-panel)] p-4 py-4"
      data-testid={`connector-card-${connectorKey}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <ConnectorIcon displayName={card.displayName} iconUrl={card.iconUrl} />
        <div className="min-w-0 flex-1">
          <h4 className="m-0 truncate text-[14px] font-semibold leading-5 text-[var(--text-primary)]">
            {card.displayName}
          </h4>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-[1.45] text-[var(--text-secondary)]">
            {card.description}
          </p>
          {card.implementationTags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {card.implementationTags.map((tag) => (
                <Badge key={tag} size="sm" variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
        {card.canUninstall ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={i18n.t("actionMore")}
                disabled={card.action === "busy"}
                size="icon-xs"
                title={i18n.t("actionMore")}
                type="button"
                variant="ghost"
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-[160px]"
              collisionPadding={12}
              style={{ zIndex: "var(--z-panel-popover)" }}
            >
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => uiState.requestUninstall(connectorKey)}
              >
                <UninstallIcon />
                {i18n.t("actionUninstall")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div
        className={
          showStatus
            ? "flex items-center justify-between gap-3"
            : "flex items-center justify-end gap-3"
        }
      >
        {status ? (
          <div className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            <StatusDot
              pulse={["installing", "updating"].includes(card.status)}
              size="xs"
              tone={status.tone}
            />
            <span className="truncate">
              {card.operationStage && card.operationStage !== "completed"
                ? operationStageLabel(card.operationStage, i18n.t)
                : status.label}
            </span>
          </div>
        ) : null}
        <Button
          disabled={card.action === "busy" || disconnecting}
          size="sm"
          type="button"
          variant={
            card.action === "disconnect"
              ? "destructive-secondary"
              : card.action === "install" || card.action === "update"
                ? "outline"
                : "secondary"
          }
          onClick={handleAction}
        >
          {card.action === "busy" || disconnecting ? (
            <Spinner size={14} />
          ) : null}
          {disconnecting ? i18n.t("actionDisconnecting") : actionLabel}
        </Button>
      </div>
    </Card>
  );
}

function resolveActionLabel(
  card: Readonly<
    Pick<
      ConnectorCardView,
      | "action"
      | "authorizationState"
      | "installationState"
      | "operationStage"
      | "status"
    >
  >,
  t: ConnectorMarketI18nRuntime["t"]
): string {
  switch (card.action) {
    case "install":
      return t("actionInstall");
    case "update":
      return t("actionUpdate");
    case "authorize":
      return t("actionAuthorize");
    case "disconnect":
      return t("actionDisconnect");
    case "manage":
    case "unavailable":
      return t("actionManage");
    case "busy":
      return t(connectorCardBusyActionLabelKey(card));
  }
}

function resolveStatus(
  status:
    | "authorization_required"
    | "connected"
    | "installing"
    | "not_installed"
    | "unavailable"
    | "updating"
    | "update_available",
  t: ConnectorMarketI18nRuntime["t"]
): {
  label: string;
  tone: "amber" | "blue" | "green" | "neutral" | "red";
} {
  switch (status) {
    case "connected":
      return { label: t("connectedStatus"), tone: "green" };
    case "authorization_required":
      return { label: t("statusAuthorizationRequired"), tone: "amber" };
    case "installing":
      return { label: t("actionInstalling"), tone: "blue" };
    case "updating":
      return { label: t("actionUpdating"), tone: "blue" };
    case "unavailable":
      return { label: t("statusUnavailable"), tone: "red" };
    case "not_installed":
      return { label: t("statusNotInstalled"), tone: "neutral" };
    case "update_available":
      return { label: t("statusUpdateAvailable"), tone: "blue" };
  }
}

function operationStageLabel(
  stage: string,
  t: ConnectorMarketI18nRuntime["t"]
): string {
  const keys = {
    accepted: "operationAccepted",
    activating: "operationActivating",
    authorizing: "operationAuthorizing",
    completed: "operationCompleted",
    deactivating: "operationDeactivating",
    disconnecting: "operationDisconnecting",
    downloading: "operationDownloading",
    failed: "operationFailed",
    prepared: "operationPrepared",
    refreshing: "operationRefreshing"
  } as const;
  return t(keys[stage as keyof typeof keys] ?? "operationAccepted");
}
