import {
  AUTHORIZATION_EVENT_PROTOCOL_V1,
  AUTHORIZATION_VIEW_PROTOCOL_V1,
  validateAuthorizationEventForViewV1,
  type AuthorizationEventForViewError,
  type AuthorizationEventValidationContext
} from "../v1/index.ts";
import {
  parseAuthorizationEventV2,
  parseAuthorizationViewV2,
  type AuthorizationEventEnvelopeV2
} from "./schema.ts";

export type AuthorizationEventForViewV2Result =
  | { ok: true; value: AuthorizationEventEnvelopeV2 }
  | { ok: false; error: AuthorizationEventForViewError };

export function validateAuthorizationEventForViewV2(
  currentViewInput: unknown,
  eventInput: unknown,
  context: AuthorizationEventValidationContext
): AuthorizationEventForViewV2Result {
  const currentViewResult = parseAuthorizationViewV2(currentViewInput);
  const eventResult = parseAuthorizationEventV2(eventInput);
  if (!currentViewResult.ok || !eventResult.ok) {
    return { ok: false, error: { code: "invalid_event" } };
  }

  const currentView = currentViewResult.value;
  const eventEnvelope = eventResult.value;
  if (currentView.viewId !== eventEnvelope.viewId) {
    return { ok: false, error: { code: "stale_view" } };
  }
  if (eventEnvelope.event.type === "cancel") {
    return { ok: true, value: eventEnvelope };
  }
  if (currentView.view.type === "embedded_page") {
    return eventEnvelope.event.type === "activate"
      ? { ok: true, value: eventEnvelope }
      : { ok: false, error: { code: "invalid_event_for_view" } };
  }

  const legacyResult = validateAuthorizationEventForViewV1(
    { ...currentView, protocol: AUTHORIZATION_VIEW_PROTOCOL_V1 },
    { ...eventEnvelope, protocol: AUTHORIZATION_EVENT_PROTOCOL_V1 },
    context
  );
  return legacyResult.ok ? { ok: true, value: eventEnvelope } : legacyResult;
}
