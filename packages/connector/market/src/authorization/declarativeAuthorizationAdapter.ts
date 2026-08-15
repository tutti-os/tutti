import {
  parseDeclarativeAuthorizationInteractionV1,
  resolveDeclarativeAuthorizationInitialViewV1,
  type AuthorizationValueV1,
  type DeclarativeAuthorizationInteractionV1
} from "@tutti-os/connector-authorization-protocol/v1";
import {
  AUTHORIZATION_EVENT_PROTOCOL_V2,
  AUTHORIZATION_VIEW_PROTOCOL_V2,
  validateAuthorizationEventForViewV2,
  type AuthorizationEventEnvelopeV2,
  type AuthorizationViewEnvelopeV2
} from "@tutti-os/connector-authorization-protocol/v2";

export interface LegacySecretInteractionLabels {
  description: string;
  fieldLabel: string;
  placeholder: string;
}

export type ResolvedAuthorizationInteraction =
  | {
      kind: "form";
      interaction: DeclarativeAuthorizationInteractionV1;
      view: AuthorizationViewEnvelopeV2;
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
  enableLegacySecretFallback: boolean;
  interaction: unknown;
  legacyLabels: LegacySecretInteractionLabels;
  locale: string;
}): ResolvedAuthorizationInteraction {
  const parsed = parseDeclarativeAuthorizationInteractionV1(input.interaction);
  const interaction = parsed.ok
    ? parsed.value
    : input.enableLegacySecretFallback &&
        input.interaction === undefined &&
        input.authorizationKind === "api_key"
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
      protocol: AUTHORIZATION_VIEW_PROTOCOL_V2,
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
): AuthorizationEventEnvelopeV2 {
  return {
    protocol: AUTHORIZATION_EVENT_PROTOCOL_V2,
    viewId,
    event: { type: "submit", values }
  };
}

export function resolveDeclarativeAuthorizationSubmission(
  resolved: Extract<ResolvedAuthorizationInteraction, { kind: "form" }>,
  event: unknown
): DeclarativeAuthorizationSubmissionResult {
  const validation = validateAuthorizationEventForViewV2(resolved.view, event, {
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
