import type {
  TuttiExternalFileUploadInput,
  TuttiExternalUploadedFile
} from "../contracts/index.ts";
import { normalizeTuttiExternalFileUploadInput } from "../core/index.ts";
import { normalizeTuttiExternalUploadedFileResult } from "./results.ts";
import type { TuttiExternalHostAdapter } from "./types.ts";

export async function uploadTuttiExternalFile(
  adapter: TuttiExternalHostAdapter,
  file: Blob | File,
  input?: TuttiExternalFileUploadInput
): Promise<TuttiExternalUploadedFile> {
  assertUploadFile(file);
  const normalized = normalizeTuttiExternalFileUploadInput(input);
  throwIfAborted(normalized.signal);
  const onProgress = normalized.onProgress;
  const uploaded = await adapter.upload(file, {
    ...normalized,
    ...(onProgress
      ? {
          onProgress(progress) {
            try {
              onProgress(progress);
            } catch {
              // App progress listeners are observational.
            }
          }
        }
      : {})
  });
  throwIfAborted(normalized.signal);
  return normalizeTuttiExternalUploadedFileResult(uploaded);
}

function assertUploadFile(file: Blob | File): void {
  const size = (file as { size?: unknown } | undefined)?.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    throw new Error("files.upload file must be a Blob or File.");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}
