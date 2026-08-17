export type CaptureSelectionTransitionPhase =
  | "before_present"
  | "during_present"
  | "after_present"
  | "after_metadata";

export class CaptureSelectionSupersededError extends Error {
  readonly captureId: string;
  readonly phase: CaptureSelectionTransitionPhase;

  constructor(captureId: string, phase: CaptureSelectionTransitionPhase) {
    super(`Screenshot capture ${captureId} was superseded during ${phase}`);
    this.name = "CaptureSelectionSupersededError";
    this.captureId = captureId;
    this.phase = phase;
  }
}

export async function runCaptureSelectionTransition<T>({
  captureId,
  isCurrent,
  metadata,
  present
}: {
  captureId: string;
  isCurrent(): boolean;
  metadata: Promise<T>;
  present(assertCurrent: () => void): Promise<void>;
}): Promise<T> {
  const assertCurrent = (phase: CaptureSelectionTransitionPhase) => {
    if (!isCurrent()) {
      throw new CaptureSelectionSupersededError(captureId, phase);
    }
  };

  assertCurrent("before_present");
  await present(() => assertCurrent("during_present"));
  assertCurrent("after_present");
  const resolvedMetadata = await metadata;
  assertCurrent("after_metadata");
  return resolvedMetadata;
}
