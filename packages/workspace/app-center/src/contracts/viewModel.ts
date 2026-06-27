import type { WorkspaceAppRuntimeStatus } from "./runtime.ts";
import type { WorkspaceAppCatalogSourceKind } from "./catalog.ts";
import type { WorkspaceAppInstallProgress } from "./runtime.ts";

export type WorkspaceAppStatusTone =
  | "neutral"
  | "blue"
  | "green"
  | "amber"
  | "red";

export type WorkspaceAppPrimaryAction =
  | "install"
  | "open"
  | "restartAndOpen"
  | "retry"
  | "update"
  | "none";

export type WorkspaceAppFactoryEditAction =
  | "open_session"
  | "prepare_modification";

export interface WorkspaceAppActionContext {
  readonly installationId?: string | null;
  readonly runtimeId?: string | null;
  readonly launchUrl?: string | null;
}

export interface WorkspaceAppAuthorViewModel {
  readonly avatarUrl?: string | null;
  readonly name: string;
  readonly url?: string | null;
}

export interface WorkspaceAppRepositoryViewModel {
  readonly type: "github";
  readonly url: string;
}

export interface WorkspaceAppCardViewModel {
  readonly id: string;
  readonly installationId?: string | null;
  readonly runtimeId?: string | null;
  readonly launchUrl?: string | null;
  readonly name: string;
  readonly createdAtUnixMs: number | null;
  readonly description?: string;
  readonly version?: string;
  readonly availableVersion?: string;
  readonly category?: string | null;
  readonly updateAvailable: boolean;
  readonly icon?: {
    readonly type: "asset";
    readonly src: string;
  };
  readonly tags: readonly string[];
  readonly installed: boolean;
  readonly status: WorkspaceAppRuntimeStatus;
  readonly statusLabelKey: string;
  readonly statusTone: WorkspaceAppStatusTone;
  readonly statusPulse: boolean;
  readonly primaryAction: WorkspaceAppPrimaryAction;
  readonly sourceKind: WorkspaceAppCatalogSourceKind;
  readonly canOpen: boolean;
  readonly canOpenFolder: boolean;
  readonly canOpenPackageFolder: boolean;
  readonly canExport: boolean;
  readonly canDelete: boolean;
  readonly canReloadLocal: boolean;
  readonly canReplaceIcon: boolean;
  readonly canOpenFactorySession: boolean;
  readonly canPublishFactoryUpdate: boolean;
  readonly canUninstall: boolean;
  readonly canRetry: boolean;
  readonly canUpdate: boolean;
  readonly errorMessage?: string;
  readonly installProgress?: WorkspaceAppInstallProgress | null;
  readonly factoryEditAction?: WorkspaceAppFactoryEditAction | null;
  readonly factoryAgentSessionId?: string | null;
  readonly factoryJobId?: string | null;
  readonly factoryProvider?: string | null;
  readonly authors?: readonly WorkspaceAppAuthorViewModel[];
  readonly repository?: WorkspaceAppRepositoryViewModel | null;
}

export interface AppCenterViewModel {
  readonly apps: readonly WorkspaceAppCardViewModel[];
  readonly factoryJobs?: readonly WorkspaceAppFactoryJobViewModel[];
  readonly installedCount: number;
  readonly runningCount: number;
  readonly failedCount: number;
  readonly empty: boolean;
}

export type WorkspaceAppFactoryJobStatus =
  | "canceled"
  | "failed"
  | "generating"
  | "preparing"
  | "published"
  | "queued"
  | "ready"
  | "validating";

export interface WorkspaceAppFactoryJobViewModel {
  readonly id: string;
  readonly agentSessionId?: string | null;
  readonly appId?: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly provider?: string | null;
  readonly status: WorkspaceAppFactoryJobStatus;
  readonly statusLabelKey: string;
  readonly canCancel: boolean;
  readonly canDelete: boolean;
  readonly canFix: boolean;
  readonly canOpenAgentSession: boolean;
  readonly canPublish: boolean;
  readonly canRetryValidation: boolean;
  readonly failureReason?: string | null;
  readonly updatedAtUnixMs: number;
}
