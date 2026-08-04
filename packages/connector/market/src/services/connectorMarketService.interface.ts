import { createDecorator } from "@tutti-os/infra/di";

import type {
  Connector,
  ConnectorCatalogState,
  ConnectorMarketBackend,
  ConnectorMarketErrorShape,
  ConnectorMarketEventSource,
  ConnectorOperation
} from "../contracts/index.ts";

export type ConnectorMarketLoadState = "idle" | "loading" | "ready" | "error";

export interface ConnectorMarketStoreState {
  loadState: ConnectorMarketLoadState;
  catalogState: ConnectorCatalogState;
  catalogOperation: ConnectorOperation | null;
  connectorsByKey: Record<string, Connector>;
  connectorKeys: string[];
  operationsByConnectorKey: Record<string, ConnectorOperation>;
  lastError: ConnectorMarketErrorShape | null;
  revision: number;
  workspaceId?: string;
}

export interface ConnectorMarketServiceDependencies {
  backend: ConnectorMarketBackend;
  events?: ConnectorMarketEventSource;
  workspaceId?: string;
  createRequestId?: () => string;
  openAuthorizationUrl?: (url: string) => Promise<void>;
  reportDiagnostic?: (error: unknown) => void;
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
  install(connectorKey: string): Promise<void>;
  uninstall(connectorKey: string): Promise<void>;
  beginAuthorization(connectorKey: string): Promise<void>;
  disconnectAuthorization(connectorKey: string): Promise<void>;
  setWorkspaceEnabled(connectorKey: string, enabled: boolean): Promise<void>;
  setWorkspace(workspaceId?: string): Promise<void>;

  /** Releases subscriptions and makes the service terminal. */
  dispose(): void;
}

export const IConnectorMarketService = createDecorator<IConnectorMarketService>(
  "connector-market-service"
);
