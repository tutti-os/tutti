import {
  useCallback,
  useMemo,
  type Dispatch,
  type SetStateAction
} from "react";
import type { WorkbenchHostActivation } from "@tutti-os/workbench-surface";
import type { DesktopAgentGUIOpenSessionComposerRequest } from "../services/desktopAgentGUIOpenSessionComposerActivation.ts";
import { resolveDesktopAgentGUIConnectorSelectionActivation } from "../services/desktopAgentGUIConnectorSelectionActivation.ts";
import { useDesktopAgentGUIOpenSessionComposerRequest } from "./useDesktopAgentGUIOpenSessionComposerRequest.ts";

export function useDesktopAgentGUIConnectorSelectionActivation(input: {
  activation: WorkbenchHostActivation | null;
  clearNodeActivation?: (nodeId: string, sequence: number) => void;
  nodeId: string;
  setOpenSessionComposerRequest: Dispatch<
    SetStateAction<DesktopAgentGUIOpenSessionComposerRequest | null>
  >;
}) {
  const connectorSelectionRequest = useMemo(
    () => resolveDesktopAgentGUIConnectorSelectionActivation(input.activation),
    [input.activation]
  );
  const clearOpenSessionComposerRequest =
    useDesktopAgentGUIOpenSessionComposerRequest(
      input.setOpenSessionComposerRequest
    );
  const handleComposerAppendHandled = useCallback(
    (sequence: number): void => {
      clearOpenSessionComposerRequest(sequence);
      if (connectorSelectionRequest?.sequence === sequence) {
        input.clearNodeActivation?.(input.nodeId, sequence);
      }
    },
    [
      clearOpenSessionComposerRequest,
      connectorSelectionRequest?.sequence,
      input.clearNodeActivation,
      input.nodeId
    ]
  );

  return { connectorSelectionRequest, handleComposerAppendHandled };
}
