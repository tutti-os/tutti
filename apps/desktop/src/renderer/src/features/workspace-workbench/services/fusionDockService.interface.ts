import { createDecorator } from "@tutti-os/infra/di";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { DesktopFusionApi } from "@preload/types";
import type {
  DesktopFusionOpenWindowInput,
  DesktopFusionState,
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowKind
} from "@shared/contracts/fusion.ts";
import type { FusionBackgroundResource } from "./fusionDockResourceModel.ts";

export type FusionDockResourceClient = Pick<
  TuttidClient,
  | "cancelWorkspaceAgentSessionWithResult"
  | "checkWorkspaceTerminalCloseGuard"
  | "listWorkspaceAgentSessions"
  | "listWorkspaceApps"
  | "listWorkspaceTerminals"
  | "listWorkspaces"
  | "stopWorkspaceApp"
  | "terminateWorkspaceTerminal"
>;

export interface PendingFusionTerminalStop {
  readonly details: string | null;
  readonly resource: FusionBackgroundResource;
}

export interface FusionDockReadableStoreState {
  readonly actionError: boolean;
  readonly fusionState: DesktopFusionState;
  readonly pendingTerminalStop: PendingFusionTerminalStop | null;
  readonly refreshing: boolean;
  readonly resources: readonly FusionBackgroundResource[];
  readonly windows: readonly DesktopFusionWindowDescriptor[];
  readonly workspaceNameById: Readonly<Record<string, string>>;
}

export type FusionDockLauncherOpenInput = Omit<
  DesktopFusionOpenWindowInput,
  "forceNew"
>;

export interface IFusionDockService {
  readonly _serviceBrand: undefined;
  readonly store: FusionDockReadableStoreState;

  activateLauncher(input: FusionDockLauncherOpenInput): Promise<void>;
  closeWindow(windowInstanceId: string): Promise<void>;
  confirmPendingTerminalStop(): Promise<void>;
  dismissPendingTerminalStop(): void;
  focusOrReconnectResource(resource: FusionBackgroundResource): Promise<void>;
  focusWindow(windowInstanceId: string): Promise<void>;
  hideDock(): Promise<void>;
  openLauncherInNewWindow(input: FusionDockLauncherOpenInput): Promise<void>;
  openNewWindow(
    kind: DesktopFusionWindowKind,
    workspaceId?: string
  ): Promise<void>;
  openResourceInNewWindow(resource: FusionBackgroundResource): Promise<void>;
  openWindowInNewWindow(window: DesktopFusionWindowDescriptor): Promise<void>;
  stopResource(resource: FusionBackgroundResource): Promise<void>;
}

export interface FusionDockServiceRegistrationInput {
  fusionApi: DesktopFusionApi;
  resourceClient: FusionDockResourceClient;
  workspaceId: string;
}

export const IFusionDockService = createDecorator<IFusionDockService>(
  "fusion-dock-service"
);
