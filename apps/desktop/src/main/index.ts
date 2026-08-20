import { app, dialog, shell } from "electron";
import { bootstrapDesktopApp } from "./bootstrap";
import { resolveDesktopDefaultsFromEnv } from "./defaults.ts";
import { showDesktopStartupFailureDialog } from "./desktopStartupFailureDialog.ts";
import {
  ICON_WORKER_ROLE,
  ICON_WORKER_ROLE_ENV,
} from "./host/iconWorker/iconWorkerProtocol.ts";
import { recordStartupFailureEvent } from "./startupFailureAnalytics.ts";
import {
  desktopStartupFailure,
  desktopStartupFailurePrefix,
  isDaemonStartupFailure,
} from "./desktopStartupFailureProtocol.ts";

if (process.env[ICON_WORKER_ROLE_ENV] === ICON_WORKER_ROLE) {
  // Disposable child process that owns crash-prone native icon generation.
  // Bootstrap is never invoked in this role, so privileged-scheme/app-ready
  // setup stays exclusive to the primary process.
  void import("./host/iconWorker/iconWorkerProcess.ts").then(
    ({ runIconWorkerProcess }) => {
      runIconWorkerProcess();
    },
  );
} else {
  void bootstrapDesktopApp().catch(async (error) => {
    const failure = desktopStartupFailure(error);
    process.stderr.write(
      `${desktopStartupFailurePrefix}${JSON.stringify(failure)}\n`,
    );
    await recordStartupFailureEvent({
      error,
      name: "app.startup_failed",
      process: "main",
    }).catch((recordError) => {
      process.stderr.write(
        `[desktop] record startup failure analytics failed: ${recordError instanceof Error ? (recordError.stack ?? recordError.message) : String(recordError)}\n`,
      );
    });
    process.stderr.write(
      `[desktop] bootstrap failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    try {
      await showDesktopStartupFailureDialog({
        failureKind: isDaemonStartupFailure(failure) ? "daemon" : "general",
        locale: app.isReady()
          ? app.getLocale()
          : Intl.DateTimeFormat().resolvedOptions().locale,
        logsDirectory: resolveDesktopDefaultsFromEnv().state.logsDir,
        platform: process.platform,
        openPath: (path) => shell.openPath(path),
        showMessageBox: (options) => dialog.showMessageBox(options),
      });
    } catch (dialogError) {
      process.stderr.write(
        `[desktop] show startup failure dialog failed: ${dialogError instanceof Error ? dialogError.message : String(dialogError)}\n`,
      );
    }
    app.exit(1);
  });
}
