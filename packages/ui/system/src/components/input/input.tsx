import * as React from "react";

import { cn } from "#lib/utils";

type InputVariant = "lg" | "md" | "sm" | "otp";

type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  variant?: InputVariant;
  size?: "default" | "sm";
};

const inputVariantClassNames: Record<InputVariant | "default", string> = {
  default: "h-8 rounded-md px-3 py-0 text-[13px] leading-[1.3]",
  lg: "h-12 rounded-[8px] px-4 py-3 text-[15px] leading-[1.3]",
  md: "h-8 rounded-md px-3 py-0 text-[13px] leading-[1.3]",
  sm: "h-8 rounded-md px-3 py-0 text-[13px] leading-[1.3]",
  otp: "h-12 w-12 rounded-[4px] px-0 text-center text-xl font-medium sm:h-14 sm:w-14 sm:text-2xl"
};

function Input({
  className,
  size = "default",
  type,
  variant,
  ...props
}: InputProps) {
  const resolvedVariant = variant ?? (size === "sm" ? "sm" : "default");

  return (
    <input
      type={type}
      data-slot="input"
      data-size={size}
      data-variant={resolvedVariant}
      className={cn(
        "w-full min-w-0 appearance-none border-0 bg-[var(--transparency-block)] font-normal text-[var(--text-primary)] shadow-none transition-colors duration-200 outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] hover:bg-[var(--transparency-hover)] focus:bg-[var(--transparency-hover)] focus-visible:border-0 focus-visible:bg-[var(--transparency-hover)] focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-[var(--transparency-block)] disabled:text-[var(--text-disabled)] disabled:opacity-100 aria-invalid:border-0 aria-invalid:bg-[var(--transparency-block)] aria-invalid:hover:bg-[var(--transparency-hover)] aria-invalid:focus:bg-[var(--transparency-hover)] aria-invalid:focus-visible:bg-[var(--transparency-hover)] aria-invalid:ring-0 aria-invalid:shadow-none",
        inputVariantClassNames[resolvedVariant],
        !variant && size === "sm" && "h-7 rounded-[4px] px-2 text-[11px]",
        className
      )}
      {...props}
    />
  );
}

export { Input };
