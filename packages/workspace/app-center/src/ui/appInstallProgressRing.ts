import type { WorkspaceAppInstallProgress } from "../contracts/runtime.ts";

export interface AppInstallProgressRingPresentation {
  readonly ariaValueNow: number | undefined;
  readonly ariaValueText: string | undefined;
  readonly indicatorClassName: string;
  readonly indicatorStyle: { readonly background: string };
  readonly percent: number;
}

export function getAppInstallProgressRingPresentation(input: {
  readonly fallbackPercent: number;
  readonly indeterminateValueText?: string;
  readonly progress: WorkspaceAppInstallProgress | null | undefined;
}): AppInstallProgressRingPresentation {
  const percent = clampPercent(
    input.progress?.overallPercent ?? input.fallbackPercent
  );
  const indeterminate = input.progress?.indeterminate === true;
  return {
    ariaValueNow: indeterminate ? undefined : percent,
    ariaValueText: indeterminate ? input.indeterminateValueText : undefined,
    indicatorClassName: indeterminate
      ? "absolute inset-0 rounded-full animate-spin motion-reduce:animate-none"
      : "absolute inset-0 rounded-full",
    indicatorStyle: {
      background: indeterminate
        ? "conic-gradient(transparent 0 64%, var(--text-secondary) 64% 100%)"
        : `conic-gradient(var(--text-secondary) ${percent}%, color-mix(in srgb, var(--text-secondary) 24%, transparent) 0)`
    },
    percent
  };
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
