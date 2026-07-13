import {
  ArrowLeftIcon,
  Button,
  cn,
  menuItemClassName
} from "@tutti-os/ui-system";
import type { JSX, ReactNode } from "react";

export function BrowserNodeMenuItem({
  children,
  className,
  endAdornment,
  onClick
}: {
  children: ReactNode;
  className?: string;
  endAdornment?: ReactNode;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      className={cn(menuItemClassName, "w-full", className)}
      role="menuitem"
      type="button"
      onClick={onClick}
    >
      <span className="min-w-0 flex-1 text-left">{children}</span>
      {endAdornment ? (
        <span className="ml-auto text-[var(--text-tertiary)]">
          {endAdornment}
        </span>
      ) : null}
    </button>
  );
}

export function BrowserNodeMenuSeparator(): JSX.Element {
  return (
    <div
      aria-orientation="horizontal"
      className="mx-2 my-0.5 h-px bg-[var(--border-1)]"
      role="separator"
    />
  );
}

export function BrowserNodeMenuPanelHeader({
  backLabel,
  label,
  onBack
}: {
  backLabel: string;
  label: string;
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="mb-1 flex items-center gap-1 border-b border-[var(--border-1)] px-1 pb-1">
      <Button
        aria-label={backLabel}
        size="icon-sm"
        title={backLabel}
        type="button"
        variant="chrome"
        onClick={onBack}
      >
        <ArrowLeftIcon className="size-3.5" />
      </Button>
      <span className="min-w-0 flex-1 truncate px-1 text-[13px] font-medium text-[var(--text-primary)]">
        {label}
      </span>
    </div>
  );
}
