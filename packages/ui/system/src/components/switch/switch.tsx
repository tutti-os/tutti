import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { LoadingIcon } from "#icons/system-icons";
import { cn } from "#lib/utils";

function Switch({
  className,
  disabled,
  loading = false,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  loading?: boolean;
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      data-loading={loading ? "true" : "false"}
      aria-busy={loading || undefined}
      disabled={loading || disabled}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-[background-color,border-color,box-shadow] outline-none focus-visible:border-[var(--border-focus)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--border-focus)_30%,transparent)] aria-invalid:border-[var(--state-danger)] aria-invalid:ring-2 aria-invalid:ring-[color-mix(in_srgb,var(--state-danger)_20%,transparent)] data-[size=default]:h-[18px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] data-[state=checked]:bg-[var(--tutti-purple)] data-[state=unchecked]:bg-[var(--text-disabled)] data-disabled:cursor-not-allowed data-disabled:opacity-100 data-[loading=true]:cursor-wait",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none inline-flex items-center justify-center rounded-full bg-[var(--white-stationary)] ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-[state=checked]:translate-x-[14px] group-data-[size=sm]/switch:data-[state=checked]:translate-x-[10px] group-data-[size=default]/switch:data-[state=unchecked]:translate-x-0 group-data-[size=sm]/switch:data-[state=unchecked]:translate-x-0"
      >
        {loading ? (
          <LoadingIcon
            aria-hidden="true"
            className="size-3 animate-spin text-[var(--tutti-purple)] group-data-[size=sm]/switch:size-2.5"
          />
        ) : null}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}

export { Switch };
