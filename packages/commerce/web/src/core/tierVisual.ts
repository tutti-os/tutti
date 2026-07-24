import type { MembershipTierVisual } from "./contracts";

const TIER_VISUALS: Readonly<Record<string, MembershipTierVisual>> = {
  basic: "lite",
  lite: "lite",
  pro: "pro",
  ultra: "ultra",
  free: "free"
};

export function resolveMembershipTierVisual(
  tierKey: string | null | undefined
): MembershipTierVisual | null {
  const canonicalKey = tierKey?.trim().toLowerCase();
  if (!canonicalKey) {
    return null;
  }
  return TIER_VISUALS[canonicalKey] ?? null;
}
