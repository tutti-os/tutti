import { useCallback, useState } from "react";

export function useAgentGUIProjectMenuState(
  isRailInteractionLocked: () => boolean,
  isUserProjectMutationPending: boolean
): {
  isProjectActionLocked: () => boolean;
  onProjectMenuOpenChange: (sectionId: string, open: boolean) => void;
  projectMenuOpen: boolean;
} {
  const [openSectionId, setOpenSectionId] = useState<string | null>(null);
  const isProjectActionLocked = useCallback(
    () => isRailInteractionLocked() || isUserProjectMutationPending,
    [isRailInteractionLocked, isUserProjectMutationPending]
  );
  const onProjectMenuOpenChange = useCallback(
    (sectionId: string, open: boolean) => {
      setOpenSectionId((current) =>
        open ? sectionId : current === sectionId ? null : current
      );
    },
    []
  );
  return {
    isProjectActionLocked,
    onProjectMenuOpenChange,
    projectMenuOpen: openSectionId !== null
  };
}
