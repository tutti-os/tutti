import * as React from "react";

import { cn } from "#lib/utils";

type RadioIndicatorProps = React.ComponentProps<"span"> & {
  checked?: boolean;
  disabled?: boolean;
};

function RadioIndicator({
  checked = false,
  disabled = false,
  className,
  ...props
}: RadioIndicatorProps) {
  return (
    <span
      {...props}
      aria-hidden={props["aria-hidden"] ?? true}
      data-checked={checked || undefined}
      data-disabled={disabled || undefined}
      data-slot="radio-indicator"
      data-state={checked ? "checked" : "unchecked"}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full border-2 border-[var(--border-1)] bg-transparent transition-[border-color,background-color,box-shadow] data-[state=checked]:border-[var(--tutti-purple)] data-[state=unchecked]:hover:border-[color-mix(in_srgb,var(--text-primary)_40%,transparent)] data-disabled:cursor-not-allowed data-disabled:opacity-60",
        className
      )}
    >
      {checked ? (
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-[var(--tutti-purple)]"
        />
      ) : null}
    </span>
  );
}

export { RadioIndicator };
export type { RadioIndicatorProps };
