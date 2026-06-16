import type { AppUpdateState } from "./ipc.ts";

export function isSameAppUpdateState(
  left: AppUpdateState,
  right: AppUpdateState
): boolean {
  return (
    left.channel === right.channel &&
    left.checkedAt === right.checkedAt &&
    left.currentVersion === right.currentVersion &&
    left.downloadedBytes === right.downloadedBytes &&
    left.downloadPercent === right.downloadPercent &&
    left.latestVersion === right.latestVersion &&
    left.message === right.message &&
    left.policy === right.policy &&
    left.releaseDate === right.releaseDate &&
    left.releaseName === right.releaseName &&
    left.releaseNotesUrl === right.releaseNotesUrl &&
    left.status === right.status &&
    left.totalBytes === right.totalBytes
  );
}
