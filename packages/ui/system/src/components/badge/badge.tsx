import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "#lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[4px] border border-transparent whitespace-nowrap transition-[background-color,border-color,color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--transparency-block)] text-[var(--text-secondary)] [a]:hover:bg-[var(--transparency-hover)]",
        accent:
          "bg-[var(--accent-bg)] text-[var(--accent)] [a]:hover:bg-[var(--accent-bg)]",
        success:
          "bg-[color-mix(in_srgb,var(--state-success)_10%,transparent)] text-[var(--state-success)] [a]:hover:bg-[color-mix(in_srgb,var(--state-success)_14%,transparent)]",
        warning:
          "bg-[color-mix(in_srgb,var(--state-warning)_12%,transparent)] text-[var(--state-warning)] [a]:hover:bg-[color-mix(in_srgb,var(--state-warning)_16%,transparent)]",
        pending:
          "bg-[color-mix(in_srgb,var(--rich-text-mention-issue)_12%,transparent)] text-[var(--rich-text-mention-issue)] [a]:hover:bg-[color-mix(in_srgb,var(--rich-text-mention-issue)_16%,transparent)]",
        muted:
          "bg-[color-mix(in_srgb,var(--transparency-block)_72%,transparent)] text-[var(--text-tertiary)] [a]:hover:bg-[var(--transparency-hover)]",
        secondary:
          "bg-[var(--transparency-block)] text-[var(--text-secondary)] [a]:hover:bg-[var(--transparency-hover)]",
        destructive:
          "bg-[var(--on-danger)] text-[var(--state-danger)] focus-visible:ring-[color-mix(in_srgb,var(--state-danger)_20%,transparent)] [a]:hover:bg-[var(--on-danger-hover)]",
        outline:
          "border-border bg-card/90 text-foreground [a]:hover:bg-muted [a]:hover:text-foreground",
        ghost:
          "hover:bg-accent/80 hover:text-accent-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-5 px-1 py-0.5 text-[0.72rem] font-normal [&>svg]:size-3!",
        sm: "h-4 gap-0.5 px-1 py-0 text-[10px] font-medium leading-none [&>svg]:size-2.5!"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

function Badge({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
