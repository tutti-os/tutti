import { pid, stderr } from "node:process";
import { errorMessage } from "./errors.ts";

export const CLAUDE_CODE_CANCEL_DIAGNOSTIC_PREFIX =
  "CLAUDE_CODE_CANCEL_DIAGNOSTIC";

type CancellationDiagnosticSink = (line: string) => void;

let cancellationDiagnosticSink: CancellationDiagnosticSink = (line) => {
  stderr.write(`${line}\n`);
};

export function logClaudeCodeCancellation(
  stage: string,
  payload: Record<string, unknown>
): void {
  cancellationDiagnosticSink(
    `${CLAUDE_CODE_CANCEL_DIAGNOSTIC_PREFIX} ${JSON.stringify({
      stage,
      sidecarPid: pid,
      ...payload
    })}`
  );
}

export function cancellationErrorPayload(error: unknown): {
  name: string;
  message: string;
} {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: errorMessage(error)
  };
}

export function withCancellationDiagnosticSinkForTest(
  sink: CancellationDiagnosticSink
): () => void {
  cancellationDiagnosticSink = sink;
  return () => {
    cancellationDiagnosticSink = (line) => {
      stderr.write(`${line}\n`);
    };
  };
}
