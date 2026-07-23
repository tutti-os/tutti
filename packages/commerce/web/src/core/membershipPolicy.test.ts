import { describe, expect, it } from "vitest";
import {
  resolveInsufficientCreditsSemantic,
  resolveMembershipAction
} from "./membershipPolicy";

describe("membership policy", () => {
  it.each(["free", "inactive"] as const)(
    "routes %s users to membership upgrade",
    (access) => {
      expect(resolveMembershipAction(access)).toBe("upgrade-membership");
      expect(resolveInsufficientCreditsSemantic(access)).toEqual({
        message: "upgrade-membership",
        action: "upgrade-membership"
      });
    }
  );

  it("routes active members to credit recharge", () => {
    expect(resolveMembershipAction("active")).toBe("recharge-credits");
    expect(resolveInsufficientCreditsSemantic("active")).toEqual({
      message: "recharge-credits",
      action: "recharge-credits"
    });
  });

  it.each([undefined, null, "unknown"] as const)(
    "keeps %s access neutral",
    (access) => {
      expect(resolveMembershipAction(access)).toBe("view-credit-plans");
      expect(resolveInsufficientCreditsSemantic(access)).toEqual({
        message: "credits-unavailable",
        action: "view-credit-plans"
      });
    }
  );
});
