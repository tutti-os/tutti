import { useEffect, type ReactNode } from "react";

export function StandaloneAgentWindowContentReady({
  children,
  onReady
}: {
  children: ReactNode;
  onReady: () => void;
}): ReactNode {
  useEffect(() => {
    onReady();
  }, [onReady]);
  return children;
}
