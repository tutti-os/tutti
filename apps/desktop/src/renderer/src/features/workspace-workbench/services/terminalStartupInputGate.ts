import type { TerminalTransport } from "@tutti-os/workspace-terminal/contracts";

export type TerminalStartupInputResult =
  | "cancelled"
  | "submitted"
  | "timed_out"
  | "write_failed";

export interface TerminalStartupInputGate {
  arm(sessionId: string): Promise<TerminalStartupInputResult>;
  cancel(): void;
}

const defaultReadyTimeoutMs = 15_000;
const maxBufferedOutputChars = 4_096;
const maxBufferedSessions = 8;
const slashCommandNamePattern = /^[a-z0-9][a-z0-9._:-]{0,63}$/u;

export function createTerminalStartupInputGate(input: {
  commandName: string;
  readyText: string;
  timeoutMs?: number;
  transport: Pick<TerminalTransport, "onData" | "write">;
}): TerminalStartupInputGate {
  const commandName = input.commandName;
  const readyText = input.readyText;
  const bufferedOutputBySession = new Map<string, string>();
  let armedSessionId: string | null = null;
  let finished = false;
  let submitting = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe = noop;
  let resolveCompletion: (result: TerminalStartupInputResult) => void = noop;
  const completion = new Promise<TerminalStartupInputResult>((resolve) => {
    resolveCompletion = resolve;
  });

  const finish = (result: TerminalStartupInputResult) => {
    if (finished) return;
    finished = true;
    if (timeout) clearTimeout(timeout);
    timeout = null;
    unsubscribe();
    resolveCompletion(result);
  };

  const maybeSubmit = () => {
    if (finished || submitting || !armedSessionId) return;
    const output = bufferedOutputBySession.get(armedSessionId) ?? "";
    if (!output.includes(readyText)) return;
    submitting = true;
    void input.transport
      .write({
        data: terminalSubmitSlashCommand(commandName),
        encoding: "utf8",
        provenance: "auto",
        sessionId: armedSessionId
      })
      .then(
        () => finish("submitted"),
        () => finish("write_failed")
      );
  };

  unsubscribe = input.transport.onData((event) => {
    if (armedSessionId && event.sessionId !== armedSessionId) return;
    const current = bufferedOutputBySession.get(event.sessionId) ?? "";
    bufferedOutputBySession.set(
      event.sessionId,
      `${current}${event.data}`.slice(-maxBufferedOutputChars)
    );
    while (bufferedOutputBySession.size > maxBufferedSessions) {
      const oldestSessionId = bufferedOutputBySession.keys().next().value;
      if (typeof oldestSessionId !== "string") break;
      bufferedOutputBySession.delete(oldestSessionId);
    }
    maybeSubmit();
  });

  return {
    arm(sessionId) {
      if (armedSessionId || finished) return completion;
      armedSessionId = sessionId.trim();
      if (
        !armedSessionId ||
        !isValidReadyText(readyText) ||
        !slashCommandNamePattern.test(commandName)
      ) {
        finish("cancelled");
        return completion;
      }
      for (const bufferedSessionId of bufferedOutputBySession.keys()) {
        if (bufferedSessionId !== armedSessionId) {
          bufferedOutputBySession.delete(bufferedSessionId);
        }
      }
      timeout = setTimeout(
        () => finish("timed_out"),
        input.timeoutMs ?? defaultReadyTimeoutMs
      );
      maybeSubmit();
      return completion;
    },
    cancel() {
      finish("cancelled");
    }
  };
}

function terminalSubmitSlashCommand(commandName: string): string {
  return `/${commandName}\r`;
}

function isValidReadyText(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function noop(): void {}
