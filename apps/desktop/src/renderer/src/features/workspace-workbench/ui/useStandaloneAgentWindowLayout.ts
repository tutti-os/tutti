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
      hostWindowApi.onLayout(({ maximized }) => {
        commitWindowFrame();
        setIsWindowMaximized(maximized);
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
