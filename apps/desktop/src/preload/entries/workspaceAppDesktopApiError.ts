import type { DesktopApiErrorDetails } from "../../shared/contracts/ipc";

// Guest preload entries must not require Rollup shared chunks. Keep this small
// transport error class inside the workspace-app entry graph instead of
// importing the desktop preload's copy.
export class WorkspaceAppDesktopApiError extends Error {
  readonly code: string;
  readonly reason?: string;
  readonly params?: Record<string, unknown>;
  readonly retryable?: boolean;
  readonly developerMessage?: string;
  readonly correlationId?: string;

  constructor(details: DesktopApiErrorDetails) {
    super(details.message);
    this.name = "DesktopApiError";
    this.code = details.code;
    this.reason = details.reason;
    this.params = details.params;
    this.retryable = details.retryable;
    this.developerMessage = details.developerMessage;
    this.correlationId = details.correlationId;
  }
}
