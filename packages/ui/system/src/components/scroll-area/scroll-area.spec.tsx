import { createRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScrollArea } from "./scroll-area";

describe("ScrollArea", () => {
  it.each(["native", "custom"] as const)(
    "exposes the %s viewport content element",
    (scrollbarMode) => {
      const viewportContentRef = createRef<HTMLDivElement>();

      render(
        <ScrollArea
          scrollbarMode={scrollbarMode}
          viewportContentRef={viewportContentRef}
        >
          content
        </ScrollArea>
      );

      expect(viewportContentRef.current).toHaveAttribute(
        "data-slot",
        "scroll-area-content"
      );
    }
  );
});
