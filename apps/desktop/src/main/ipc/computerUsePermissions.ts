import type {
  DesktopComputerUsePermissionsStatus,
  DesktopComputerUsePermissionStatusSource,
  DesktopComputerUseStatusReason
} from "../../shared/contracts/ipc.ts";

export interface CuaDriverDoctorStatus {
  ok: boolean;
  // The native Win32 fallback remains usable even when the optional UI
  // Automation probe is unhealthy. Keep this internal distinction so the
  // desktop does not send a usable Windows installation to Settings.
  degraded?: boolean;
  diagnosticMessage?: string;
}

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

/**
 * Parse the platform-neutral `cua-driver doctor --json` result.
 *
 * Doctor output has a stable top-level `ok` field in released drivers, but we
 * also accept probe-only output so a newer driver can add a wrapper without
 * making the desktop report a false negative.
 */
export function parseCuaDriverDoctorStatus(
  output: string
): CuaDriverDoctorStatus | null {
  const payload = parseJsonObject(output);
  if (!payload) {
    return {
      ok: false,
      diagnosticMessage: output.trim() || "cua-driver doctor returned no output"
    };
  }

  if (typeof payload.ok === "boolean") {
    const diagnosticMessage =
      stringOrUndefined(payload.message) ?? stringOrUndefined(payload.reason);
    return {
      ok: payload.ok,
      ...(diagnosticMessage ? { diagnosticMessage } : {}),
      ...(isCuaDriverDegradedDiagnostic(diagnosticMessage)
        ? { degraded: true }
        : {})
    };
  }

  const probes = Array.isArray(payload.probes) ? payload.probes : [];
  if (probes.length === 0) {
    return {
      ok: false,
      diagnosticMessage: "cua-driver doctor output did not include probes"
    };
  }

  let failed = false;
  const diagnostics: string[] = [];
  for (const probe of probes) {
    if (!isRecord(probe)) {
      failed = true;
      continue;
    }
    const status = String(probe.status ?? "").toLowerCase();
    if (["ok", "pass", "passed", "healthy", "ready"].includes(status)) {
      continue;
    }
    failed = true;
    const label = stringOrUndefined(probe.label);
    const message =
      stringOrUndefined(probe.message) ?? stringOrUndefined(probe.detail);
    if (label || message) {
      diagnostics.push([label, message].filter(Boolean).join(": "));
    }
  }
  const diagnosticMessage =
    diagnostics.length > 0 ? diagnostics.join("; ") : undefined;
  return {
    ok: !failed,
    ...(diagnosticMessage ? { diagnosticMessage } : {}),
    ...(isCuaDriverDegradedDiagnostic(diagnosticMessage)
      ? { degraded: true }
      : {})
  };
}

function isCuaDriverDegradedDiagnostic(message: string | undefined): boolean {
  return (
    message
      ?.toLowerCase()
      .includes("falling back to win32-only window tools") === true
  );
}

function parseJsonObject(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    const startIndex = trimmed.indexOf("{");
    const endIndex = trimmed.lastIndexOf("}");
    if (startIndex < 0 || endIndex <= startIndex) {
      return null;
    }
    try {
      value = JSON.parse(trimmed.slice(startIndex, endIndex + 1));
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
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
