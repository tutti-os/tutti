import { useCallback, useEffect, useState } from "react";
import type { DesktopHostWindowApi } from "@preload/types";
import {
  readStandaloneAgentWindowFrame,
  readStandaloneAgentWindowMaximizedState
} from "./standaloneAgentWindowHost.ts";

type StandaloneAgentWindowLayoutApi = Pick<
  DesktopHostWindowApi,
  "onLayout" | "resizeContentWidth"
>;

interface StandaloneAgentWindowResizeTarget {
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

export function subscribeStandaloneAgentWindowLayout(input: {
  commitWindowFrame: () => void;
  hostWindowApi: Pick<StandaloneAgentWindowLayoutApi, "onLayout">;
  resizeTarget: StandaloneAgentWindowResizeTarget;
  setIsWindowMaximized: (maximized: boolean) => void;
}): () => void {
  const disposeHostLayout = input.hostWindowApi.onLayout(({ maximized }) => {
    input.commitWindowFrame();
    input.setIsWindowMaximized(maximized);
  });
  input.resizeTarget.addEventListener("resize", input.commitWindowFrame);
  return () => {
    input.resizeTarget.removeEventListener("resize", input.commitWindowFrame);
    disposeHostLayout();
  };
}

export function useStandaloneAgentWindowLayout(
  hostWindowApi: StandaloneAgentWindowLayoutApi
) {
  const [frame, setFrame] = useState(readStandaloneAgentWindowFrame);
  const [isWindowMaximized, setIsWindowMaximized] = useState(
    readStandaloneAgentWindowMaximizedState
  );
  const commitWindowFrame = useCallback(() => {
    const nextFrame = readStandaloneAgentWindowFrame();
    setFrame((currentFrame) =>
      currentFrame.width === nextFrame.width &&
      currentFrame.height === nextFrame.height
        ? currentFrame
        : nextFrame
    );
  }, []);

  useEffect(
    () =>
      subscribeStandaloneAgentWindowLayout({
        commitWindowFrame,
        hostWindowApi,
        resizeTarget: window,
        setIsWindowMaximized
      }),
    [commitWindowFrame, hostWindowApi]
  );

  const resizeContentWidth = useCallback(
    async (width: number, animate = false) => {
      const result = await hostWindowApi.resizeContentWidth({ animate, width });
      if (!animate) {
        commitWindowFrame();
      }
      return result;
    },
    [commitWindowFrame, hostWindowApi]
  );

  return { frame, isWindowMaximized, resizeContentWidth };
}
