import type {
  WorkspaceAppInstallProgress,
  WorkspaceAppInstallUserPhase,
  WorkspaceAppRuntimeStatus
} from "../contracts/runtime.ts";

const installUserPhaseOrder: Record<WorkspaceAppInstallUserPhase, number> = {
  downloading: 0,
  installing: 1,
  starting: 2
};

// Default install progress weights from tuttid: 40 + 30 + 20 + 10.
const defaultDownloadCompletePercent = 70;
const defaultInstallingPartialPercent = 79;
const defaultStartingPartialPercent = 96;

export function reconcilePendingInstallProgress(input: {
  readonly incoming: WorkspaceAppInstallProgress | null | undefined;
  readonly previous: WorkspaceAppInstallProgress | null | undefined;
  readonly runtimeStatus: WorkspaceAppRuntimeStatus;
}): WorkspaceAppInstallProgress | null {
  const runtimePhase = runtimeStatusToInstallUserPhase(input.runtimeStatus);
  const progress =
    input.incoming ??
    input.previous ??
    (runtimePhase == null ? null : createProgressForRuntimePhase(runtimePhase));
  if (progress == null) {
    return null;
  }

  if (runtimePhase == null) {
    return clearDownloadBytesUnlessDownloading(progress);
  }

  if (compareInstallUserPhase(progress.userPhase, runtimePhase) >= 0) {
    return clearDownloadBytesUnlessDownloading(progress);
  }

  if (progress.indeterminate) {
    return clearDownloadBytesUnlessDownloading({
      ...progress,
      userPhase: runtimePhase
    });
  }

  return advanceInstallProgressToPhase(progress, runtimePhase);
}

function runtimeStatusToInstallUserPhase(
  runtimeStatus: WorkspaceAppRuntimeStatus
): WorkspaceAppInstallUserPhase | null {
  switch (runtimeStatus) {
    case "preparing":
      return "installing";
    case "starting":
      return "starting";
    default:
      return null;
  }
}

function compareInstallUserPhase(
  left: WorkspaceAppInstallUserPhase,
  right: WorkspaceAppInstallUserPhase
): number {
  return installUserPhaseOrder[left] - installUserPhaseOrder[right];
}

function advanceInstallProgressToPhase(
  progress: WorkspaceAppInstallProgress,
  targetPhase: WorkspaceAppInstallUserPhase
): WorkspaceAppInstallProgress {
  let overallPercent = progress.overallPercent;
  let userPhase = progress.userPhase;

  if (targetPhase === "installing" || targetPhase === "starting") {
    overallPercent = Math.max(overallPercent, defaultDownloadCompletePercent);
    userPhase = "installing";
  }

  if (targetPhase === "starting") {
    overallPercent = Math.max(overallPercent, defaultStartingPartialPercent);
    userPhase = "starting";
  } else if (targetPhase === "installing") {
    overallPercent = Math.max(overallPercent, defaultInstallingPartialPercent);
  }

  return clearDownloadBytesUnlessDownloading({
    ...progress,
    indeterminate: false,
    overallPercent,
    userPhase
  });
}

function createProgressForRuntimePhase(
  userPhase: WorkspaceAppInstallUserPhase
): WorkspaceAppInstallProgress {
  return {
    downloadedBytes: null,
    indeterminate: true,
    overallPercent: 0,
    totalBytes: null,
    userPhase
  };
}

function clearDownloadBytesUnlessDownloading(
  progress: WorkspaceAppInstallProgress
): WorkspaceAppInstallProgress {
  if (progress.userPhase === "downloading") {
    return progress;
  }
  return {
    ...progress,
    downloadedBytes: null,
    totalBytes: null
  };
}
