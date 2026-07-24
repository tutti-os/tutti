import { describe, expect, it } from "vitest";
import { resolveMembershipTierVisual } from "./tierVisual";

describe("membership tier visual", () => {
  it("maps the canonical basic tier to the existing lite visual", () => {
    expect(resolveMembershipTierVisual("basic")).toBe("lite");
  });

  it.each([
    ["free", "free"],
    ["lite", "lite"],
    ["pro", "pro"],
    ["ultra", "ultra"],
    ["unknown", null],
    ["Pro Plus", null],
    ["", null]
  ] as const)("maps %s without display-name guessing", (tier, visual) => {
    expect(resolveMembershipTierVisual(tier)).toBe(visual);
  });
});
