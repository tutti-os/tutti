import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "#lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent text-[13px] font-normal whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--text-primary)] text-[var(--text-inverted)] shadow-none hover:bg-[var(--text-primary-hover)]",
        outline:
          "border-border bg-card text-foreground hover:bg-muted/80 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-transparency-block text-[var(--text-primary)] hover:bg-transparency-hover aria-expanded:bg-transparency-hover aria-expanded:text-[var(--text-primary)]",
        ghost:
          "bg-transparent text-[var(--text-primary)] hover:bg-transparency-hover aria-expanded:bg-transparency-hover aria-expanded:text-[var(--text-primary)]",
        chrome:
          "border border-transparent bg-transparent text-[var(--text-tertiary)] shadow-none hover:border-transparent hover:bg-[var(--transparency-hover)] hover:text-[var(--text-primary)] active:bg-[var(--transparency-active)] active:text-[var(--text-primary)] aria-expanded:border-transparent aria-expanded:bg-[var(--transparency-block)] aria-expanded:text-[var(--text-primary)] disabled:pointer-events-auto disabled:cursor-not-allowed disabled:opacity-45",
        destructive:
          "bg-[var(--state-danger)] text-[var(--white-stationary)] hover:bg-[var(--state-danger-hover)] focus-visible:border-[var(--state-danger)] focus-visible:ring-[color-mix(in_srgb,var(--state-danger)_25%,transparent)]",
        "destructive-secondary":
          "bg-[var(--on-danger)] text-[var(--state-danger)] hover:bg-[var(--on-danger-hover)] focus-visible:border-[var(--state-danger)] focus-visible:ring-[color-mix(in_srgb,var(--state-danger)_25%,transparent)]",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default:
          "h-8 gap-[6px] px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg[data-icon=inline-start]:not([class*='size-'])]:size-3.5 [&_[data-icon=inline-start]_svg:not([class*='size-'])]:size-3.5",
        dialog:
          "h-8 gap-[6px] rounded-md px-3 text-[13px] font-normal leading-5 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg[data-icon=inline-start]:not([class*='size-'])]:size-3.5 [&_[data-icon=inline-start]_svg:not([class*='size-'])]:size-3.5",
        xs: "h-6 gap-1 rounded-sm px-2 text-[11px] in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3 [&_svg[data-icon=inline-start]:not([class*='size-'])]:size-2.5 [&_[data-icon=inline-start]_svg:not([class*='size-'])]:size-2.5",
        sm: "h-7 gap-1 rounded-sm px-2.5 text-[13px] in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5 [&_svg[data-icon=inline-start]:not([class*='size-'])]:size-3 [&_[data-icon=inline-start]_svg:not([class*='size-'])]:size-3",
        lg: "h-9 gap-2 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5 [&_svg[data-icon=inline-start]:not([class*='size-'])]:size-3.5 [&_[data-icon=inline-start]_svg:not([class*='size-'])]:size-3.5",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-sm in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3 [&_svg[data-icon=inline-start]:not([class*='size-'])]:size-2.5 [&_[data-icon=inline-start]_svg:not([class*='size-'])]:size-2.5",
        "icon-sm": "size-7 rounded-sm in-data-[slot=button-group]:rounded-md",
        "icon-lg": "size-9"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    },
    compoundVariants: [
      {
        variant: "chrome",
        size: "icon-sm",
        class: "rounded-[4px]"
      }
    ]
  }
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = "default",
      size = "default",
      asChild = false,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot.Root : "button";

    return (
      <Comp
        ref={ref}
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
