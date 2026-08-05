import type { Connector } from "../../contracts/index.ts";
import type { ConnectorMarketStoreState } from "../connectorMarketService.interface.ts";
import type { ConnectorMarketUiState } from "../ui-state/connectorMarketUiStateService.interface.ts";
import type {
  ConnectorCardView,
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
  const installedCount = allConnectors.filter(
    connectorHasInstalledArtifact
  ).length;
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
  const sections =
    uiState.segment === "installed"
      ? [
          {
            id: "installed",
            connectorKeys: allConnectors
              .filter(connectorHasInstalledArtifact)
              .filter(matchesQuery)
              .sort((left, right) =>
                left.release.manifest.displayName.localeCompare(
                  right.release.manifest.displayName
                )
              )
              .map((connector) => connector.key),
            hasMore: false,
            itemCount: installedCount,
            loading: false
          }
        ]
      : market.catalogSections.map((section) => ({
          id: section.categoryId,
          connectorKeys: section.connectorKeys.filter((key) => {
            const connector = market.connectorsByKey[key];
            return (
              connector !== undefined &&
              !connectorHasInstalledArtifact(connector) &&
              matchesQuery(connector)
            );
          }),
          hasMore: Boolean(section.nextPageToken),
          itemCount: section.itemCount,
          loading: section.loadState === "loading"
        }));
  const cardsByKey = Object.fromEntries(
    allConnectors.map((connector) => [
      connector.key,
      buildConnectorCardView(
        connector,
        market.operationsByConnectorKey[connector.key]?.stage ?? null
      )
    ])
  );

  return {
    availableCount: allConnectors.length - installedCount,
    cardsByKey,
    dialog: buildConnectorDialogView(
      uiState.dialog
        ? market.connectorsByKey[uiState.dialog.connectorKey]
        : undefined
    ),
    installedCount,
    lastErrorCode: market.lastError?.code ?? null,
    refreshing: market.catalogState === "refreshing",
    sections: sections.filter(
      (section) =>
        section.connectorKeys.length > 0 || section.loading || section.hasMore
    ),
    status:
      market.loadState === "loading" || market.loadState === "idle"
        ? "loading"
        : market.loadState === "error"
          ? "error"
          : sections.every(
                (section) =>
                  section.connectorKeys.length === 0 && !section.loading
              )
            ? "empty"
            : "ready"
  };
}

function buildConnectorCardView(
  connector: Connector,
  operationStage: ConnectorCardView["operationStage"]
): ConnectorCardView {
  const busy = ["installing", "updating", "uninstalling"].includes(
    connector.installation.state
  );
  const installed = connectorHasInstalledArtifact(connector);
  const unavailable = connector.compatibility.state !== "supported";
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
          : requiresAuthorization
            ? "authorize"
            : "manage",
    authorizationState: connector.authorization.state,
    compatibilityState: connector.compatibility.state,
    connectorKey: connector.key,
    description: connector.release.manifest.description ?? "",
    displayName: connector.release.manifest.displayName,
    implementationTags: implementationTags(connector),
    installationState: connector.installation.state,
    operationStage,
    status: unavailable
      ? "unavailable"
      : busy
        ? "installing"
        : !installed
          ? "not_installed"
          : requiresAuthorization
            ? "authorization_required"
            : "connected"
  };
}

function buildConnectorDialogView(
  connector: Connector | undefined
): ConnectorDialogView | null {
  if (!connector) {
    return null;
  }
  const base = {
    connectorKey: connector.key,
    description: connector.release.manifest.description ?? "",
    displayName: connector.release.manifest.displayName,
    permissions: connector.release.manifest.permissions.map((permission) => ({
      id: permission,
      name: permission
    }))
  };
  if (connector.compatibility.state !== "supported") {
    return {
      ...base,
      kind: "blocked",
      reason: connector.compatibility.reason ?? connector.compatibility.state
    };
  }
  if (!connectorHasInstalledArtifact(connector)) {
    return null;
  }
  if (!["connected", "not_required"].includes(connector.authorization.state)) {
    return {
      ...base,
      kind: "authorization",
      pending: connector.authorization.state === "pending"
    };
  }
  return {
    ...base,
    canAuthorize: connector.release.manifest.authorizationKind !== "none",
    details: buildDetailFields(connector),
    kind: "management",
    workspaceEnabled: connector.workspaceBinding?.enabled ?? true
  };
}

function connectorHasInstalledArtifact(connector: Connector): boolean {
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
