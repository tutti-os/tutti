import type {
  AgentGuiScheduledTask,
  AgentGuiScheduler
} from "../agentGuiScheduler";

export const CONVERSATION_RAIL_FOREGROUND_RETRY_DELAY_MIN_MS = 150;
export const CONVERSATION_RAIL_FOREGROUND_RETRY_JITTER_MS = 150;
export const CONVERSATION_RAIL_BACKGROUND_RETRY_DELAY_MIN_MS = 1_500;
export const CONVERSATION_RAIL_BACKGROUND_RETRY_JITTER_MS = 1_000;

export type ConversationRailRetryMode = "background" | "foreground";

export async function requestConversationRailWithRetry<T>(input: {
  onRetryScheduled?(retry: {
    delayMs: number;
    error: unknown;
    mode: ConversationRailRetryMode;
  }): void;
  request(): Promise<T>;
  retryKey: string;
  scheduler: AgentGuiScheduler;
  signal: AbortSignal;
}): Promise<T> {
  try {
    return await input.request();
  } catch (error) {
    if (input.signal.aborted) throw error;
    const mode = conversationRailRetryMode(error);
    if (!mode) throw error;
    const delayMs = conversationRailRetryDelayMs(mode, input.retryKey);
    input.onRetryScheduled?.({ delayMs, error, mode });
    await waitForConversationRailRetry({
      delayMs,
      scheduler: input.scheduler,
      signal: input.signal
    });
    return input.request();
  }
}

export function conversationRailRetryMode(
  error: unknown
): ConversationRailRetryMode | null {
  const chain = errorChain(error);
  if (chain.some(isAbortErrorRecord)) return null;

  const statusCode = firstFiniteNumber(chain, "statusCode", "status");
  const errorCode = firstString(chain, "code").toLowerCase();
  if (
    statusCode === 408 ||
    statusCode === 504 ||
    statusCode === 522 ||
    statusCode === 524 ||
    chain.some(isTimeoutErrorRecord)
  ) {
    return "background";
  }
  if (
    statusCode !== null &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 425 &&
    statusCode !== 429
  ) {
    return null;
  }
  if (isPermanentErrorCode(errorCode)) return null;
  if (
    statusCode === 425 ||
    statusCode === 429 ||
    (statusCode !== null && statusCode >= 500)
  ) {
    return "foreground";
  }
  if (chain.some((record) => record.retryable === false)) return null;
  if (chain.some((record) => record.retryable === true)) return "foreground";
  if (chain.some(isTransportErrorRecord)) return "foreground";
  return null;
}

export function isConversationRailAbortError(error: unknown): boolean {
  return errorChain(error).some(isAbortErrorRecord);
}

function conversationRailRetryDelayMs(
  mode: ConversationRailRetryMode,
  retryKey: string
): number {
  const hash = stableHash(retryKey);
  if (mode === "background") {
    return (
      CONVERSATION_RAIL_BACKGROUND_RETRY_DELAY_MIN_MS +
      (hash % (CONVERSATION_RAIL_BACKGROUND_RETRY_JITTER_MS + 1))
    );
  }
  return (
    CONVERSATION_RAIL_FOREGROUND_RETRY_DELAY_MIN_MS +
    (hash % (CONVERSATION_RAIL_FOREGROUND_RETRY_JITTER_MS + 1))
  );
}

function waitForConversationRailRetry(input: {
  delayMs: number;
  scheduler: AgentGuiScheduler;
  signal: AbortSignal;
}): Promise<void> {
  if (input.signal.aborted) return Promise.reject(abortReason(input.signal));
  return new Promise<void>((resolve, reject) => {
    let scheduledTask: AgentGuiScheduledTask | null = null;
    const removeAbortListener = (): void => {
      input.signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      scheduledTask?.cancel();
      scheduledTask = null;
      removeAbortListener();
      reject(abortReason(input.signal));
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    scheduledTask = input.scheduler.schedule(input.delayMs, () => {
      scheduledTask = null;
      removeAbortListener();
      resolve();
    });
    if (input.signal.aborted) onAbort();
  });
}

function errorChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let current = asRecord(error);
  for (let depth = 0; current && depth < 4; depth += 1) {
    chain.push(current);
    current = asRecord(current.cause);
  }
  return chain;
}

function isAbortErrorRecord(record: Record<string, unknown>): boolean {
  const name = stringValue(record.name);
  const code = stringValue(record.code).toUpperCase();
  return (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    code === "ERR_ABORTED" ||
    code === "ERR_CANCELED"
  );
}

function isTimeoutErrorRecord(record: Record<string, unknown>): boolean {
  const name = stringValue(record.name);
  const code = stringValue(record.code).toUpperCase();
  return (
    name === "TimeoutError" || code === "ETIMEDOUT" || code.includes("TIMEOUT")
  );
}

function isTransportErrorRecord(record: Record<string, unknown>): boolean {
  const name = stringValue(record.name);
  const code = stringValue(record.code).toUpperCase();
  return (
    name === "TypeError" ||
    [
      "ABORT_ERR_SOCKET",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETDOWN",
      "ENETUNREACH",
      "EPIPE",
      "ERR_NETWORK",
      "FETCH_ERROR",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET"
    ].includes(code)
  );
}

function firstFiniteNumber(
  records: readonly Record<string, unknown>[],
  ...keys: readonly string[]
): number | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return null;
}

function firstString(
  records: readonly Record<string, unknown>[],
  key: string
): string {
  for (const record of records) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function isPermanentErrorCode(code: string): boolean {
  return [
    "unauthorized",
    "unauthenticated",
    "forbidden",
    "permission_denied",
    "invalid_argument",
    "invalid_input",
    "bad_request",
    "not_found",
    "unsupported"
  ].some((token) => code.includes(token));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
