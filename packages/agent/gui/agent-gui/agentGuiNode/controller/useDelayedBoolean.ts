import { useEffect, useState } from "react";

export function useDelayedBoolean(value: boolean, delayMs: number): boolean {
  const [delayedValue, setDelayedValue] = useState(false);
  useEffect(() => {
    if (!value) {
      setDelayedValue(false);
      return;
    }
    // timing: caller-provided debounce before reflecting the value as true
    const timer = window.setTimeout(() => setDelayedValue(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return delayedValue;
}
