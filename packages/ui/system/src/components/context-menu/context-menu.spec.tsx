import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from "./context-menu";

describe("ContextMenu", () => {
  it("renders a trigger target", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <span data-testid="target">target</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Copy image</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
    expect(screen.getByTestId("target")).toBeInTheDocument();
  });
});
