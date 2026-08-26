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
      | "authorizationState"
      | "installationState"
      | "mutationPhase"
      | "operationStage"
      | "status"
    >
  >
):
  | "actionWaitingAuthorization"
  | "actionDisconnecting"
  | "actionInstalling"
  | "actionUninstalling"
  | "actionUpdating" {
  switch (card.mutationPhase) {
    case "authorizing":
      return "actionWaitingAuthorization";
    case "disconnecting":
      return "actionDisconnecting";
    case "installing":
      return "actionInstalling";
    case "uninstalling":
      return "actionUninstalling";
    case "updating":
    case "updating_runtime":
      return "actionUpdating";
    case null:
      break;
  }
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
