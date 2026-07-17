export const CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION = 2 as const;

export type ClaudeSDKSidecarRequestType =
  | "start"
  | "exec"
  | "guide"
  | "cancel"
  | "stop_task"
  | "submit_interactive"
  | "interactive_disposition"
  | "apply_settings"
  | "close";

export type ClaudeSDKSidecarRequest = {
  version: typeof CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION;
  id?: string;
  type: ClaudeSDKSidecarRequestType;
  payload?: Record<string, unknown>;
};

export type ClaudeSDKSidecarEvent = {
  version: typeof CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION;
  id?: string;
  type: string;
  payload?: Record<string, unknown>;
};

export type ClaudeSDKSidecarEventEmitter = (
  event: Omit<ClaudeSDKSidecarEvent, "version">
) => void;

export function parseClaudeSDKSidecarRequest(
  value: unknown
): ClaudeSDKSidecarRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sidecar request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (request.version !== CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION) {
    throw new Error(
      `unsupported sidecar protocol version ${String(request.version ?? "missing")}`
    );
  }
  if (!isRequestType(request.type)) {
    throw new Error(`unsupported request type ${String(request.type ?? "")}`);
  }
  if (
    request.id !== undefined &&
    (typeof request.id !== "string" || request.id.trim() === "")
  ) {
    throw new Error("sidecar request id must be a non-empty string");
  }
  if (
    request.payload !== undefined &&
    (!request.payload ||
      typeof request.payload !== "object" ||
      Array.isArray(request.payload))
  ) {
    throw new Error("sidecar request payload must be an object");
  }
  return request as ClaudeSDKSidecarRequest;
}

export function versionedClaudeSDKSidecarEvent(
  event: Omit<ClaudeSDKSidecarEvent, "version">
): ClaudeSDKSidecarEvent {
  return { version: CLAUDE_SDK_SIDECAR_PROTOCOL_VERSION, ...event };
}

const REQUEST_TYPES = new Set<ClaudeSDKSidecarRequestType>([
  "start",
  "exec",
  "guide",
  "cancel",
  "stop_task",
  "submit_interactive",
  "interactive_disposition",
  "apply_settings",
  "close"
]);

function isRequestType(value: unknown): value is ClaudeSDKSidecarRequestType {
  return (
    typeof value === "string" &&
    REQUEST_TYPES.has(value as ClaudeSDKSidecarRequestType)
  );
}
