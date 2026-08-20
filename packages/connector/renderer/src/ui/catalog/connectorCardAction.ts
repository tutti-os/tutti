import type { ConnectorCardView } from "../../application/services/view/connectorMarketViewTypes.ts";

export function connectorCardActionStartsInstallation(
  action: ConnectorCardView["action"]
): boolean {
  return action === "install" || action === "update";
}

export function connectorCardBusyActionLabelKey(
  card: Readonly<
    Pick<
      ConnectorCardView,
      "authorizationState" | "installationState" | "operationStage" | "status"
    >
  >
):
  | "actionDisconnecting"
  | "actionInstalling"
  | "actionUninstalling"
  | "actionUpdating" {
  if (card.status === "updating") {
    return "actionUpdating";
  }
  if (card.installationState === "uninstalling") {
    return "actionUninstalling";
  }
  if (
    card.installationState === "installed" &&
    card.authorizationState === "disconnected" &&
    ["accepted", "deactivating", "disconnecting"].includes(
      card.operationStage ?? ""
    )
  ) {
    return "actionDisconnecting";
  }
  return "actionInstalling";
}
