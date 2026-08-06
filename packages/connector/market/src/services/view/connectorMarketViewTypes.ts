import type {
  ConnectorAuthorizationState,
  ConnectorCompatibilityState,
  ConnectorInstallationState,
  ConnectorOperationStage
} from "../../contracts/index.ts";

export type ConnectorMarketViewStatus = "empty" | "error" | "loading" | "ready";

export interface ConnectorCatalogErrorView {
  kind: "invalid_data" | "unavailable" | "unknown";
  retryable: boolean;
}

export type ConnectorCardAction =
  | "authorize"
  | "busy"
  | "install"
  | "manage"
  | "unavailable";

export interface ConnectorCardView {
  action: ConnectorCardAction;
  authorizationState: ConnectorAuthorizationState;
  compatibilityState: ConnectorCompatibilityState;
  connectorKey: string;
  description: string;
  displayName: string;
  iconUrl: string;
  implementationTags: string[];
  installationState: ConnectorInstallationState;
  operationStage: ConnectorOperationStage | null;
  status:
    | "authorization_required"
    | "connected"
    | "installing"
    | "not_installed"
    | "unavailable";
}

export interface ConnectorSectionView {
  id: string;
  connectorKeys: string[];
  hasMore: boolean;
  itemCount: number;
  loading: boolean;
}

export interface ConnectorPermissionView {
  id: string;
  name: string;
}

export interface ConnectorDetailFieldView {
  id:
    | "authorization"
    | "compatibility"
    | "implementation"
    | "releaseStatus"
    | "runtime"
    | "transport"
    | "version";
  value: string;
}

interface ConnectorDialogBaseView {
  connectorKey: string;
  description: string;
  displayName: string;
  iconUrl: string;
  permissions: ConnectorPermissionView[];
}

export interface ConnectorAuthorizationDialogView extends ConnectorDialogBaseView {
  kind: "authorization";
  pending: boolean;
}

export interface ConnectorInstallationDialogView extends ConnectorDialogBaseView {
  kind: "installation";
}

export interface ConnectorManagementDialogView extends ConnectorDialogBaseView {
  canAuthorize: boolean;
  details: ConnectorDetailFieldView[];
  kind: "management";
}

export interface ConnectorBlockedDialogView extends ConnectorDialogBaseView {
  kind: "blocked";
  reason: string;
}

export type ConnectorDialogView =
  | ConnectorAuthorizationDialogView
  | ConnectorBlockedDialogView
  | ConnectorInstallationDialogView
  | ConnectorManagementDialogView;

export interface ConnectorMarketViewState {
  availableCount: number;
  cardsByKey: Record<string, ConnectorCardView>;
  catalogError: ConnectorCatalogErrorView | null;
  dialog: ConnectorDialogView | null;
  installedCount: number;
  refreshing: boolean;
  sections: ConnectorSectionView[];
  status: ConnectorMarketViewStatus;
}
