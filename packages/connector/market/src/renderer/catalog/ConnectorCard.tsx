import { Badge, Button, Card, StatusDot } from "@tutti-os/ui-system/components";
import { useSnapshot } from "valtio";

import type { ConnectorMarketI18nRuntime } from "../../i18n/connectorMarketI18n.ts";
import type { ConnectorCardAction } from "../../services/view/connectorMarketViewTypes.ts";
import { useConnectorMarketServices } from "../ConnectorMarketServicesContext.tsx";
import { ConnectorIcon } from "./ConnectorIcon.tsx";

export function ConnectorCard({ connectorKey }: { connectorKey: string }) {
  const { i18n, market, uiState, view } = useConnectorMarketServices();
  const card = useSnapshot(view.dataStore).cardsByKey[connectorKey];
  if (!card) {
    return null;
  }

  const actionLabel = resolveActionLabel(card.action, i18n.t);
  const status = resolveStatus(card.status, i18n.t);
  const handleAction = () => {
    if (card.action === "install") {
      void market.install(connectorKey).catch(() => undefined);
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
        <ConnectorIcon
          connectorKey={card.connectorKey}
          displayName={card.displayName}
        />
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
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--text-secondary)]">
          <StatusDot
            pulse={card.status === "installing"}
            size="xs"
            tone={status.tone}
          />
          <span className="truncate">
            {card.operationStage
              ? operationStageLabel(card.operationStage, i18n.t)
              : status.label}
          </span>
        </div>
        <Button
          disabled={card.action === "busy"}
          size="sm"
          type="button"
          variant={card.action === "install" ? "outline" : "secondary"}
          onClick={handleAction}
        >
          {actionLabel}
        </Button>
      </div>
    </Card>
  );
}

function resolveActionLabel(
  action: ConnectorCardAction,
  t: ConnectorMarketI18nRuntime["t"]
): string {
  switch (action) {
    case "install":
      return t("actionInstall");
    case "authorize":
      return t("actionAuthorize");
    case "manage":
    case "unavailable":
      return t("actionManage");
    case "busy":
      return t("actionInstalling");
  }
}

function resolveStatus(
  status:
    | "authorization_required"
    | "connected"
    | "installing"
    | "not_installed"
    | "unavailable",
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
    case "unavailable":
      return { label: t("statusUnavailable"), tone: "red" };
    case "not_installed":
      return { label: t("statusNotInstalled"), tone: "neutral" };
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
