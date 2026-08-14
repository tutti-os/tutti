import {
  classifyDesktopErrorCode,
  desktopErrorCodes,
  formatErrorMessage,
} from "../shared/errors/desktopErrors.ts";

export const desktopStartupFailurePrefix = "[tutti-desktop-startup-failed] ";

export interface DesktopStartupFailure {
  cause?: {
    code: string;
    message: string;
  };
  code: string;
  message: string;
}

export function desktopStartupFailure(error: unknown): DesktopStartupFailure {
  const cause = structuredCause(error instanceof Error ? error.cause : null);
  return {
    ...(cause ? { cause } : {}),
    code: classifyDesktopErrorCode(error),
    message: formatErrorMessage(error),
  };
}

export function isDaemonStartupFailure(
  failure: DesktopStartupFailure,
): boolean {
  return (
    failure.code === desktopErrorCodes.daemonUnavailable ||
    failure.code === desktopErrorCodes.managedProcessError ||
    failure.code === desktopErrorCodes.managedProcessExited ||
    failure.cause?.code === desktopErrorCodes.managedProcessStderr
  );
}

function structuredCause(
  value: unknown,
): { code: string; message: string } | null {
  const cause = value as { code?: unknown; message?: unknown };
  if (
    !cause ||
    typeof cause !== "object" ||
    typeof cause.code !== "string" ||
    !cause.code.trim() ||
    typeof cause.message !== "string" ||
    !cause.message.trim()
  ) {
    return null;
  }
  return {
    code: cause.code.trim(),
    message: cause.message.trim(),
  };
}
