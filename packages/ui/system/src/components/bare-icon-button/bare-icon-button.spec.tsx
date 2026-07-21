import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BareIconButton } from "./bare-icon-button";

describe("BareIconButton", () => {
  it("uses its accessible name as the default hover title", () => {
    render(
      <BareIconButton aria-label="Edit password">
        <span aria-hidden="true">E</span>
      </BareIconButton>
    );

    expect(
      screen.getByRole("button", { name: "Edit password" })
    ).toHaveAttribute("title", "Edit password");
  });

  it("keeps an explicitly supplied hover title", () => {
    render(
      <BareIconButton aria-label="Remove member" title="Remove Ada">
        <span aria-hidden="true">R</span>
      </BareIconButton>
    );

    expect(
      screen.getByRole("button", { name: "Remove member" })
    ).toHaveAttribute("title", "Remove Ada");
  });

  it("suppresses native hover title when title is empty", () => {
    render(
      <BareIconButton aria-label="Edit prompt" title="">
        <span aria-hidden="true">E</span>
      </BareIconButton>
    );

    expect(screen.getByRole("button", { name: "Edit prompt" })).toHaveAttribute(
      "title",
      ""
    );
  });
});
