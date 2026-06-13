import { useCallback, useState } from "react";
import {
  readWorkspaceFileManagerArrangeMode,
  writeWorkspaceFileManagerArrangeMode,
  type WorkspaceFileManagerArrangeMode
} from "./workspaceFileManagerArrangeMode.ts";

export function useWorkspaceFileManagerArrangeMode(): {
  arrangeMode: WorkspaceFileManagerArrangeMode;
  setArrangeMode: (arrangeMode: WorkspaceFileManagerArrangeMode) => void;
} {
  const [arrangeMode, setArrangeModeState] = useState(
    readWorkspaceFileManagerArrangeMode
  );

  const setArrangeMode = useCallback(
    (nextArrangeMode: WorkspaceFileManagerArrangeMode) => {
      setArrangeModeState(nextArrangeMode);
      writeWorkspaceFileManagerArrangeMode(nextArrangeMode);
    },
    []
  );

  return { arrangeMode, setArrangeMode };
}
