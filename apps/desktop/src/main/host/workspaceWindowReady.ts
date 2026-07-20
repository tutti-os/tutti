type WorkspaceWindowReadyListener = (...args: unknown[]) => void;

export interface WorkspaceWindowReadyTarget {
  close(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  maximize(): void;
  once(event: string, listener: WorkspaceWindowReadyListener): unknown;
  removeListener(
    event: string,
    listener: WorkspaceWindowReadyListener
  ): unknown;
  show(): void;
  webContents: {
    isDestroyed(): boolean;
    once(event: string, listener: WorkspaceWindowReadyListener): unknown;
    removeListener(
      event: string,
      listener: WorkspaceWindowReadyListener
    ): unknown;
  };
}

export interface AwaitWorkspaceWindowReadyOptions {
  maximizeOnShow?: boolean;
  showOnReady?: boolean;
}

export async function awaitWorkspaceWindowReady(
  window: WorkspaceWindowReadyTarget,
  startLoading: () => void,
  options: AwaitWorkspaceWindowReadyOptions = {}
): Promise<void> {
  if (window.isDestroyed()) {
    return;
  }

  if (window.isVisible()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const webContents = window.webContents;

    const cleanup = () => {
      window.removeListener("ready-to-show", handleReadyToShow);
      window.removeListener("closed", handleClosed);
      webContents.removeListener("did-finish-load", handleDidFinishLoad);
      webContents.removeListener("did-fail-load", handleFailLoad);
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const handleReadyToShow = () => {
      settle(() => {
        if (!window.isDestroyed() && options.showOnReady !== false) {
          if (options.maximizeOnShow !== false) {
            window.maximize();
          }
          window.show();
        }
        resolve();
      });
    };

    const handleDidFinishLoad = () => {
      settle(() => {
        if (!window.isDestroyed() && options.showOnReady !== false) {
          if (options.maximizeOnShow !== false) {
            window.maximize();
          }
          window.show();
        }
        resolve();
      });
    };

    const handleClosed = () => {
      settle(() => {
        reject(new Error("Replacement window closed before it was ready."));
      });
    };

    const handleFailLoad: WorkspaceWindowReadyListener = (...args) => {
      const [, errorCodeArg, errorDescriptionArg] = args;
      const errorCode =
        typeof errorCodeArg === "number" ? errorCodeArg : Number.NaN;
      const errorDescription =
        typeof errorDescriptionArg === "string"
          ? errorDescriptionArg
          : "Unknown load failure";
      settle(() => {
        if (!window.isDestroyed()) {
          window.close();
        }
        reject(
          new Error(
            `Replacement window failed to load (${errorCode}): ${errorDescription}`
          )
        );
      });
    };

    window.once("ready-to-show", handleReadyToShow);
    window.once("closed", handleClosed);
    webContents.once("did-finish-load", handleDidFinishLoad);
    webContents.once("did-fail-load", handleFailLoad);
    startLoading();
  });
}
