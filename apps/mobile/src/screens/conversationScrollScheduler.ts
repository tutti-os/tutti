export type ConversationScrollIntent = "auto-follow" | "requested";

export function createConversationScrollScheduler({
  cancelFrame = (frame: number) => cancelAnimationFrame(frame),
  getFollowState,
  onScrollToEnd,
  requestFrame = (callback: () => void) => requestAnimationFrame(callback)
}: {
  cancelFrame?(frame: number): void;
  getFollowState(): "detached" | "following";
  onScrollToEnd(animated: boolean): void;
  requestFrame?(callback: () => void): number;
}) {
  let pendingFrame: number | null = null;

  const cancel = (): void => {
    if (pendingFrame === null) return;
    cancelFrame(pendingFrame);
    pendingFrame = null;
  };

  const schedule = (
    animated: boolean,
    intent: ConversationScrollIntent
  ): void => {
    cancel();
    pendingFrame = requestFrame(() => {
      pendingFrame = null;
      if (intent === "auto-follow" && getFollowState() !== "following") {
        return;
      }
      onScrollToEnd(animated);
    });
  };

  return { cancel, schedule };
}
