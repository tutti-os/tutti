import { useMemo } from "react";
import { getWorkbenchLockedSlotFrames } from "../core/geometry.ts";
import type { WorkbenchState } from "../core/types.ts";
import { useWorkbenchSelector } from "./hooks/useWorkbenchSelector.ts";

const selectLockedLayout = (state: WorkbenchState) => state.lockedLayout;
const selectSurfaceSize = (state: WorkbenchState) => state.surfaceSize;
const selectLayoutConstraints = (state: WorkbenchState) =>
  state.layoutConstraints;

/**
 * Renders dashed slot outlines behind the windows while a layout is locked,
 * making the fixed grid visible on the desktop.
 */
export function WorkbenchLockedSlotLayer() {
  const lockedLayout = useWorkbenchSelector(selectLockedLayout);
  const surfaceSize = useWorkbenchSelector(selectSurfaceSize);
  const layoutConstraints = useWorkbenchSelector(selectLayoutConstraints);
  const slots = useMemo(
    () =>
      getWorkbenchLockedSlotFrames(
        lockedLayout,
        surfaceSize,
        layoutConstraints
      ),
    [layoutConstraints, lockedLayout, surfaceSize]
  );

  if (!slots) {
    return null;
  }

  return (
    <div aria-hidden className="workbench-locked-slot-layer">
      {slots.map((slot) => (
        <div
          key={slot.nodeID}
          className="workbench-locked-slot"
          style={{
            left: slot.frame.x,
            top: slot.frame.y,
            width: slot.frame.width,
            height: slot.frame.height
          }}
        />
      ))}
    </div>
  );
}
