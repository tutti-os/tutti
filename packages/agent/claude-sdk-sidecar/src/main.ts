import * as readline from "node:readline/promises";
import { stdin } from "node:process";
import { pathToFileURL } from "node:url";
import { errorMessage } from "./errors.ts";
import {
  cancellationErrorPayload,
  logClaudeCodeCancellation
} from "./cancelDiagnostics.ts";
import { emit } from "./eventSink.ts";
import { numberValue, recordValue } from "./normalizer.ts";
import { sidecarClaudeOptionsFromPayload } from "./options.ts";
import {
  parseClaudeSDKSidecarRequest,
  type ClaudeSDKSidecarRequest
} from "./protocol.ts";
import { booleanValue, envObject, stringValue } from "./runtimeValues.ts";
import { sidecarSessionSettings } from "./sessionSettings.ts";
import { SessionRuntime } from "./sessionRuntime.ts";
import { probeClaudeAccountUsage } from "./accountUsageProbe.ts";
import {
  forkClaudeSession,
  inspectClaudeForkCheckpoints,
  recoverClaudeTurnBinding
} from "./sessionFork.ts";

const sessions = new Map<string, SessionRuntime>();

export async function handleRequest(
  request: ClaudeSDKSidecarRequest
): Promise<void> {
  const id = typeof request.id === "string" ? request.id : undefined;
  try {
    switch (request.type) {
      case "start": {
        const payload = request.payload ?? {};
        const agentSessionId = stringValue(payload.agentSessionId);
        const providerSessionId =
          stringValue(payload.providerSessionId) || crypto.randomUUID();
        const session = new SessionRuntime(
          providerSessionId,
          stringValue(payload.cwd),
          envObject(payload.env),
          booleanValue(payload.restore),
          process.env.TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER === "1",
          sidecarSessionSettings(payload),
          sidecarClaudeOptionsFromPayload(payload),
          recordValue(payload.resumeCursor) ?? undefined
        );
        sessions.set(agentSessionId, session);
        await session.start();
        emit({
          id,
          type: "ok",
          payload: { providerSessionId: session.providerSessionId }
        });
        return;
      }
      case "exec": {
        const payload = request.payload ?? {};
        const session = requireSession(stringValue(payload.agentSessionId));
        session.exec(
          stringValue(payload.turnId),
          // Prefer structured content; prompt is the legacy text fallback.
          stringValue(payload.prompt),
          payload.content,
          stringValue(payload.turnOrigin),
          stringValue(payload.goalOperationId) &&
            numberValue(payload.goalRevision) > 0 &&
            (stringValue(payload.goalAction) === "set" ||
              stringValue(payload.goalAction) === "clear")
            ? {
                operationId: stringValue(payload.goalOperationId),
                revision: numberValue(payload.goalRevision),
                repairEpoch: numberValue(payload.goalRepairEpoch),
                action: stringValue(payload.goalAction) as "set" | "clear"
              }
            : undefined,
          stringValue(payload.hostContext),
          stringValue(payload.promptCorrelationId)
        );
        emit({ id, type: "ok" });
        return;
      }
      case "inspect_fork_checkpoints": {
        const payload = request.payload ?? {};
        const result = await inspectClaudeForkCheckpoints({
          sessionId: stringValue(payload.providerSessionId),
          cwd: stringValue(payload.cwd)
        });
        emit({ id, type: "ok", payload: result });
        return;
      }
      case "recover_turn_binding": {
        const payload = request.payload ?? {};
        const result = await recoverClaudeTurnBinding({
          sessionId: stringValue(payload.providerSessionId),
          cwd: stringValue(payload.cwd),
          recoveryToken: stringValue(payload.recoveryToken),
          legacyTextHMACKey: stringValue(payload.legacyTextHmacKey),
          legacyTextHMACDigest: stringValue(payload.legacyTextHmacDigest)
        });
        emit({ id, type: "ok", payload: result });
        return;
      }
      case "fork_session": {
        const payload = request.payload ?? {};
        const result = await forkClaudeSession({
          sessionId: stringValue(payload.providerSessionId),
          providerTurnId: stringValue(payload.providerTurnId),
          providerCheckpointMessageId: stringValue(
            payload.providerCheckpointMessageId
          ),
          cwd: stringValue(payload.cwd),
          title: stringValue(payload.title)
        });
        emit({ id, type: "ok", payload: result });
        return;
      }
      case "probe_usage": {
        const payload = request.payload ?? {};
        const result = await probeClaudeAccountUsage({
          cwd: stringValue(payload.cwd),
          env: envObject(payload.env)
        });
        emit({ id, type: "ok", payload: result });
        return;
      }
      case "guide": {
        const payload = request.payload ?? {};
        const session = requireSession(stringValue(payload.agentSessionId));
        await session.guide(
          // Prefer structured content; prompt is the legacy text fallback.
          stringValue(payload.prompt),
          payload.content
        );
        emit({ id, type: "ok" });
        return;
      }
      case "cancel": {
        const payload = request.payload ?? {};
        const agentSessionId = stringValue(payload.agentSessionId);
        const turnId = stringValue(payload.turnId);
        const interruptTimeoutMs = requiredPositiveInteger(
          payload.interruptTimeoutMs,
          "cancel interruptTimeoutMs"
        );
        const drainTimeoutMs = requiredPositiveInteger(
          payload.drainTimeoutMs,
          "cancel drainTimeoutMs"
        );
        const session = requireSession(agentSessionId);
        const diagnosticContext = {
          requestId: id ?? "",
          agentSessionId,
          providerSessionId: session.providerSessionId,
          turnId
        };
        const startedAt = Date.now();
        logClaudeCodeCancellation("cancel_received", {
          ...diagnosticContext,
          interruptTimeoutMs,
          drainTimeoutMs
        });
        try {
          const result = await session.cancel(turnId, {
            interruptTimeoutMs,
            drainTimeoutMs,
            observe: (stage, stagePayload) =>
              logClaudeCodeCancellation(stage, {
                ...diagnosticContext,
                ...stagePayload
              })
          });
          logClaudeCodeCancellation("cancel_responded", {
            ...diagnosticContext,
            durationMs: Date.now() - startedAt,
            canceled: result.canceled,
            disposition: result.disposition,
            dispatchPhase: result.dispatchPhase,
            providerTurnId: result.providerTurnId
          });
          emit({ id, type: "ok", payload: result });
        } catch (error) {
          logClaudeCodeCancellation("cancel_failed", {
            ...diagnosticContext,
            durationMs: Date.now() - startedAt,
            error: cancellationErrorPayload(error)
          });
          throw error;
        }
        return;
      }
      case "stop_task": {
        const payload = request.payload ?? {};
        const session = requireSession(stringValue(payload.agentSessionId));
        const stopped = await session.stopTask(
          stringValue(payload.taskId),
          stringValue(payload.toolCallId) ||
            stringValue(payload.parentToolUseId)
        );
        emit({ id, type: "ok", payload: { stopped } });
        return;
      }
      case "submit_interactive": {
        const payload = request.payload ?? {};
        const session = requireSession(stringValue(payload.agentSessionId));
        const result = session.submitInteractive(
          stringValue(payload.turnId),
          stringValue(payload.requestId),
          stringValue(payload.action),
          stringValue(payload.optionId),
          recordValue(payload.payload) ?? {}
        );
        emit({ id, type: "ok", payload: result });
        return;
      }
      case "interactive_disposition": {
        const payload = request.payload ?? {};
        const session = requireSession(stringValue(payload.agentSessionId));
        const result = session.interactiveDisposition(
          stringValue(payload.turnId),
          stringValue(payload.requestId),
          stringValue(payload.action),
          stringValue(payload.optionId),
          recordValue(payload.payload) ?? {}
        );
        emit({ id, type: "ok", payload: result });
        return;
      }
      case "apply_settings": {
        const payload = request.payload ?? {};
        const session = requireSession(stringValue(payload.agentSessionId));
        await session.applySettings(payload);
        emit({ id, type: "ok" });
        return;
      }
      case "close": {
        const payload = request.payload ?? {};
        const agentSessionId = stringValue(payload.agentSessionId);
        const session = sessions.get(agentSessionId);
        await session?.close();
        sessions.delete(agentSessionId);
        emit({ id, type: "ok" });
        return;
      }
      default:
        throw new Error(`unsupported request type ${request.type ?? ""}`);
    }
  } catch (error) {
    emit({
      id,
      type: "error",
      payload: {
        error: errorMessage(error),
        ...(error &&
        typeof error === "object" &&
        "deliveryDisposition" in error &&
        typeof error.deliveryDisposition === "string"
          ? { deliveryDisposition: error.deliveryDisposition }
          : {}),
        ...(error &&
        typeof error === "object" &&
        "stage" in error &&
        typeof error.stage === "string"
          ? { stage: error.stage }
          : {})
      }
    });
  }
}

export function withSidecarSessionForTest(
  agentSessionId: string,
  session: SessionRuntime
): () => void {
  const previous = sessions.get(agentSessionId);
  sessions.set(agentSessionId, session);
  return () => {
    if (previous) {
      sessions.set(agentSessionId, previous);
    } else {
      sessions.delete(agentSessionId);
    }
  };
}

function requireSession(agentSessionId: string): SessionRuntime {
  const session = sessions.get(agentSessionId);
  if (!session) {
    throw new Error(`session ${agentSessionId} is not started`);
  }
  return session;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

async function runMain(): Promise<void> {
  const lines = readline.createInterface({ input: stdin });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      await handleRequest(parseClaudeSDKSidecarRequest(JSON.parse(line)));
    } catch (error) {
      emit({
        type: "error",
        payload: {
          error: errorMessage(error)
        }
      });
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runMain();
}
