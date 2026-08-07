import { createDecorator } from "@tutti-os/infra/di";

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

export interface ConnectorMarketSectionState extends ConnectorMarketCategory {
  connectorKeys: string[];
  loadState: ConnectorMarketLoadState;
  nextPageToken?: string;
}

export interface ConnectorMarketStoreState {
  loadState: ConnectorMarketLoadState;
  catalogState: ConnectorCatalogState;
  catalogOperation: ConnectorOperation | null;
  catalogSections: ConnectorMarketSectionState[];
  connectorsByKey: Record<string, Connector>;
  connectorKeys: string[];
  pendingInstallationsByConnectorKey: Record<string, true>;
  operationsByConnectorKey: Record<string, ConnectorOperation>;
  authorizingConnectorKeys: Record<string, boolean>;
  lastError: ConnectorMarketErrorShape | null;
  revision: number;
}

export interface ConnectorMarketServiceDependencies {
  backend: ConnectorMarketBackend;
  /** Host-owned admission check for transport requests. */
  canRequest?: () => boolean;
  events?: ConnectorMarketEventSource;
  createRequestId?: () => string;
  openAuthorizationUrl?: (url: string) => Promise<void>;
  reportDiagnostic?: (error: unknown) => void;
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
  install(connectorKey: string): Promise<void>;
  uninstall(connectorKey: string): Promise<void>;
  beginAuthorization(connectorKey: string, secret?: string): Promise<void>;
  disconnectAuthorization(connectorKey: string): Promise<void>;
  /** Releases subscriptions and makes the service terminal. */
  dispose(): void;
}

export const IConnectorMarketService = createDecorator<IConnectorMarketService>(
  "connector-market-service"
);
