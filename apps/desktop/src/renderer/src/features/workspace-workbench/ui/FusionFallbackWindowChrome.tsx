import type { ReactNode } from "react";
import type { DesktopApi } from "@preload/types";

export function FusionFallbackWindowChrome({
  children
}: {
  children?: ReactNode;
  desktopApi: DesktopApi;
  title?: string;
}): ReactNode {
  return (
    <main className="h-screen min-h-0 overflow-hidden bg-background text-[var(--text-primary)]">
      <section className="h-full min-h-0 overflow-auto">{children}</section>
    </main>
  );
}
