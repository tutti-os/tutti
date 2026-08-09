import type { ReactNode } from "react";

export interface ConnectorDialogInfoRowProps {
  description: string;
  icon: ReactNode;
  title: string;
}

export function ConnectorDialogInfoRow({
  description,
  icon,
  title
}: ConnectorDialogInfoRowProps) {
  return (
    <div className="flex items-start gap-3 border-b border-[var(--border-1)] px-3 py-2.5 last:border-b-0">
      <span className="flex size-10 shrink-0 items-center justify-center text-[var(--text-secondary)]">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-[var(--text-primary)]">
          {title}
        </div>
        <div className="mt-0.5 text-[11px] leading-[1.45] text-[var(--text-secondary)]">
          {description}
        </div>
      </div>
    </div>
  );
}
