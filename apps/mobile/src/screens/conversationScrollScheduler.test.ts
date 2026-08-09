import { createConversationScrollScheduler } from "./conversationScrollScheduler";

test("drops queued auto-follow scrolling after the user detaches", () => {
  let followState: "detached" | "following" = "following";
  let nextFrame = 1;
  const frames = new Map<number, () => void>();
  const scrolls: boolean[] = [];
  const scheduler = createConversationScrollScheduler({
    cancelFrame: (frame) => frames.delete(frame),
    getFollowState: () => followState,
    onScrollToEnd: (animated) => scrolls.push(animated),
    requestFrame: (callback) => {
      const frame = nextFrame++;
      frames.set(frame, callback);
      return frame;
    }
  });

  scheduler.schedule(false, "auto-follow");
  followState = "detached";
  frames.get(1)?.();

  expect(scrolls).toEqual([]);
});

test("keeps explicit scroll-to-bottom requests while detached", () => {
  const frames = new Map<number, () => void>();
  const scrolls: boolean[] = [];
  const scheduler = createConversationScrollScheduler({
    cancelFrame: (frame) => frames.delete(frame),
    getFollowState: () => "detached",
    onScrollToEnd: (animated) => scrolls.push(animated),
    requestFrame: (callback) => {
      frames.set(1, callback);
      return 1;
    }
  });

  scheduler.schedule(true, "requested");
  frames.get(1)?.();

  expect(scrolls).toEqual([true]);
});

test("cancels queued scrolling when a touch takes ownership", () => {
  const frames = new Map<number, () => void>();
  const scrolls: boolean[] = [];
  const scheduler = createConversationScrollScheduler({
    cancelFrame: (frame) => frames.delete(frame),
    getFollowState: () => "following",
    onScrollToEnd: (animated) => scrolls.push(animated),
    requestFrame: (callback) => {
      frames.set(1, callback);
      return 1;
    }
  });

  scheduler.schedule(false, "auto-follow");
  scheduler.cancel();
  frames.get(1)?.();

  expect(scrolls).toEqual([]);
});
