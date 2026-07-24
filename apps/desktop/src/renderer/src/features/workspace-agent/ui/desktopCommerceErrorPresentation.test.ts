import assert from "node:assert/strict";
import test from "node:test";
import { buildDesktopCommerceErrorPresentation } from "./desktopCommerceErrorPresentation.ts";

const copy = {
  upgradeMembership: {
    message: "Upgrade message",
    actionLabel: "Upgrade"
  },
  rechargeCredits: {
    message: "Recharge message",
    actionLabel: "Recharge"
  },
  creditsUnavailable: {
    message: "Neutral message",
    actionLabel: "View options"
  }
};

for (const [semantic, message, label] of [
  ["upgrade-membership", "Upgrade message", "Upgrade"],
  ["recharge-credits", "Recharge message", "Recharge"],
  ["credits-unavailable", "Neutral message", "View options"]
] as const) {
  test(`Desktop projects ${semantic} semantic without tier-name guessing`, () => {
    assert.deepEqual(
      buildDesktopCommerceErrorPresentation({
        semantic,
        actionUrl: "https://example.test/plans",
        copy
      }).insufficient_credits,
      {
        message,
        providers: ["tutti-agent"],
        action: {
          label,
          url: "https://example.test/plans"
        }
      }
    );
  });
}

test("Desktop keeps sanitized copy but omits an unavailable Host URL", () => {
  assert.deepEqual(
    buildDesktopCommerceErrorPresentation({
      semantic: "recharge-credits",
      actionUrl: " ",
      copy
    }).insufficient_credits,
    {
      message: "Recharge message",
      providers: ["tutti-agent"],
      action: null
    }
  );
});
