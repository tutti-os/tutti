import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { CheckIcon } from "#icons/system-icons";
import { cn } from "#lib/utils";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-[var(--border-1)] bg-[var(--transparency-block)] text-[var(--text-inverted)] transition-[background-color,border-color,color,box-shadow] outline-none focus-visible:border-[var(--border-focus)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--border-focus)_30%,transparent)] disabled:cursor-not-allowed disabled:border-[var(--border-1)] disabled:bg-[var(--transparency-block)] disabled:text-[var(--text-inverted)] disabled:opacity-100 data-disabled:border-[var(--border-1)] aria-invalid:border-[var(--state-danger)] aria-invalid:ring-2 aria-invalid:ring-[color-mix(in_srgb,var(--state-danger)_20%,transparent)] data-[state=checked]:border-[var(--text-primary)] data-[state=checked]:bg-[var(--text-primary)] data-[state=indeterminate]:border-[var(--text-primary)] data-[state=indeterminate]:bg-[var(--text-primary)] data-[state=unchecked]:hover:border-[color-mix(in_srgb,var(--text-primary)_40%,transparent)] disabled:data-[state=checked]:border-[var(--border-1)] disabled:data-[state=checked]:bg-[var(--text-disabled)] disabled:data-[state=indeterminate]:border-[var(--border-1)] disabled:data-[state=indeterminate]:bg-[var(--text-disabled)] data-disabled:data-[state=checked]:border-[var(--border-1)] data-disabled:data-[state=indeterminate]:border-[var(--border-1)]",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none data-[state=checked]:[&>span]:hidden data-[state=indeterminate]:[&>svg]:hidden [&>svg]:size-3"
      >
        <CheckIcon size={14} />
        <span className="h-0.5 w-2.5 rounded-full bg-current" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
