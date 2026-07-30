export function requestUiAnimationFrame(
  callback: FrameRequestCallback
): number {
  // presentation-work: schedule active transcript scroll and locate presentation work
  return window.requestAnimationFrame(callback);
}

export function cancelUiAnimationFrame(animationFrameId: number): void {
  window.cancelAnimationFrame(animationFrameId);
}

export function scheduleUiTimeout(
  callback: () => void,
  delayMs: number
): () => void {
  // timing: bound transcript presentation corrections and transition cleanup
  const timeoutId = window.setTimeout(callback, delayMs);
  return () => window.clearTimeout(timeoutId);
}
