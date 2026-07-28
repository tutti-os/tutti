import { BillingIcon } from "@tutti-os/ui-system";
import { MembershipTierIcon } from "./MembershipTierIcon";

export interface MembershipBadgeProps {
  label: string;
  tierKey?: string | null;
  className?: string;
}

export function MembershipBadge({
  label,
  tierKey = null,
  className = ""
}: MembershipBadgeProps): React.JSX.Element {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-[5px] py-0.5 text-[11px] font-normal leading-3 text-[var(--text-secondary)] ${className}`}
      data-commerce-membership-badge="true"
    >
      {tierKey ? (
        <MembershipTierIcon
          className="size-3.5 shrink-0 object-contain"
          tierKey={tierKey}
        />
      ) : (
        <BillingIcon aria-hidden="true" size={11} />
      )}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
