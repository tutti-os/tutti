import * as v from "valibot";

import {
  authorizationEventEnvelopeV1Schema,
  authorizationProtocolLimitsV1,
  authorizationViewEnvelopeV1Schema,
  type AuthorizationEventEnvelopeV1,
  type AuthorizationFieldV1,
  type AuthorizationFormViewV1,
  type AuthorizationValueV1,
  type AuthorizationViewEnvelopeV1
} from "./schema.ts";

const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type TextField = Extract<AuthorizationFieldV1, { type: "text" }>;
type SecretField = Extract<AuthorizationFieldV1, { type: "secret" }>;
type NumberField = Extract<AuthorizationFieldV1, { type: "number" }>;
type SubmitEventEnvelope = AuthorizationEventEnvelopeV1 & {
  event: Extract<AuthorizationEventEnvelopeV1["event"], { type: "submit" }>;
};

export type AuthorizationEventForViewErrorCode =
  | "invalid_event"
  | "stale_view"
  | "invalid_event_for_view"
  | "invalid_field";

export interface AuthorizationEventForViewError {
  code: AuthorizationEventForViewErrorCode;
  fieldName?: string;
}

export type AuthorizationEventForViewResult =
  | { ok: true; value: AuthorizationEventEnvelopeV1 }
  | { ok: false; error: AuthorizationEventForViewError };

export interface AuthorizationEventValidationContext {
  isCurrentLocalFileHandle(handleId: string): boolean;
}

