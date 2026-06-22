// Shared protocol between the main process and the isolated icon worker process.
//
// Native icon/thumbnail generation (`app.getFileIcon`, `nativeImage.*`) can hard
// abort the process on malformed inputs (e.g. an `.app` bundle whose `.icns`
// declares a size that mismatches its real image data). Such aborts happen below
// the JS layer, so a `try/catch` cannot contain them. To keep the main process
// alive we run all native icon work in a disposable child process and treat its
// death as "produce a fallback icon" rather than "crash the app".

export const ICON_WORKER_ROLE_ENV = "TUTTI_ROLE";
export const ICON_WORKER_ROLE = "icon-worker";

// Every worker response line is prefixed with this sentinel so the parent can
// ignore unrelated stdout noise emitted by Electron/Chromium.
export const ICON_WORKER_STDOUT_PREFIX = "@@tutti-icon-worker@@ ";

export type IconWorkerMode = "fileIcon" | "imageThumbnail";

export interface IconWorkerRequestMessage {
  id: number;
  mode: IconWorkerMode;
  path: string;
  sizePx: number;
}

export interface IconWorkerResponseMessage {
  id: number;
  pngBase64: string | null;
}
