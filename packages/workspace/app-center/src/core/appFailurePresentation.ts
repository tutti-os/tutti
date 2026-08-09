import type { WorkspaceAppFailurePhase } from "../contracts/runtime.ts";

export type WorkspaceAppFailureMessageKey =
  | "messages.appInstallFailed"
  | "messages.appRuntimeFailed"
  | "messages.appStartFailed"
  | "messages.appUnknownFailure";

export function resolveWorkspaceAppFailureMessageKey(
  failurePhase: WorkspaceAppFailurePhase | null | undefined
): WorkspaceAppFailureMessageKey {
  switch (failurePhase) {
    case "downloading":
    case "installing":
      return "messages.appInstallFailed";
    case "starting":
      return "messages.appStartFailed";
    case "runtime":
      return "messages.appRuntimeFailed";
    default:
      return "messages.appUnknownFailure";
  }
}
