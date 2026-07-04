import type {
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUsePermissionStatusSource,
  DesktopComputerUseStatusReason
} from "../../shared/contracts/ipc.ts";

export interface CuaDriverPermissionsStatusDetail {
  permissions: DesktopComputerUsePermissionsStatus | null;
  reason?: DesktopComputerUseStatusReason;
  diagnosticMessage?: string;
}

export function parseCuaDriverPermissionsStatus(
  output: string
): DesktopComputerUsePermissionsStatus | null {
  return parseCuaDriverPermissionsStatusDetail(output).permissions;
}

export function parseCuaDriverPermissionsStatusDetail(
  output: string
): CuaDriverPermissionsStatusDetail {
  const trimmed = output.trim();
  if (!trimmed) {
    return { permissions: null, reason: "status-unparseable" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    const startIndex = trimmed.indexOf("{");
    const endIndex = trimmed.lastIndexOf("}");
    if (startIndex < 0 || endIndex <= startIndex) {
      return {
        permissions: null,
        reason: "status-unparseable",
        diagnosticMessage: trimmed
      };
    }
    try {
      payload = JSON.parse(trimmed.slice(startIndex, endIndex + 1));
    } catch {
      return {
        permissions: null,
        reason: "status-unparseable",
        diagnosticMessage: trimmed
      };
    }
  }

  if (!isRecord(payload)) {
    return { permissions: null, reason: "status-unparseable" };
  }

  const unknownReason = parseUnknownStatusReason(payload);
  if (unknownReason) {
    return {
      permissions: null,
      reason: unknownReason.reason,
      diagnosticMessage: unknownReason.diagnosticMessage
    };
  }

  const source: DesktopComputerUsePermissionStatusSource = isRecord(
    payload.source
  )
    ? payload.source.attribution === "driver-daemon"
      ? "driver-daemon"
      : "unknown"
    : "unknown";

  const permissions = {
    accessibility: booleanOrNull(payload.accessibility),
    screenRecording: booleanOrNull(payload.screen_recording),
    screenRecordingCapturable: booleanOrNull(
      payload.screen_recording_capturable
    ),
    source
  };
  if (
    permissions.accessibility === null &&
    permissions.screenRecording === null &&
    permissions.screenRecordingCapturable === null
  ) {
    return {
      permissions: null,
      reason: "status-unparseable",
      diagnosticMessage: stringOrUndefined(payload.reason)
    };
  }
  return { permissions };
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseUnknownStatusReason(payload: Record<string, unknown>): {
  reason: DesktopComputerUseStatusReason;
  diagnosticMessage?: string;
} | null {
  if (payload.status !== "unknown") {
    return null;
  }
  const diagnosticMessage = stringOrUndefined(payload.reason);
  if (
    diagnosticMessage?.includes("no CuaDriver daemon is running") === true ||
    booleanOrNull(payload.daemon_running) === false
  ) {
    return {
      reason: "driver-daemon-not-running",
      diagnosticMessage
    };
  }
  return {
    reason: "status-unparseable",
    diagnosticMessage
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
