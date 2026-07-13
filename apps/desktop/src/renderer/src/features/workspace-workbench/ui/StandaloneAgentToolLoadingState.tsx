import type { ReactNode } from "react";
import { Spinner } from "@tutti-os/ui-system";

export function StandaloneAgentToolLoadingState({
  label
}: {
  label: string;
}): ReactNode {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center text-[var(--text-tertiary)]"
      role="status"
    >
      <Spinner size={18} />
      <span className="sr-only">{label}</span>
    </div>
  );
}
