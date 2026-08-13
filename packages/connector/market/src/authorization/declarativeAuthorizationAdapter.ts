import {
  AUTHORIZATION_EVENT_PROTOCOL_V1,
  AUTHORIZATION_VIEW_PROTOCOL_V1,
  parseDeclarativeAuthorizationInteractionV1,
  resolveDeclarativeAuthorizationInitialViewV1,
  validateAuthorizationEventForViewV1,
  type AuthorizationEventEnvelopeV1,
  type AuthorizationValueV1,
  type AuthorizationViewEnvelopeV1,
  type DeclarativeAuthorizationInteractionV1
} from "@tutti-os/connector-authorization-protocol/v1";

export interface LegacySecretInteractionLabels {
  description: string;
  fieldLabel: string;
  placeholder: string;
}

export type ResolvedAuthorizationInteraction =
  | {
      kind: "form";
      interaction: DeclarativeAuthorizationInteractionV1;
      view: AuthorizationViewEnvelopeV1;
    }
  | { kind: "none" }
  | { kind: "invalid" };

export type DeclarativeAuthorizationSubmissionResult =
  | { ok: true; secret: string }
  | { ok: false; code: "invalid_event" | "invalid_secret" };

function createLegacySecretInteraction(
  labels: LegacySecretInteractionLabels
): DeclarativeAuthorizationInteractionV1 {
  return {
    protocol: "tutti.connector.authorization.declarative.v1",
    initialView: {
      defaultLocale: "en-US",
      locales: {
        "en-US": {
          type: "form",
          fields: [
            {
              type: "secret",
              name: "secret",
              label: labels.fieldLabel,
              description: labels.description,
              placeholder: labels.placeholder,
              required: true
            }
          ]
        }
      }
    },
    submission: {
      kind: "native_secret",
      secretField: "secret"
    }
  };
}

export function resolveAuthorizationInteraction(input: {
  authorizationKind: string;
  interaction: unknown;
  legacyLabels: LegacySecretInteractionLabels;
  locale: string;
}): ResolvedAuthorizationInteraction {
  const parsed = parseDeclarativeAuthorizationInteractionV1(input.interaction);
  const interaction = parsed.ok
    ? parsed.value
    : input.interaction === undefined && input.authorizationKind === "api_key"
      ? createLegacySecretInteraction(input.legacyLabels)
      : null;

  if (!interaction) {
    return input.interaction === undefined
      ? { kind: "none" }
      : { kind: "invalid" };
  }

  return {
    kind: "form",
    interaction,
    view: {
      protocol: AUTHORIZATION_VIEW_PROTOCOL_V1,
      viewId: "authorization-form",
      view: resolveDeclarativeAuthorizationInitialViewV1(
        interaction,
        input.locale
      )
    }
  };
}

export function createAuthorizationSubmitEvent(
  viewId: string,
  values: Record<string, AuthorizationValueV1>
): AuthorizationEventEnvelopeV1 {
  return {
    protocol: AUTHORIZATION_EVENT_PROTOCOL_V1,
    viewId,
    event: { type: "submit", values }
  };
}

export function resolveDeclarativeAuthorizationSubmission(
  resolved: Extract<ResolvedAuthorizationInteraction, { kind: "form" }>,
  event: unknown
): DeclarativeAuthorizationSubmissionResult {
  const validation = validateAuthorizationEventForViewV1(resolved.view, event, {
    isCurrentLocalFileHandle: () => false
  });
  if (!validation.ok || validation.value.event.type !== "submit") {
    return { ok: false, code: "invalid_event" };
  }
  const secret =
    validation.value.event.values[resolved.interaction.submission.secretField];
  return typeof secret === "string" && secret.length > 0
    ? { ok: true, secret }
    : { ok: false, code: "invalid_secret" };
}
