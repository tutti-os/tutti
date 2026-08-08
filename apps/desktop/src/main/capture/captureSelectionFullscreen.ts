export interface CaptureSelectionFullscreenWindow {
  isFullScreen(): boolean;
  isSimpleFullScreen(): boolean;
  setFullScreen(fullscreen: boolean): void;
  setSimpleFullScreen(fullscreen: boolean): void;
}

export interface CaptureSelectionFullscreenTransitionWindow extends CaptureSelectionFullscreenWindow {
  once(event: "leave-full-screen", listener: () => void): unknown;
  removeListener(event: "leave-full-screen", listener: () => void): unknown;
}

export interface CaptureSelectionFullscreenState {
  fullScreen: boolean;
  simpleFullScreen: boolean;
}

export function resolveCaptureSelectionFullscreenOptions(
  platform: NodeJS.Platform
): { fullscreen: true; simpleFullscreen: boolean } {
  return {
    fullscreen: true,
    simpleFullscreen: platform === "darwin"
  };
}

export function enterCaptureSelectionFullscreen(
  window: CaptureSelectionFullscreenWindow,
  platform: NodeJS.Platform
): CaptureSelectionFullscreenState {
  if (platform === "darwin") {
    window.setSimpleFullScreen(true);
  } else {
    window.setFullScreen(true);
  }

  return {
    fullScreen: window.isFullScreen(),
    simpleFullScreen:
      platform === "darwin" ? window.isSimpleFullScreen() : false
  };
}

export type CaptureSelectionFullscreenExit =
  | "already-exited"
  | "event"
  | "state-after-timeout";

export async function leaveCaptureSelectionFullscreen(
  window: CaptureSelectionFullscreenTransitionWindow,
  platform: NodeJS.Platform,
  timeoutMs = 1_000
): Promise<CaptureSelectionFullscreenExit> {
  const isFullscreen = () =>
    platform === "darwin" ? window.isSimpleFullScreen() : window.isFullScreen();
  if (!isFullscreen()) {
    return "already-exited";
  }

  return new Promise<CaptureSelectionFullscreenExit>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      window.removeListener("leave-full-screen", onLeaveFullScreen);
    };
    const onLeaveFullScreen = () => {
      cleanup();
      resolve("event");
    };

    window.once("leave-full-screen", onLeaveFullScreen);
    timeout = setTimeout(() => {
      cleanup();
      if (isFullscreen()) {
        reject(new Error("Screenshot selector did not leave fullscreen"));
        return;
      }
      resolve("state-after-timeout");
    }, timeoutMs);

    if (platform === "darwin") {
      window.setSimpleFullScreen(false);
    } else {
      window.setFullScreen(false);
    }
  });
}
