export interface DockPopupVerticalClampInput {
  marginPx?: number;
  naturalBottomPx: number;
  naturalTopPx: number;
  viewportHeightPx: number;
}

export function resolveDockPopupVerticalClampOffsetPx(
  input: DockPopupVerticalClampInput
): number {
  const marginPx = input.marginPx ?? 8;
  const minTopPx = marginPx;
  const maxBottomPx = input.viewportHeightPx - marginPx;

  if (input.naturalTopPx < minTopPx) {
    return minTopPx - input.naturalTopPx;
  }
  if (input.naturalBottomPx > maxBottomPx) {
    const shiftUpPx = input.naturalBottomPx - maxBottomPx;
    const resultingTopPx = input.naturalTopPx - shiftUpPx;
    return resultingTopPx < minTopPx
      ? minTopPx - input.naturalTopPx
      : -shiftUpPx;
  }
  return 0;
}
