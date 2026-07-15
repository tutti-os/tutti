import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RadioIndicator } from "./radio-indicator";

describe("RadioIndicator", () => {
  it("renders an unchecked indicator without a selected dot", () => {
    render(<RadioIndicator data-testid="radio" />);

    expect(screen.getByTestId("radio")).toHaveAttribute(
      "data-state",
      "unchecked"
    );
    expect(screen.getByTestId("radio").firstElementChild).toBeNull();
  });

  it("renders the selected dot for a checked indicator", () => {
    render(<RadioIndicator checked data-testid="radio" />);

    expect(screen.getByTestId("radio")).toHaveAttribute(
      "data-state",
      "checked"
    );
    expect(screen.getByTestId("radio").firstElementChild).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });
});
