import { Crown } from "lucide-react";

interface AccountMembershipBadgeProps {
  label: string;
  className?: string;
}

export function AccountMembershipBadge({
  label,
  className = ""
}: AccountMembershipBadgeProps): React.JSX.Element {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-[5px] bg-[color-mix(in_srgb,var(--tutti-purple)_18%,transparent)] px-1.5 py-0.5 text-[11px] font-semibold leading-3 text-[var(--tutti-purple)] ${className}`}
      data-account-membership-badge="true"
    >
      <Crown aria-hidden="true" size={11} strokeWidth={1.9} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
