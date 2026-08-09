export interface ConversationScrollGeometry {
  contentHeight: number;
  offsetY: number;
  viewportHeight: number;
}

export type ConversationScrollGeometryEvent =
  | { type: "content-size-changed"; height: number }
  | { type: "conversation-changed" }
  | { type: "layout-changed"; height: number }
  | {
      type: "scrolled";
      contentHeight: number;
      offsetY: number;
      viewportHeight: number;
    };

export const initialConversationScrollGeometry: ConversationScrollGeometry = {
  contentHeight: 0,
  offsetY: 0,
  viewportHeight: 0
};

export function updateConversationScrollGeometry(
  geometry: ConversationScrollGeometry,
  event: ConversationScrollGeometryEvent
): ConversationScrollGeometry {
  switch (event.type) {
    case "content-size-changed":
      return { ...geometry, contentHeight: event.height };
    case "conversation-changed":
      // The same native ScrollView remains mounted and may not emit onLayout
      // again. Preserve its last measured viewport and current geometry until
      // native content-size and scroll events replace the values.
      return geometry;
    case "layout-changed":
      return { ...geometry, viewportHeight: event.height };
    case "scrolled":
      return {
        contentHeight: event.contentHeight,
        offsetY: event.offsetY,
        viewportHeight: event.viewportHeight
      };
  }
}

export function conversationDistanceFromBottom(
  geometry: ConversationScrollGeometry
): number {
  return geometry.contentHeight - geometry.viewportHeight - geometry.offsetY;
}
