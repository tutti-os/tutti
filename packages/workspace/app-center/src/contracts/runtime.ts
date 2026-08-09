export const workspaceAppRuntimeStatuses = [
  "idle",
  "installing",
  "preparing",
  "starting",
  "running",
  "installed_pending_restart",
  "failed",
  "stopping",
  "unavailable"
] as const;

export type WorkspaceAppRuntimeStatus =
  (typeof workspaceAppRuntimeStatuses)[number];

export interface WorkspaceAppRuntimeError {
  readonly code?: string;
  readonly failurePhase?: WorkspaceAppFailurePhase;
  readonly message: string;
}

export type WorkspaceAppInstallUserPhase =
  | "downloading"
  | "installing"
  | "starting";

export type WorkspaceAppFailurePhase = WorkspaceAppInstallUserPhase | "runtime";

export interface WorkspaceAppInstallProgress {
  readonly userPhase: WorkspaceAppInstallUserPhase;
  readonly overallPercent: number;
  readonly downloadedBytes?: number | null;
  readonly totalBytes?: number | null;
  readonly indeterminate: boolean;
}

export interface WorkspaceAppRuntimeState {
  readonly runtimeId?: string;
  readonly installationId?: string;
  readonly appId: string;
  readonly status: WorkspaceAppRuntimeStatus;
  readonly launchUrl?: string | null;
  readonly installProgress?: WorkspaceAppInstallProgress | null;
  readonly error?: WorkspaceAppRuntimeError | null;
  readonly startedAt?: string | null;
  readonly updatedAt?: string | null;
}
