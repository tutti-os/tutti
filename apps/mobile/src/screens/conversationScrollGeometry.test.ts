import {
  conversationDistanceFromBottom,
  initialConversationScrollGeometry,
  updateConversationScrollGeometry
} from "./conversationScrollGeometry";

test("preserves measured native geometry across conversation changes", () => {
  const measured = [
    { height: 1_800, type: "content-size-changed" as const },
    { height: 600, type: "layout-changed" as const },
    {
      contentHeight: 1_800,
      offsetY: 1_200,
      type: "scrolled" as const,
      viewportHeight: 600
    }
  ].reduce(updateConversationScrollGeometry, initialConversationScrollGeometry);

  const switched = updateConversationScrollGeometry(measured, {
    type: "conversation-changed"
  });

  expect(switched).toBe(measured);
  expect(conversationDistanceFromBottom(switched)).toBe(0);
});

test("uses replacement native measurements after a conversation changes", () => {
  const measured = {
    contentHeight: 1_800,
    offsetY: 1_200,
    viewportHeight: 600
  };
  const switched = updateConversationScrollGeometry(measured, {
    type: "conversation-changed"
  });
  const resized = updateConversationScrollGeometry(switched, {
    height: 2_400,
    type: "content-size-changed"
  });
  const scrolled = updateConversationScrollGeometry(resized, {
    contentHeight: 2_400,
    offsetY: 1_800,
    type: "scrolled",
    viewportHeight: 600
  });

  expect(conversationDistanceFromBottom(scrolled)).toBe(0);
});
