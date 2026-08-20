import type { Connector } from "../../contracts/index.ts";
import type { AuthorizationViewEnvelopeV1 } from "@tutti-os/connector-contracts/authorization/v1";
import type { ConnectorMarketStoreState } from "../connectorMarketService.interface.ts";
import type { ConnectorMarketUiState } from "../ui-state/connectorMarketUiStateService.interface.ts";
import type {
  ConnectorCardView,
  ConnectorCatalogErrorView,
  ConnectorDetailFieldView,
  ConnectorDialogView,
  ConnectorMarketViewState
} from "./connectorMarketViewTypes.ts";

export function buildConnectorMarketView(
  market: ConnectorMarketStoreState,
  uiState: ConnectorMarketUiState
): ConnectorMarketViewState {
  const allConnectors = market.connectorKeys
    .map((key) => market.connectorsByKey[key])
    .filter((connector): connector is Connector => Boolean(connector));
  const query = uiState.query.trim().toLocaleLowerCase();
  const matchesQuery = (connector: Connector) => {
    if (!query) {
      return true;
    }
    return [
      connector.key,
      connector.release.manifest.displayName,
      connector.release.manifest.description ?? ""
    ].some((value) => value.toLocaleLowerCase().includes(query));
  };
  const sections = market.catalogSections.map((section) => ({
    id: section.categoryId,
    ...(section.displayNameZh === undefined
      ? {}
      : { displayNameZh: section.displayNameZh }),
    ...(section.displayNameEn === undefined
      ? {}
      : { displayNameEn: section.displayNameEn }),
    connectorKeys: section.connectorKeys.filter((key) => {
      const connector = market.connectorsByKey[key];
      return connector !== undefined && matchesQuery(connector);
    }),
    error: section.loadState === "error",
    hasMore: section.loadState === "ready" && Boolean(section.nextPageToken),
    itemCount: section.itemCount,
    loading: section.loadState === "loading"
  }));
  const cardsByKey = Object.fromEntries(
    allConnectors.map((connector) => [
      connector.key,
      buildConnectorCardView(
        connector,
        market.operationsByConnectorKey[connector.key]?.stage ?? null,
        market.pendingInstallationsByConnectorKey[connector.key] === true
      )
    ])
  );

  return {
    cardsByKey,
    catalogError: buildCatalogErrorView(market.lastError),
    dialog: buildConnectorDialogView(
      uiState.dialog
        ? market.connectorsByKey[uiState.dialog.connectorKey]
        : undefined,
      uiState.dialog?.kind ?? null,
      uiState.dialog
        ? Boolean(market.authorizingConnectorKeys[uiState.dialog.connectorKey])
        : false,
      uiState.dialog
        ? market.pendingAuthorizationsByConnectorKey[
            uiState.dialog.connectorKey
          ] === true
        : false,
      uiState.dialog
        ? market.pendingInstallationsByConnectorKey[
            uiState.dialog.connectorKey
          ] === true
        : false,
      uiState.dialog
        ? (market.operationsByConnectorKey[uiState.dialog.connectorKey]
            ?.stage ?? null)
        : null,
      uiState.dialog
        ? market.authorizationViewsByConnectorKey[uiState.dialog.connectorKey]
        : undefined
    ),
    refreshing: market.catalogState === "refreshing",
    sections: sections.filter(
      (section) =>
        section.connectorKeys.length > 0 ||
        section.error ||
        section.loading ||
        section.hasMore
    ),
    status:
      market.loadState === "loading" || market.loadState === "idle"
        ? "loading"
        : market.loadState === "error"
          ? "error"
          : sections.every(
                (section) =>
                  section.connectorKeys.length === 0 &&
                  !section.error &&
                  !section.loading
              )
            ? "empty"
            : "ready"
  };
}

function buildCatalogErrorView(
  error: ConnectorMarketStoreState["lastError"]
): ConnectorCatalogErrorView | null {
  if (!error) {
    return null;
  }
  switch (error.code) {
    case "connector_manifest_invalid":
    case "connector_implementation_unsupported":
      return { kind: "invalid_data", retryable: error.retryable };
    case "connector_market_upstream_unavailable":
    case "connector_market_unavailable":
      return { kind: "unavailable", retryable: error.retryable };
    default:
      return { kind: "unknown", retryable: error.retryable };
  }
}

function buildConnectorCardView(
  connector: Connector,
  operationStage: ConnectorCardView["operationStage"],
  pendingInstallation: boolean
): ConnectorCardView {
  const busy = connectorMutationBusy(
    connector,
    operationStage,
    pendingInstallation
  );
  const installed = connectorHasInstalledArtifact(connector);
  const currentReleaseInstalled =
    connectorHasCurrentReleaseInstalled(connector);
  const updating =
    connector.installation.state === "updating" ||
    (installed && !currentReleaseInstalled && pendingInstallation);
  const unavailable = connector.compatibility.state !== "supported";
  const connected = connector.authorization.state === "connected";
  const requiresAuthorization = !["connected", "not_required"].includes(
    connector.authorization.state
  );

  return {
    action: unavailable
      ? "unavailable"
      : busy
        ? "busy"
        : !installed
          ? "install"
          : !currentReleaseInstalled
            ? "update"
            : requiresAuthorization
              ? "authorize"
              : connected
                ? "disconnect"
                : "manage",
    authorizationState: connector.authorization.state,
    compatibilityState: connector.compatibility.state,
    connectorKey: connector.key,
    description: connector.release.manifest.description ?? "",
    displayName: connector.release.manifest.displayName,
    iconUrl: connector.release.manifest.iconUrl,
    implementationTags: implementationTags(connector),
    installationState: connector.installation.state,
    operationStage,
    canUninstall: connectorCanUninstall(connector, busy),
    status: unavailable
      ? "unavailable"
      : busy
        ? updating
          ? "updating"
          : "installing"
        : !installed
          ? "not_installed"
          : !currentReleaseInstalled
            ? "update_available"
            : requiresAuthorization
              ? "authorization_required"
              : "connected"
  };
}

