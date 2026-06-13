import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "#lib/utils";

const bareIconButtonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center border border-transparent bg-transparent p-0 text-[var(--text-tertiary)] transition-[color,opacity,box-shadow] duration-150 outline-none select-none hover:border-transparent hover:bg-transparent hover:text-[var(--text-primary)] active:bg-transparent active:text-[var(--text-primary)] aria-expanded:bg-transparent aria-expanded:text-[var(--text-primary)] focus-visible:border-transparent focus-visible:bg-transparent focus-visible:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--border-focus)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-transparent disabled:text-[var(--text-disabled)] disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        md: "size-6 rounded-[4px] [&_svg:not([class*='size-'])]:size-4",
        sm: "size-5 rounded-[3px] [&_svg:not([class*='size-'])]:size-3.5"
      }
    },
    defaultVariants: {
      size: "md"
    }
  }
);

type BareIconButtonSize = NonNullable<
  VariantProps<typeof bareIconButtonVariants>["size"]
>;

type BareIconButtonProps = Omit<
  React.ComponentProps<"button">,
  "aria-label" | "children"
> & {
  "aria-label": string;
  asChild?: boolean;
  children: React.ReactNode;
  size?: BareIconButtonSize;
};

const BareIconButton = React.forwardRef<HTMLButtonElement, BareIconButtonProps>(
  (
    { className, size = "md", asChild = false, type = "button", ...props },
    ref
  ) => {
    const Comp = asChild ? Slot.Root : "button";

    return (
      <Comp
        ref={ref}
        data-slot="bare-icon-button"
        data-size={size}
        type={type}
        className={cn(bareIconButtonVariants({ size, className }))}
        {...props}
      />
    );
  }
);
BareIconButton.displayName = "BareIconButton";

export { BareIconButton };
export type { BareIconButtonProps };
