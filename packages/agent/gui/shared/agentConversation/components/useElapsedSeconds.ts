import { useEffect, useState } from "react";

export function useElapsedSeconds(startUnixMs: number | null): number | null {
  const [nowUnixMs, setNowUnixMs] = useState(() => Date.now());
  useEffect(() => {
    if (startUnixMs === null) {
      return;
    }
    // timing: drive second-level elapsed UI only while the canonical active turn is visible.
    const timer = setInterval(() => setNowUnixMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startUnixMs]);
  if (startUnixMs === null) {
    return null;
  }
  return Math.max(0, Math.floor((nowUnixMs - startUnixMs) / 1_000));
}
