import type * as React from "react";
import { forwardRef } from "react";
import { Button } from "@tutti-os/ui-system";
import { cn } from "@renderer/lib/format";

export const workspaceSettingsControlColumnClass =
  "w-[220px] min-w-[220px] max-[560px]:w-full max-[560px]:min-w-0";

type WorkspaceSettingsActionButtonProps = Omit<
  React.ComponentPropsWithoutRef<typeof Button>,
  "children" | "size" | "variant"
> & {
  icon?: React.ReactNode;
  label: string;
  progress?: number | null;
  progressAriaLabel?: string;
  variant?: "default" | "secondary" | "destructive" | "destructive-secondary";
};

export const WorkspaceSettingsActionButton = forwardRef<
  HTMLButtonElement,
  WorkspaceSettingsActionButtonProps
>(function WorkspaceSettingsActionButton(
  {
    className,
    disabled,
    icon,
    label,
    progress = null,
    progressAriaLabel,
    variant = "secondary",
    ...buttonProps
  },
  ref
) {
  const running = progress !== null;

  return (
    <Button
      {...buttonProps}
      ref={ref}
      aria-label={running ? progressAriaLabel : buttonProps["aria-label"]}
      aria-valuemax={running ? 100 : undefined}
      aria-valuemin={running ? 0 : undefined}
      aria-valuenow={running ? Math.round(progress) : undefined}
      className={cn(
        "relative h-8 min-w-0 w-full overflow-hidden rounded-[6px]",
        className
      )}
      disabled={disabled}
      role={running ? "progressbar" : buttonProps.role}
      size="default"
      variant={variant}
    >
      {running && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-0 z-0 transition-[width] duration-200 ease-out",
            variant === "destructive"
              ? "bg-[color-mix(in_srgb,var(--white-stationary)_24%,transparent)]"
              : variant === "destructive-secondary"
                ? "bg-[color-mix(in_srgb,var(--state-danger)_14%,transparent)]"
                : "bg-[color-mix(in_srgb,var(--text-primary)_14%,transparent)]"
          )}
          style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
        />
      )}
      <span className="relative z-[1] flex min-w-0 items-center justify-center gap-1.5 truncate">
        {icon}
        <span className="truncate">{label}</span>
      </span>
    </Button>
  );
});
