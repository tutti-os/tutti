import type { DndContextProps, DragEndEvent } from "@dnd-kit/core";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const dndContext = vi.hoisted(() => ({
  props: null as DndContextProps | null
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      dndContext.props = props;
      return props.children as ReactNode;
    }
  };
});

import { Sortable } from "./sortable";

const accessibility = {
  announcements: {
    onDragStart: () => undefined,
    onDragMove: () => undefined,
    onDragOver: () => undefined,
    onDragEnd: () => undefined,
    onDragCancel: () => undefined
  },
  screenReaderInstructions: { draggable: "Use the keyboard to move an item" }
};

describe("Sortable behavior", () => {
  it("commits a keyboard move when the sensor prevented the activator event", () => {
    const onMove = vi.fn();
    render(
      <Sortable
        accessibility={accessibility}
        onMove={onMove}
        value={["first", "second"]}
      >
        <div />
      </Sortable>
    );
    const activatorEvent = new KeyboardEvent("keydown", { cancelable: true });
    activatorEvent.preventDefault();

    act(() => {
      dndContext.props?.onDragEnd?.({
        active: { id: "second" },
        over: { id: "first" },
        activatorEvent
      } as unknown as DragEndEvent);
    });

    expect(activatorEvent.defaultPrevented).toBe(true);
    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ activeIndex: 1, overIndex: 0 })
    );
  });

  it("ignores a stale drag whose active item disappeared from controlled value", () => {
    const onMove = vi.fn();
    render(
      <Sortable
        accessibility={accessibility}
        onMove={onMove}
        value={["first", "second"]}
      >
        <div />
      </Sortable>
    );

    act(() => {
      dndContext.props?.onDragEnd?.({
        active: { id: "removed" },
        over: { id: "first" },
        activatorEvent: new MouseEvent("mouseup")
      } as unknown as DragEndEvent);
    });

    expect(onMove).not.toHaveBeenCalled();
  });
});
