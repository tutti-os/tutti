import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle
} from "./sortable";

const accessibility = {
  announcements: {
    onDragStart: () => "Started sorting",
    onDragOver: () => "Changed position",
    onDragEnd: () => "Finished sorting",
    onDragCancel: () => "Canceled sorting"
  },
  screenReaderInstructions: {
    draggable: "Use Space and arrow keys to reorder"
  }
};

function SortableHarness(): React.JSX.Element {
  const [items, setItems] = useState(["first", "second", "third"]);
  return (
    <Sortable
      accessibility={accessibility}
      value={items}
      onValueChange={setItems}
    >
      <SortableContent>
        {items.map((item, index) => (
          <SortableItem key={item} data-sortable-index={index} value={item}>
            <SortableItemHandle aria-label={`Reorder ${item}`} />
            <span>{item}</span>
          </SortableItem>
        ))}
      </SortableContent>
    </Sortable>
  );
}

describe("Sortable keyboard sensor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("moves an item with Space, ArrowUp, Space through the real DndContext", async () => {
    const rectFor = (element: Element): DOMRect => {
      const item = element.closest<HTMLElement>("[data-sortable-index]");
      const index = Number(item?.dataset.sortableIndex ?? 0);
      const top = index * 40;
      return {
        bottom: top + 32,
        height: 32,
        left: 0,
        right: 160,
        top,
        width: 160,
        x: 0,
        y: top,
        toJSON: () => ({})
      };
    };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        return rectFor(this);
      }
    );
    vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
      function (this: Element) {
        return [rectFor(this)] as unknown as DOMRectList;
      }
    );
    render(<SortableHarness />);

    const handle = screen.getByRole("button", { name: "Reorder second" });
    handle.focus();
    fireEvent.keyDown(handle, { code: "Space", key: " " });
    await waitFor(() => expect(handle).toHaveAttribute("aria-pressed", "true"));
    fireEvent.keyDown(handle, { code: "ArrowUp", key: "ArrowUp" });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Changed position")
    );
    fireEvent.keyDown(handle, { code: "Space", key: " " });

    await waitFor(() =>
      expect(
        screen.getAllByRole("button").map((button) => button.ariaLabel)
      ).toEqual(["Reorder second", "Reorder first", "Reorder third"])
    );
  });
});
