import type { ReactNode } from "react";

export interface ConnectorDialogSectionProps {
  children: ReactNode;
  title: string;
}

export function ConnectorDialogSection({
  children,
  title
}: ConnectorDialogSectionProps) {
  return (
    <section>
      <h3 className="mb-2 mt-0 text-[12px] font-semibold text-[var(--text-primary)]">
        {title}
      </h3>
      {children}
    </section>
  );
}
