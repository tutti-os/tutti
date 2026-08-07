// Keep these layout constants in sync with workbench.css: --desktop-dock-gap
// (16px), --desktop-dock-items-padding (6.3px per side), the 1px separator
// with 4px margins per side (9px outer), and --desktop-dock-size (43.2px).
// A mismatch makes the dock frame narrower than its icons, so the dock
// truncates icons (or enters scroll mode) before its content actually
// overflows.
export const dockItemsGapPx = 16;
export const dockItemsHorizontalPaddingPx = 12.6;
export const dockSeparatorOuterWidthPx = 9;
export const dockSlotWidthPx = 43.2;

export interface WorkbenchDockItemsWidthInput {
  kind: string;
}

export function resolveWorkbenchHostDockItemsWidth(
  items: readonly WorkbenchDockItemsWidthInput[]
): number {
  if (items.length === 0) {
    return dockItemsHorizontalPaddingPx;
  }

  const itemWidth = items.reduce(
    (sum, item) =>
      sum +
      (item.kind === "separator" ? dockSeparatorOuterWidthPx : dockSlotWidthPx),
    0
  );
  const gapWidth = Math.max(0, items.length - 1) * dockItemsGapPx;
  return itemWidth + gapWidth + dockItemsHorizontalPaddingPx;
}
