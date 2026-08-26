import { createDecorator } from "@tutti-os/infra/di";
import type { AuthorizationViewEnvelopeV1 } from "@tutti-os/connector-contracts/authorization/v1";

import type {
  Connector,
  ConnectorCatalogState,
  ConnectorMarketCategory,
  ConnectorMarketBackend,
  ConnectorMarketErrorShape,
  ConnectorMarketEventSource,
  ConnectorOperation
} from "../contracts/index.ts";

export type ConnectorMarketLoadState = "idle" | "loading" | "ready" | "error";

export type ConnectorMutationPhase =
  | "authorizing"
  | "disconnecting"
  | "installing"
  | "uninstalling"
  | "updating"
  | "updating_runtime";

export interface ConnectorMarketSectionState extends ConnectorMarketCategory {
  connectorKeys: string[];
  loadState: ConnectorMarketLoadState;
  nextPageToken?: string;
}

export interface ConnectorMarketStoreState {
  loadState: ConnectorMarketLoadState;
  catalogState: ConnectorCatalogState;
  /**
   * Renderer-local: an explicit `refreshCatalog()` command is in flight.
   * Daemon scheduled refresh may set `catalogState` to `refreshing` without
   * this flag; the toolbar must not spin for that background sync.
   */
  pendingExplicitCatalogRefresh: boolean;
  catalogOperation: ConnectorOperation | null;
  catalogSections: ConnectorMarketSectionState[];
  connectorsByKey: Record<string, Connector>;
  connectorKeys: string[];
  pendingInstallationsByConnectorKey: Record<string, true>;
  pendingAuthorizationsByConnectorKey: Record<string, true>;
  mutationPhasesByConnectorKey: Record<string, ConnectorMutationPhase>;
  operationsByConnectorKey: Record<string, ConnectorOperation>;
  pendingUninstallNotificationsByOperationId: Record<
    string,
    {
      connectorKey: string;
      displayName: string;
      operationId: string;
      state: ConnectorOperation["state"];
    }
  >;
  authorizingConnectorKeys: Record<string, boolean>;
  authorizationViewsByConnectorKey: Record<string, AuthorizationViewEnvelopeV1>;
  lastError: ConnectorMarketErrorShape | null;
  revision: number;
  snapshotRevision: number;
  lastEventCursor: number;
}

export interface ConnectorMarketServiceDependencies {
  /** Automatically installs a newly observed release for an installed Connector. */
  autoUpdateInstalledConnectors?: boolean;
  backend: ConnectorMarketBackend;
  /** Host-owned admission check for transport requests. */
  canRequest?: () => boolean;
  /** Host hook invoked by install intent when transport admission is unavailable. */
  requestInstallAdmission?: () => void | Promise<void>;
  events?: ConnectorMarketEventSource;
  createRequestId?: () => string;
  openAuthorizationUrl?: (url: string) => Promise<void>;
  reportDiagnostic?: (error: unknown) => void;
  /** Test/host hook for authorization continuation waits. */
  waitForAuthorizationContinuation?: () => Promise<void>;
  /** Test/host hook for operation polling; the default is abortable setTimeout. */
  waitForOperationPoll?: (
    delayMs: number,
    signal: AbortSignal
  ) => Promise<void>;
}

/**
 * Host-neutral renderer domain service. The host owns transport construction and
 * injects it through `ConnectorMarketServiceDependencies`.
 */
export interface IConnectorMarketService {
  readonly _serviceBrand: undefined;
  readonly dataStore: ConnectorMarketStoreState;

  /** Connects long-lived event sources. Repeated calls are idempotent. */
  start(): void;
  ensureLoaded(): Promise<void>;
  reload(): Promise<void>;
  refreshCatalog(): Promise<void>;
  loadMore(sectionId: string): Promise<void>;
  install(connectorKey: string): Promise<ConnectorInstallOutcome>;
  uninstall(connectorKey: string): Promise<ConnectorOperation>;
  setRuntimeEnabled(connectorKey: string, enabled: boolean): Promise<void>;
  dismissUninstallNotification(operationId: string): void;
  beginAuthorization(connectorKey: string, secret?: string): Promise<void>;
  cancelAuthorization(connectorKey: string): Promise<void>;
  openAuthorizationUrl(url: string): Promise<void>;
  disconnectAuthorization(connectorKey: string): Promise<void>;
  /** Releases subscriptions and makes the service terminal. */
  dispose(): void;
}

export type ConnectorInstallOutcome = "installed" | "not_admitted";

export const IConnectorMarketService = createDecorator<IConnectorMarketService>(
  "connector-market-service"
);