function invalidEventForView(
  code: AuthorizationEventForViewErrorCode,
  fieldName?: string
): AuthorizationEventForViewResult {
  return {
    ok: false,
    error: { code, ...(fieldName === undefined ? {} : { fieldName }) }
  };
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function isFiniteSafeNumber(value: number): boolean {
  return (
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  );
}

function isStepAligned(value: number, base: number, step: number): boolean {
  const quotient = (value - base) / step;
  const nearest = Math.round(quotient);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 16;
  return Math.abs(quotient - nearest) <= tolerance;
}

function isTextValueValid(field: TextField, value: string): boolean {
  const length = unicodeLength(value);
  if (
    length < (field.minLength ?? 0) ||
    length > (field.maxLength ?? authorizationProtocolLimitsV1.userText)
  ) {
    return false;
  }
  return field.format !== "email" || BASIC_EMAIL_PATTERN.test(value);
}

function isSecretValueValid(field: SecretField, value: string): boolean {
  const length = unicodeLength(value);
  return (
    length >= (field.minLength ?? 0) &&
    length <= (field.maxLength ?? authorizationProtocolLimitsV1.userText)
  );
}

function isNumberValueValid(field: NumberField, value: number): boolean {
  if (
    !isFiniteSafeNumber(value) ||
    (field.minimum !== undefined && value < field.minimum) ||
    (field.maximum !== undefined && value > field.maximum)
  ) {
    return false;
  }
  return (
    field.step === undefined ||
    isStepAligned(value, field.minimum ?? 0, field.step)
  );
}

function validateFormSubmission(
  viewEnvelope: AuthorizationViewEnvelopeV1 & {
    view: AuthorizationFormViewV1;
  },
  eventEnvelope: SubmitEventEnvelope,
  context: AuthorizationEventValidationContext
): AuthorizationEventForViewResult {
  const fieldsByName = new Map(
    viewEnvelope.view.fields.map((field) => [field.name, field])
  );

  for (const name of Object.keys(eventEnvelope.event.values)) {
    if (!fieldsByName.has(name)) {
      return invalidEventForView("invalid_field", name);
    }
  }

  const normalizedValues: Record<string, AuthorizationValueV1> = {};
  for (const field of viewEnvelope.view.fields) {
    const value = eventEnvelope.event.values[field.name];

    if (field.type === "boolean" && value === undefined) {
      return invalidEventForView("invalid_field", field.name);
    }
    if (value === undefined) {
      if (field.required) {
        return invalidEventForView("invalid_field", field.name);
      }
      continue;
    }

    switch (field.type) {
      case "text": {
        if (typeof value !== "string") {
          return invalidEventForView("invalid_field", field.name);
        }
        const normalized = value.trim();
        if (normalized === "" && !field.required) continue;
        if (
          (field.required && normalized === "") ||
          !isTextValueValid(field, normalized)
        ) {
          return invalidEventForView("invalid_field", field.name);
        }
        normalizedValues[field.name] = normalized;
        break;
      }
      case "secret":
        if (
          typeof value !== "string" ||
          (field.required && value === "") ||
          !isSecretValueValid(field, value)
        ) {
          return invalidEventForView("invalid_field", field.name);
        }
        normalizedValues[field.name] = value;
        break;
      case "number":
        if (typeof value !== "number" || !isNumberValueValid(field, value)) {
          return invalidEventForView("invalid_field", field.name);
        }
        normalizedValues[field.name] = value;
        break;
      case "select":
        if (
          typeof value !== "string" ||
          !field.options.some((option) => option.value === value)
        ) {
          return invalidEventForView("invalid_field", field.name);
        }
        normalizedValues[field.name] = value;
        break;
      case "boolean":
        if (
          typeof value !== "boolean" ||
          (field.required === true && value !== true)
        ) {
          return invalidEventForView("invalid_field", field.name);
        }
        normalizedValues[field.name] = value;
        break;
      case "local_file":
        if (
          typeof value !== "object" ||
          value === null ||
          !("type" in value) ||
          value.type !== "local_file" ||
          !("handleId" in value) ||
          typeof value.handleId !== "string" ||
          !context.isCurrentLocalFileHandle(value.handleId)
        ) {
          return invalidEventForView("invalid_field", field.name);
        }
        normalizedValues[field.name] = value;
        break;
    }
  }

  return {
    ok: true,
    value: {
      ...eventEnvelope,
      event: { type: "submit", values: normalizedValues }
    }
  };
}

export function validateAuthorizationEventForViewV1(
  currentViewInput: unknown,
  eventInput: unknown,
  context: AuthorizationEventValidationContext
): AuthorizationEventForViewResult {
  const currentViewResult = v.safeParse(
    authorizationViewEnvelopeV1Schema,
    currentViewInput
  );
  const eventResult = v.safeParse(
    authorizationEventEnvelopeV1Schema,
    eventInput
  );
  if (!currentViewResult.success || !eventResult.success) {
    return invalidEventForView("invalid_event");
  }

  const currentView = currentViewResult.output;
  const eventEnvelope = eventResult.output;
  if (currentView.viewId !== eventEnvelope.viewId) {
    return invalidEventForView("stale_view");
  }
  if (eventEnvelope.event.type === "cancel") {
    return { ok: true, value: eventEnvelope };
  }

  switch (currentView.view.type) {
    case "form":
      return eventEnvelope.event.type === "submit"
        ? validateFormSubmission(
            currentView as AuthorizationViewEnvelopeV1 & {
              view: AuthorizationFormViewV1;
            },
            eventEnvelope as SubmitEventEnvelope,
            context
          )
        : invalidEventForView("invalid_event_for_view");
    case "external_link":
    case "device_code":
      return eventEnvelope.event.type === "activate"
        ? { ok: true, value: eventEnvelope }
        : invalidEventForView("invalid_event_for_view");
    case "qr_code":
      return eventEnvelope.event.type === "refresh" &&
        currentView.view.refreshable === true
        ? { ok: true, value: eventEnvelope }
        : invalidEventForView("invalid_event_for_view");
    case "result":
      return eventEnvelope.event.type === "retry" &&
        currentView.view.outcome === "failure" &&
        currentView.view.retryable === true
        ? { ok: true, value: eventEnvelope }
        : invalidEventForView("invalid_event_for_view");
    case "progress":
      return invalidEventForView("invalid_event_for_view");
  }
}
