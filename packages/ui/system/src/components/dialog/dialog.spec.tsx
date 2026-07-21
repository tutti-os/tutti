import { fireEvent, render, screen } from "@testing-library/react";
import type { MouseEvent, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../button/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle
} from "./dialog";

function WorkspaceClickCaptureBoundary({
  children
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div
      onClickCapture={(event: MouseEvent<HTMLDivElement>) => {
        if (
          event.target instanceof Element &&
          !event.target.closest(".nodrag")
        ) {
          event.stopPropagation();
        }
      }}
    >
      {children}
    </div>
  );
}

describe("DialogContent", () => {
  it("keeps dialog actions interactive inside workspace click capture", () => {
    const onOpenChange = vi.fn();

    render(
      <WorkspaceClickCaptureBoundary>
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent showCloseButton={false}>
            <DialogTitle>Dialog title</DialogTitle>
            <DialogDescription>Dialog description</DialogDescription>
            <DialogClose asChild>
              <Button type="button">Cancel</Button>
            </DialogClose>
          </DialogContent>
        </Dialog>
      </WorkspaceClickCaptureBoundary>
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
