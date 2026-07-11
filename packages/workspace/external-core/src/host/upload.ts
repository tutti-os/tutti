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
  const normalized = normalizeTuttiExternalFileUploadRequest(file, input);
  return uploadNormalizedTuttiExternalFile(adapter, file, normalized);
}

export function normalizeTuttiExternalFileUploadRequest(
  file: unknown,
  input?: TuttiExternalFileUploadInput
): TuttiExternalFileUploadInput & { purpose: "app-asset" } {
  assertTuttiExternalUploadFile(file);
  const normalized = normalizeTuttiExternalFileUploadInput(input);
  throwIfAborted(normalized.signal);
  return normalized;
}

export async function uploadNormalizedTuttiExternalFile(
  adapter: TuttiExternalHostAdapter,
  file: Blob | File,
  input: TuttiExternalFileUploadInput & { purpose: "app-asset" }
): Promise<TuttiExternalUploadedFile> {
  throwIfAborted(input.signal);
  const onProgress = input.onProgress;
  const uploaded = await adapter.upload(file, {
    ...input,
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
  throwIfAborted(input.signal);
  return normalizeTuttiExternalUploadedFileResult(uploaded);
}

export function assertTuttiExternalUploadFile(
  file: unknown
): asserts file is Blob | File {
  if (typeof file !== "object" || file === null) {
    throw new Error("files.upload file must be a Blob or File.");
  }
  const blobPrototype = globalThis.Blob?.prototype;
  const sizeGetter = blobPrototype
    ? Object.getOwnPropertyDescriptor(blobPrototype, "size")?.get
    : undefined;
  if (!blobPrototype || !sizeGetter) {
    throw new Error("files.upload Blob support is unavailable.");
  }
  try {
    sizeGetter.call(file);
    blobPrototype.slice.call(file, 0, 0);
  } catch {
    throw new Error("files.upload file must be a Blob or File.");
  }
  const candidate = file as Record<string, unknown>;
  if (
    typeof candidate.size !== "number" ||
    !Number.isFinite(candidate.size) ||
    candidate.size < 0 ||
    typeof candidate.type !== "string" ||
    typeof candidate.arrayBuffer !== "function" ||
    typeof candidate.slice !== "function" ||
    typeof candidate.stream !== "function" ||
    typeof candidate.text !== "function"
  ) {
    throw new Error("files.upload file must be a Blob or File.");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}
