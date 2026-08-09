import { NativeEventEmitter } from "react-native";
import type {
  MobileUpdateInstaller,
  MobileUpdateProgress,
  MobileUpdateProgressPhase
} from "../services/mobileUpdateService";
import { mobileSecurity } from "./mobileNative";

export const MOBILE_UPDATE_PROGRESS_EVENT_NAME = "TuttiMobileUpdateProgress";

const progressPhases = new Set<MobileUpdateProgressPhase>([
  "awaiting_install_confirmation",
  "awaiting_install_permission",
  "cancelled",
  "completed",
  "downloading",
  "failed",
  "opening_installer",
  "paused",
  "preparing",
  "queued",
  "verifying"
]);

export function createMobileUpdateInstaller():
  | MobileUpdateInstaller
  | undefined {
  if (!mobileSecurity.installUpdate || !mobileSecurity.cancelUpdate) {
    return undefined;
  }
  const events = new NativeEventEmitter(mobileSecurity);
  return {
    cancel: () => mobileSecurity.cancelUpdate!(),
    install: (apkURL, sha256, sizeBytes, targetVersionCode) =>
      mobileSecurity.installUpdate!(
        apkURL,
        sha256,
        sizeBytes,
        targetVersionCode
      ),
    subscribe(listener) {
      const subscription = events.addListener(
        MOBILE_UPDATE_PROGRESS_EVENT_NAME,
        (value: unknown) => {
          const progress = parseMobileUpdateProgress(value);
          if (progress) listener(progress);
        }
      );
      return () => subscription.remove();
    }
  };
}

export function parseMobileUpdateProgress(
  value: unknown
): MobileUpdateProgress | null {
  if (
    !isRecord(value) ||
    typeof value.phase !== "string" ||
    !progressPhases.has(value.phase as MobileUpdateProgressPhase)
  ) {
    return null;
  }
  if (
    !isNonNegativeSafeInteger(value.downloadedBytes) ||
    typeof value.indeterminate !== "boolean" ||
    (value.totalBytes !== null && !isPositiveSafeInteger(value.totalBytes))
  ) {
    return null;
  }
  const errorCode = value.errorCode ?? null;
  if (errorCode !== null && (typeof errorCode !== "string" || !errorCode)) {
    return null;
  }
  return {
    downloadedBytes: value.downloadedBytes,
    errorCode,
    indeterminate: value.indeterminate,
    phase: value.phase as MobileUpdateProgressPhase,
    totalBytes: value.totalBytes
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}
