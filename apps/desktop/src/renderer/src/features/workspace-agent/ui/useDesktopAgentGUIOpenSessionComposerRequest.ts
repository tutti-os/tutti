import { useCallback, type Dispatch, type SetStateAction } from "react";
import {
  clearDesktopAgentGUIOpenSessionComposerRequest,
  type DesktopAgentGUIOpenSessionComposerRequest
} from "../services/desktopAgentGUIOpenSessionComposerActivation.ts";

export function useDesktopAgentGUIOpenSessionComposerRequest(
  setRequest: Dispatch<
    SetStateAction<DesktopAgentGUIOpenSessionComposerRequest | null>
  >
): (sequence: number) => void {
  return useCallback(
    (sequence: number) => {
      setRequest((current) =>
        clearDesktopAgentGUIOpenSessionComposerRequest(current, sequence)
      );
    },
    [setRequest]
  );
}
