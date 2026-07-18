import type { BrowserNodeWebviewTag } from "@tutti-os/browser-node/react";

export const browserElementWebviewReadyTimeoutMs = 2_000;

export function isBrowserElementWebviewReady(
  webview: BrowserNodeWebviewTag
): boolean {
  if (!webview.isConnected) return false;
  try {
    const webContentsId = webview.getWebContentsId?.();
    return typeof webContentsId === "number" && Number.isFinite(webContentsId);
  } catch {
    return false;
  }
}

export async function waitForBrowserElementWebviewReady(
  webview: BrowserNodeWebviewTag,
  timeoutMs = browserElementWebviewReadyTimeoutMs
): Promise<boolean> {
  if (isBrowserElementWebviewReady(webview)) return true;
  if (!webview.isConnected) return false;

  return new Promise((resolve) => {
    let settled = false;
    let timeoutSignal: AbortSignal | null = null;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      timeoutSignal?.removeEventListener("abort", handleTimeout);
      webview.removeEventListener("dom-ready", handleDomReady);
      resolve(ready);
    };
    const handleDomReady = (): void => {
      finish(isBrowserElementWebviewReady(webview));
    };
    timeoutSignal = AbortSignal.timeout(timeoutMs);
    const handleTimeout = (): void => finish(false);
    timeoutSignal.addEventListener("abort", handleTimeout, { once: true });
    webview.addEventListener("dom-ready", handleDomReady, { once: true });

    // Covers a dom-ready event emitted between the initial check and listener
    // registration without adding a second BrowserNode lifecycle owner.
    if (isBrowserElementWebviewReady(webview)) finish(true);
  });
}

export async function executeBrowserElementWebviewScript<T>(
  webview: BrowserNodeWebviewTag,
  script: string,
  userGesture = false
): Promise<T> {
  if (!webview.executeJavaScript) {
    throw new Error("Browser webview JavaScript execution is unavailable");
  }
  if (!(await waitForBrowserElementWebviewReady(webview))) {
    throw new Error("Browser webview is not ready");
  }
  return webview.executeJavaScript<T>(script, userGesture);
}

export async function cancelBrowserElementWebviewSelection(
  webview: BrowserNodeWebviewTag | null,
  script: string,
  onError?: (error: unknown) => void
): Promise<void> {
  if (!webview?.executeJavaScript || !webview.isConnected) return;
  try {
    await webview.executeJavaScript(script);
  } catch (error) {
    // Cancellation is best-effort because navigation and unmount detach the
    // guest before React cleanup runs.
    if (onError) {
      onError(error);
    } else {
      console.warn(
        "[agent-gui] browser element selection cleanup failed",
        error
      );
    }
  }
}
