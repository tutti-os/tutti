import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from "./dropdown-menu";

describe("DropdownMenuCheckboxItem", () => {
  it("renders a distinct dash for the indeterminate state", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Filters</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked="indeterminate">
            All sources
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    const item = screen.getByRole("menuitemcheckbox", {
      name: "All sources"
    });
    const indicator = item.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-checkbox-item-indicator"]'
    );
    const check = item.querySelector(
      '[data-slot="dropdown-menu-checkbox-item-check"]'
    );
    const indeterminate = item.querySelector(
      '[data-slot="dropdown-menu-checkbox-item-indeterminate"]'
    );

    expect(item).toHaveAttribute("aria-checked", "mixed");
    expect(item).toHaveAttribute("data-state", "indeterminate");
    expect(item).toHaveClass(
      "data-[state=checked]:[&_[data-slot=dropdown-menu-checkbox-item-indeterminate]]:hidden",
      "data-[state=indeterminate]:[&_[data-slot=dropdown-menu-checkbox-item-check]]:hidden"
    );
    expect(indicator).toBeInTheDocument();
    expect(check).toBeInTheDocument();
    expect(indeterminate).toBeInTheDocument();
  });
});
