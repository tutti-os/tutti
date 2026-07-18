import type {
  RuntimeProtocolErrorCode,
  WorkspaceProtocolErrorCode
} from "@tutti-os/client-tuttid-ts";
import { getTuttidProtocolErrorCode } from "@tutti-os/client-tuttid-ts";
import { DESKTOP_AGENT_PROMPT_FILE_TOO_LARGE_ERROR_CODE } from "../agentPromptAssets.ts";

export const desktopErrorCodes = {
  agentPromptFileTooLarge: DESKTOP_AGENT_PROMPT_FILE_TOO_LARGE_ERROR_CODE,
  daemonUnavailable: "daemon_unavailable",
  electronDebugRequired: "electron_debug_required",
  loggerFallback: "logger_file_unavailable",
  managedProcessExited: "managed_process_exited",
  managedProcessStderr: "managed_process_stderr",
  nodeRuntimeBroken: "node_runtime_broken",
  projectDirectoryAlreadyExists: "project_directory_already_exists",
  projectDirectoryPermissionDenied: "project_directory_permission_denied",
  projectDocumentsUnavailable: "project_documents_unavailable",
  projectNameInvalid: "project_name_invalid",
  previewFileTooLarge: "preview_file_too_large",
  transportConnectFailed: "transport_connect_failed",
  transportRequestFailed: "transport_request_failed",
  transportTimeout: "transport_timeout"
} as const;

type DesktopLocalErrorCode =
  (typeof desktopErrorCodes)[keyof typeof desktopErrorCodes];
export type DesktopErrorCode =
  | DesktopLocalErrorCode
  | RuntimeProtocolErrorCode
  | WorkspaceProtocolErrorCode;

export function classifyDesktopErrorCode(error: unknown): DesktopErrorCode {
  const protocolCode = getTuttidProtocolErrorCode(error);
  if (protocolCode) {
    return protocolCode as
      | RuntimeProtocolErrorCode
      | WorkspaceProtocolErrorCode;
  }

  const message = formatErrorMessage(error).toLowerCase();
  const code =
    error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? "") : "";

  if (
    code &&
    (Object.values(desktopErrorCodes) as readonly string[]).includes(code)
  ) {
    return code as DesktopLocalErrorCode;
  }

  if (code === "ENOENT" || message.includes("not available yet")) {
    return desktopErrorCodes.daemonUnavailable;
  }

  if (code === "ETIMEDOUT" || message.includes("timed out")) {
    return desktopErrorCodes.transportTimeout;
  }

  if (isNodeRuntimeLinkerFailure(message)) {
    return desktopErrorCodes.nodeRuntimeBroken;
  }

  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    message.includes("refused")
  ) {
    return desktopErrorCodes.transportConnectFailed;
  }

  return desktopErrorCodes.transportRequestFailed;
}

function isNodeRuntimeLinkerFailure(message: string): boolean {
  return (
    message.includes("dyld[") &&
    message.includes("library not loaded") &&
    (message.includes("/bin/node") ||
      message.includes("/node\n") ||
      message.includes("/node\r\n") ||
      message.includes("referenced from:") ||
      message.includes("npm"))
  );
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
