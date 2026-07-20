import { useEffect, type ReactNode } from "react";

export function StandaloneAgentWindowContentReady({
  children,
  isPending = false,
  pendingFallback = null,
  onReady
}: {
  children: ReactNode;
  isPending?: boolean;
  pendingFallback?: ReactNode;
  onReady: () => void;
}): ReactNode {
  useEffect(() => {
    if (isPending) {
      return;
    }
    onReady();
  }, [isPending, onReady]);
  return isPending ? pendingFallback : children;
}
