import freeIconUrl from "@tutti-os/commerce/assets/star-free.png";
import liteIconUrl from "@tutti-os/commerce/assets/star-lite.png";
import proIconUrl from "@tutti-os/commerce/assets/star-pro.png";
import ultraIconUrl from "@tutti-os/commerce/assets/star-ultra.png";
import {
  resolveMembershipTierVisual,
  type MembershipTierVisual
} from "../index";

const ICON_URLS: Readonly<Record<MembershipTierVisual, string>> = {
  free: freeIconUrl,
  lite: liteIconUrl,
  pro: proIconUrl,
  ultra: ultraIconUrl
};

export interface MembershipTierIconProps {
  tierKey: string | null | undefined;
  className?: string;
}

export function MembershipTierIcon({
  tierKey,
  className = ""
}: MembershipTierIconProps): React.JSX.Element | null {
  const visual = resolveMembershipTierVisual(tierKey);
  if (!visual) {
    return null;
  }
  return (
    <img
      alt=""
      aria-hidden="true"
      draggable={false}
      src={ICON_URLS[visual]}
      className={className}
      data-membership-tier-visual={visual}
    />
  );
}
