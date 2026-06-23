import { createRequire } from "node:module";
import type { WorkspaceLaunch } from "./host/workspaceLaunch";
import type { DesktopLogger } from "./logging";
import type { TuttidManager } from "./daemon/tuttidManager";
import type { AppUpdateService } from "./update/appUpdateService";

const require = createRequire(import.meta.url);

interface DesktopElectronApp {
  on(event: string, listener: (...args: never[]) => void): void;
  quit(): void;
}

interface DesktopElectronBrowserWindow {
  getAllWindows(): Array<{ destroy(): void }>;
}

interface DesktopElectronModule {
  app: DesktopElectronApp;
  BrowserWindow: DesktopElectronBrowserWindow;
}

export interface DesktopAppLifecycleDependencies {
  disposables?: readonly DesktopAppLifecycleDisposable[];
  logger: DesktopLogger;
  tuttid: TuttidManager;
  updateService: AppUpdateService;
  workspaceLaunch: WorkspaceLaunch;
}

export interface DesktopAppLifecycleDisposable {
  dispose(): void;
}

export interface DesktopAppLifecycleHandlers {
  activate(this: void): void;
  beforeQuit(this: void, event: { preventDefault(): void }): void;
  willQuit(this: void): void;
  windowAllClosed(this: void): void;
}

export interface DesktopAppLifecycleRuntime {
  destroyAllWindows(): void;
  getWindowCount(): number;
  quit(): void;
  requestWorkspaceWindowsClose(): Promise<"approved" | "blocked">;
}

export function registerDesktopAppLifecycle(
  deps: DesktopAppLifecycleDependencies
): void {
  const electron = loadDesktopElectronModule();
  const { app } = electron;
  const handlers = createDesktopAppLifecycleHandlers(
    deps,
    createElectronDesktopAppLifecycleRuntime(electron)
  );
  app.on("activate", handlers.activate);
  app.on("window-all-closed", handlers.windowAllClosed);
  app.on("before-quit", handlers.beforeQuit);
  app.on("will-quit", handlers.willQuit);
}

export function createDesktopAppLifecycleHandlers(
  deps: DesktopAppLifecycleDependencies,
  runtime: DesktopAppLifecycleRuntime = createElectronDesktopAppLifecycleRuntime()
): DesktopAppLifecycleHandlers {
  let isStoppingDaemon = false;

  return {
    activate() {
      if (runtime.getWindowCount() === 0) {
        void deps.workspaceLaunch.openStartupWindow();
      }
    },

    beforeQuit(event) {
      if (isStoppingDaemon) {
        return;
      }

      isStoppingDaemon = true;
      event.preventDefault();
      deps.logger.info("desktop app before quit");
      void (async () => {
        try {
          const outcome = await runtime.requestWorkspaceWindowsClose();
          if (outcome === "blocked") {
            isStoppingDaemon = false;
            return;
          }
        } catch (error: unknown) {
          deps.logger.error("failed to close workspace windows during quit", {
            error: error instanceof Error ? error.message : String(error)
          });
          isStoppingDaemon = false;
          return;
        }

        try {
          await deps.tuttid.stop();
        } catch (error: unknown) {
          deps.logger.error("failed to stop managed tuttid during quit", {
            error: error instanceof Error ? error.message : String(error)
          });
        }

        runtime.destroyAllWindows();
        runtime.quit();
      })();
    },

    willQuit() {
      for (const disposable of deps.disposables ?? []) {
        disposable.dispose();
      }
      deps.updateService.dispose();
      void deps.logger.close();
    },

    windowAllClosed() {
      deps.logger.info("all desktop windows closed");
      if (process.platform !== "darwin") {
        runtime.quit();
      }
    }
  };
}

function createElectronDesktopAppLifecycleRuntime(
  electron = loadDesktopElectronModule()
): DesktopAppLifecycleRuntime {
  const { app, BrowserWindow } = electron;
  return {
    destroyAllWindows: () => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.destroy();
      }
    },
    getWindowCount: () => BrowserWindow.getAllWindows().length,
    quit: () => app.quit(),
    requestWorkspaceWindowsClose: async () => {
      const { requestWorkspaceWindowsClose } =
        await import("./windows/workspaceWindow.ts");
      return requestWorkspaceWindowsClose({ reason: "quit" });
    }
  };
}

function loadDesktopElectronModule(): DesktopElectronModule {
  return require("electron") as DesktopElectronModule;
}
