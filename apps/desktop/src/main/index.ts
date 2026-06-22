import { app } from "electron";
import { bootstrapDesktopApp } from "./bootstrap";
import {
  ICON_WORKER_ROLE,
  ICON_WORKER_ROLE_ENV
} from "./host/iconWorker/iconWorkerProtocol.ts";
import { recordStartupFailureEvent } from "./startupFailureAnalytics.ts";

if (process.env[ICON_WORKER_ROLE_ENV] === ICON_WORKER_ROLE) {
  // Disposable child process that owns crash-prone native icon generation.
  // Bootstrap is never invoked in this role, so privileged-scheme/app-ready
  // setup stays exclusive to the primary process.
  void import("./host/iconWorker/iconWorkerProcess.ts").then(
    ({ runIconWorkerProcess }) => {
      runIconWorkerProcess();
    }
  );
} else {
  void bootstrapDesktopApp().catch(async (error) => {
    await recordStartupFailureEvent({
      error,
      name: "app.startup_failed",
      process: "main"
    }).catch((recordError) => {
      process.stderr.write(
        `[desktop] record startup failure analytics failed: ${recordError instanceof Error ? (recordError.stack ?? recordError.message) : String(recordError)}\n`
      );
    });
    process.stderr.write(
      `[desktop] bootstrap failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    app.exit(1);
  });
}
