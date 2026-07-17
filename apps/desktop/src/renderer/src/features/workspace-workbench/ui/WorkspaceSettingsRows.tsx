import type { ReactNode } from "react";
import { cn } from "@renderer/lib/format";

export function SettingsRows({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex w-full flex-col gap-8 pb-[22px] pt-5", className)}>
      {children}
    </div>
  );
}

export function SettingsRow({
  children,
  label,
  valueClassName
}: {
  children: ReactNode;
  label: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex w-full items-center justify-between gap-4 max-[560px]:flex-col max-[560px]:items-stretch">
      <div className="min-w-0">
        <strong className="text-[13px] font-semibold text-[var(--text-primary)]">
          {label}
        </strong>
      </div>
      <div
        className={cn(
          "flex min-w-0 justify-end max-[560px]:justify-start",
          valueClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}
