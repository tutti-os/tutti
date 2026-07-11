import type {
  TuttiExternalErrorCode,
  TuttiExternalOperation,
  TuttiExternalOperationError
} from "../contracts/index.ts";
import { tuttiExternalOperations } from "../contracts/index.ts";

const tuttiExternalOperationSet = new Set<string>(tuttiExternalOperations);

export interface CreateTuttiExternalOperationErrorInput {
  cause?: unknown;
  code: TuttiExternalErrorCode;
  hostCode?: string;
  message: string;
  operation: TuttiExternalOperation;
}

export function createTuttiExternalOperationError(
  input: CreateTuttiExternalOperationErrorInput
): TuttiExternalOperationError {
  const error = new Error(input.message) as TuttiExternalOperationError;
  error.name = "TuttiExternalOperationError";
  Object.defineProperties(error, {
    code: { enumerable: true, value: input.code },
    operation: { enumerable: true, value: input.operation },
    ...(input.hostCode
      ? { hostCode: { enumerable: true, value: input.hostCode } }
      : {}),
    ...(input.cause === undefined
      ? {}
      : { cause: { enumerable: false, value: input.cause } })
  });
  return error;
}

export function isTuttiExternalOperationError(
  value: unknown
): value is TuttiExternalOperationError {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.name === "TuttiExternalOperationError" &&
    isTuttiExternalErrorCode(value.code) &&
    typeof value.operation === "string" &&
    tuttiExternalOperationSet.has(value.operation) &&
    typeof value.message === "string" &&
    (value.hostCode === undefined || typeof value.hostCode === "string")
  );
}

function isTuttiExternalErrorCode(
  value: unknown
): value is TuttiExternalErrorCode {
  return (
    value === "unsupported_operation" ||
    value === "invalid_input" ||
    value === "user_activation_required" ||
    value === "unauthorized" ||
    value === "unavailable" ||
    value === "operation_failed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