function buildConnectorDialogView(
  connector: Connector | undefined,
  requestKind: NonNullable<ConnectorMarketUiState["dialog"]>["kind"] | null,
  authorizing: boolean,
  pendingAuthorization: boolean,
  pendingInstallation: boolean,
  operationStage: ConnectorCardView["operationStage"],
  authorizationView?: AuthorizationViewEnvelopeV1
): ConnectorDialogView | null {
  if (!connector) {
    return null;
  }
  const base = {
    connectorKey: connector.key,
    description: connector.release.manifest.description ?? "",
    displayName: connector.release.manifest.displayName,
    iconUrl: connector.release.manifest.iconUrl,
    permissions: connector.release.manifest.permissions.map((permission) => ({
      id: permission,
      name: permission
    }))
  };
  const mutationBusy = connectorMutationBusy(
    connector,
    operationStage,
    pendingInstallation
  );
  const canUninstall = connectorCanUninstall(connector, mutationBusy);
  if (requestKind === "uninstall_confirmation") {
    return canUninstall ? { ...base, kind: "uninstall_confirmation" } : null;
  }
  if (connector.compatibility.state !== "supported") {
    return {
      ...base,
      kind: "blocked",
      reason: connector.compatibility.reason ?? connector.compatibility.state
    };
  }
  const installed = connectorHasInstalledArtifact(connector);
  const currentReleaseInstalled =
    connectorHasCurrentReleaseInstalled(connector);
  if (!installed || !currentReleaseInstalled) {
    return {
      ...base,
      installing:
        pendingInstallation ||
        ["installing", "updating"].includes(connector.installation.state),
      kind: "installation",
      updating: installed
    };
  }
  if (!["connected", "not_required"].includes(connector.authorization.state)) {
    return {
      ...base,
      authorizationInteraction:
        connector.release.manifest.authorizationInteraction,
      authorizationKind: connector.release.manifest.authorizationKind,
      authorizationView,
      authorizing,
      brokeredAuthorization:
        connector.release.manifest.authorizationInteractionMode === "managed",
      kind: "authorization",
      pending:
        pendingAuthorization || connector.authorization.state === "pending"
    };
  }
  return {
    ...base,
    canAuthorize: connector.release.manifest.authorizationKind !== "none",
    canUninstall,
    details: buildDetailFields(connector),
    kind: "management"
  };
}

function connectorMutationBusy(
  connector: Connector,
  operationStage: ConnectorCardView["operationStage"],
  pendingInstallation: boolean
): boolean {
  return (
    pendingInstallation ||
    ["installing", "updating", "uninstalling"].includes(
      connector.installation.state
    ) ||
    [
      "accepted",
      "installing",
      "installed",
      "deactivating",
      "disconnecting"
    ].includes(operationStage ?? "")
  );
}

function connectorCanUninstall(
  connector: Connector,
  mutationBusy: boolean
): boolean {
  return (
    Boolean(connector.installation.installedReleaseDigest) && !mutationBusy
  );
}

function connectorHasInstalledArtifact(connector: Connector): boolean {
  if (
    connector.installation.state === "not_installed" ||
    connector.installation.state === "installing"
  ) {
    return false;
  }
  if (
    connector.installation.state === "failed" &&
    [
      "connector_installation_absent",
      "connector_installation_invalid"
    ].includes(connector.installation.failureCode ?? "")
  ) {
    return false;
  }
  if (
    connector.installation.installedReleaseDigest ||
    connector.installation.installedReleaseId ||
    connector.installation.installedVersion
  ) {
    return true;
  }
  return ["installed", "updating", "uninstalling"].includes(
    connector.installation.state
  );
}

function connectorHasCurrentReleaseInstalled(connector: Connector): boolean {
  const installation = connector.installation;
  if (installation.installedReleaseDigest) {
    return (
      installation.installedReleaseDigest === connector.release.releaseDigest
    );
  }
  if (installation.installedReleaseId) {
    return installation.installedReleaseId === connector.release.releaseId;
  }
  if (installation.installedVersion) {
    return installation.installedVersion === connector.release.version;
  }
  return false;
}

function buildDetailFields(connector: Connector): ConnectorDetailFieldView[] {
  const implementation = connector.release.manifest.implementation;
  const runtime = implementation.managedStdio?.runtime;
  return [
    { id: "version", value: connector.release.version },
    { id: "releaseStatus", value: connector.release.status },
    { id: "compatibility", value: connector.compatibility.state },
    { id: "transport", value: implementationTags(connector).join(" + ") },
    { id: "implementation", value: implementation.kind },
    {
      id: "runtime",
      value: runtime
        ? `${runtime.language} · ${runtime.profile} · ${runtime.abi}`
        : "builtin"
    },
    {
      id: "authorization",
      value: connector.release.manifest.authorizationKind
    }
  ];
}

function implementationTags(connector: Connector): string[] {
  const implementation = connector.release.manifest.implementation;
  const tags: string[] = [];
  if (implementation.builtin?.mcp || implementation.managedStdio?.mcp) {
    tags.push("MCP");
  }
  if (implementation.builtin?.cli || implementation.managedStdio?.cli) {
    tags.push("CLI");
  }
  if (implementation.remoteStreamableHttp) {
    tags.push("HTTP");
  }
  return tags;
}
