import * as v from "valibot";

import {
  authorizationCancelEventV1Schema,
  authorizationDeviceCodeViewV1Schema,
  authorizationExternalLinkViewV1Schema,
  authorizationFormViewV1Schema,
  authorizationProgressViewV1Schema,
  authorizationProtocolLimitsV1,
  authorizationQrCodeViewV1Schema,
  authorizationRefreshEventV1Schema,
  authorizationResultViewV1Schema,
  authorizationRetryEventV1Schema,
  authorizationSubmitEventV1Schema,
  authorizationActivateEventV1Schema,
  authorizationViewIdV1Schema
} from "../v1/schema.ts";

export const AUTHORIZATION_VIEW_PROTOCOL_V2 =
  "tutti.connector.authorization.view.v2" as const;
export const AUTHORIZATION_EVENT_PROTOCOL_V2 =
  "tutti.connector.authorization.event.v2" as const;

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

const httpsUrlSchema = v.pipe(
  v.string(),
  v.maxLength(authorizationProtocolLimitsV1.url, "authorization.url_too_long"),
  v.check(isHttpsUrl, "authorization.invalid_https_url")
);

const optionalTimestampSchema = v.optional(
  v.pipe(
    v.string(),
    v.maxLength(64, "authorization.timestamp_too_long"),
    v.check(
      (value) => Number.isFinite(Date.parse(value)),
      "authorization.invalid_timestamp"
    )
  )
);

export const authorizationEmbeddedPageViewV2Schema = v.strictObject({
  type: v.literal("embedded_page"),
  flowId: authorizationViewIdV1Schema,
  title: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(authorizationProtocolLimitsV1.title)
    )
  ),
  description: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(authorizationProtocolLimitsV1.description)
    )
  ),
  url: httpsUrlSchema,
  expiresAt: optionalTimestampSchema
});

export const authorizationViewV2Schema = v.variant("type", [
  authorizationFormViewV1Schema,
  authorizationExternalLinkViewV1Schema,
  authorizationDeviceCodeViewV1Schema,
  authorizationQrCodeViewV1Schema,
  authorizationEmbeddedPageViewV2Schema,
  authorizationProgressViewV1Schema,
  authorizationResultViewV1Schema
]);

export const authorizationViewEnvelopeV2Schema = v.strictObject({
  protocol: v.literal(AUTHORIZATION_VIEW_PROTOCOL_V2),
  viewId: authorizationViewIdV1Schema,
  view: authorizationViewV2Schema
});

export const authorizationEventV2Schema = v.variant("type", [
  authorizationSubmitEventV1Schema,
  authorizationActivateEventV1Schema,
  authorizationRefreshEventV1Schema,
  authorizationRetryEventV1Schema,
  authorizationCancelEventV1Schema
]);

export const authorizationEventEnvelopeV2Schema = v.strictObject({
  protocol: v.literal(AUTHORIZATION_EVENT_PROTOCOL_V2),
  viewId: authorizationViewIdV1Schema,
  event: authorizationEventV2Schema
});

export type AuthorizationEmbeddedPageViewV2 = v.InferOutput<
  typeof authorizationEmbeddedPageViewV2Schema
>;
export type AuthorizationViewV2 = v.InferOutput<
  typeof authorizationViewV2Schema
>;
export type AuthorizationViewEnvelopeV2 = v.InferOutput<
  typeof authorizationViewEnvelopeV2Schema
>;
export type AuthorizationEventV2 = v.InferOutput<
  typeof authorizationEventV2Schema
>;
export type AuthorizationEventEnvelopeV2 = v.InferOutput<
  typeof authorizationEventEnvelopeV2Schema
>;

export type AuthorizationProtocolV2ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: "invalid_event" | "invalid_view" } };

export function parseAuthorizationViewV2(
  input: unknown
): AuthorizationProtocolV2ParseResult<AuthorizationViewEnvelopeV2> {
  const result = v.safeParse(authorizationViewEnvelopeV2Schema, input);
  return result.success
    ? { ok: true, value: result.output }
    : { ok: false, error: { code: "invalid_view" } };
}

export function parseAuthorizationEventV2(
  input: unknown
): AuthorizationProtocolV2ParseResult<AuthorizationEventEnvelopeV2> {
  const result = v.safeParse(authorizationEventEnvelopeV2Schema, input);
  return result.success
    ? { ok: true, value: result.output }
    : { ok: false, error: { code: "invalid_event" } };
}
