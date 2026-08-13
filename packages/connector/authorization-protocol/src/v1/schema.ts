import * as v from "valibot";

export const AUTHORIZATION_VIEW_PROTOCOL_V1 =
  "tutti.connector.authorization.view.v1" as const;
export const AUTHORIZATION_EVENT_PROTOCOL_V1 =
  "tutti.connector.authorization.event.v1" as const;
export const AUTHORIZATION_DECLARATIVE_PROTOCOL_V1 =
  "tutti.connector.authorization.declarative.v1" as const;

export const authorizationProtocolLimitsV1 = {
  viewId: 128,
  fieldName: 64,
  title: 128,
  label: 128,
  description: 1_024,
  message: 1_024,
  placeholder: 128,
  unit: 128,
  actionLabel: 128,
  url: 2_048,
  helpLinksPerView: 8,
  helpLinksPerField: 4,
  fieldsPerForm: 16,
  selectOptionsPerField: 100,
  userText: 8_192,
  qrPayloadBytes: 4_096,
  qrPngBytes: 512 * 1_024,
  qrPngDimension: 2_048,
  localFileExtensions: 20
} as const;

const VIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const HANDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EXTENSION_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._+-]{0,15}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const BASIC_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function isBoundedUnicodeString(
  value: string,
  minimum: number,
  maximum: number
): boolean {
  const length = unicodeLength(value);
  return length >= minimum && length <= maximum;
}

function isFiniteSafeNumber(value: number): boolean {
  return (
    Number.isFinite(value) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  );
}

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

function isRfc3339Timestamp(value: string): boolean {
  return RFC3339_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isStepAligned(value: number, base: number, step: number): boolean {
  const quotient = (value - base) / step;
  const nearest = Math.round(quotient);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 16;
  return Math.abs(quotient - nearest) <= tolerance;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const decoded = globalThis.atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function isBoundedPng(value: string): boolean {
  const bytes = decodeBase64(value);
  if (
    bytes === null ||
    bytes.byteLength < 24 ||
    bytes.byteLength > authorizationProtocolLimitsV1.qrPngBytes
  ) {
    return false;
  }

  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) {
    return false;
  }
  if (
    bytes[12] !== 73 ||
    bytes[13] !== 72 ||
    bytes[14] !== 68 ||
    bytes[15] !== 82
  ) {
    return false;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return (
    width > 0 &&
    height > 0 &&
    width <= authorizationProtocolLimitsV1.qrPngDimension &&
    height <= authorizationProtocolLimitsV1.qrPngDimension
  );
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const boundedString = (minimum: number, maximum: number) =>
  v.pipe(
    v.string(),
    v.check(
      (value) => isBoundedUnicodeString(value, minimum, maximum),
      "authorization.string_length"
    )
  );

const nonEmptyTitleSchema = boundedString(
  1,
  authorizationProtocolLimitsV1.title
);
const nonEmptyLabelSchema = boundedString(
  1,
  authorizationProtocolLimitsV1.label
);
const descriptionSchema = boundedString(
  1,
  authorizationProtocolLimitsV1.description
);
const messageSchema = boundedString(1, authorizationProtocolLimitsV1.message);
const placeholderSchema = boundedString(
  1,
  authorizationProtocolLimitsV1.placeholder
);
const unitSchema = boundedString(1, authorizationProtocolLimitsV1.unit);
const actionLabelSchema = boundedString(
  1,
  authorizationProtocolLimitsV1.actionLabel
);
const httpsUrlSchema = v.pipe(
  v.string(),
  v.maxLength(authorizationProtocolLimitsV1.url, "authorization.url_too_long"),
  v.check(isHttpsUrl, "authorization.invalid_https_url")
);
const userTextSchema = boundedString(0, authorizationProtocolLimitsV1.userText);

export const authorizationViewIdV1Schema = v.pipe(
  v.string(),
  v.regex(VIEW_ID_PATTERN, "authorization.invalid_view_id")
);

export const authorizationFieldNameV1Schema = v.pipe(
  v.string(),
  v.regex(FIELD_NAME_PATTERN, "authorization.invalid_field_name")
);

export const authorizationHelpLinkV1Schema = v.strictObject({
  label: nonEmptyLabelSchema,
  url: httpsUrlSchema
});

const viewHelpLinksSchema = v.pipe(
  v.array(authorizationHelpLinkV1Schema),
  v.minLength(1, "authorization.empty_help_links"),
  v.maxLength(
    authorizationProtocolLimitsV1.helpLinksPerView,
    "authorization.too_many_help_links"
  )
);

const fieldHelpLinksSchema = v.pipe(
  v.array(authorizationHelpLinkV1Schema),
  v.minLength(1, "authorization.empty_help_links"),
  v.maxLength(
    authorizationProtocolLimitsV1.helpLinksPerField,
    "authorization.too_many_help_links"
  )
);

const optionalTimestampSchema = v.optional(
  v.pipe(
    v.string(),
    v.maxLength(64, "authorization.timestamp_too_long"),
    v.check(isRfc3339Timestamp, "authorization.invalid_timestamp")
  )
);

const viewBaseEntries = {
  title: v.optional(nonEmptyTitleSchema),
  description: v.optional(descriptionSchema)
};

const fieldBaseEntries = {
  name: authorizationFieldNameV1Schema,
  label: nonEmptyLabelSchema,
  description: v.optional(descriptionSchema),
  helpLinks: v.optional(fieldHelpLinksSchema),
  required: v.optional(v.boolean())
};

const lengthConstraintSchema = v.pipe(
  v.number(),
  v.integer("authorization.length_not_integer"),
  v.minValue(0, "authorization.length_below_zero"),
  v.maxValue(
    authorizationProtocolLimitsV1.userText,
    "authorization.length_too_large"
  )
);

export const textAuthorizationFieldV1Schema = v.pipe(
  v.strictObject({
    type: v.literal("text"),
    ...fieldBaseEntries,
    format: v.optional(v.picklist(["plain", "email"])),
    placeholder: v.optional(placeholderSchema),
    defaultValue: v.optional(userTextSchema),
    minLength: v.optional(lengthConstraintSchema),
    maxLength: v.optional(lengthConstraintSchema)
  }),
  v.check((field) => {
    const minimum = field.minLength ?? 0;
    const maximum = field.maxLength ?? authorizationProtocolLimitsV1.userText;
    if (minimum > maximum) {
      return false;
    }
    if (field.defaultValue === undefined) {
      return true;
    }
    const valueLength = unicodeLength(field.defaultValue);
    return (
      valueLength >= minimum &&
      valueLength <= maximum &&
      (field.format !== "email" ||
        field.defaultValue === "" ||
        BASIC_EMAIL_PATTERN.test(field.defaultValue.trim()))
    );
  }, "authorization.invalid_text_field_constraints")
);

export const secretAuthorizationFieldV1Schema = v.pipe(
  v.strictObject({
    type: v.literal("secret"),
    ...fieldBaseEntries,
    placeholder: v.optional(placeholderSchema),
    minLength: v.optional(lengthConstraintSchema),
    maxLength: v.optional(lengthConstraintSchema)
  }),
  v.check(
    (field) =>
      (field.minLength ?? 0) <=
      (field.maxLength ?? authorizationProtocolLimitsV1.userText),
    "authorization.invalid_secret_field_constraints"
  )
);

const finiteSafeNumberSchema = v.pipe(
  v.number(),
  v.check(isFiniteSafeNumber, "authorization.invalid_number")
);

export const numberAuthorizationFieldV1Schema = v.pipe(
  v.strictObject({
    type: v.literal("number"),
    ...fieldBaseEntries,
    placeholder: v.optional(placeholderSchema),
    defaultValue: v.optional(finiteSafeNumberSchema),
    minimum: v.optional(finiteSafeNumberSchema),
    maximum: v.optional(finiteSafeNumberSchema),
    step: v.optional(
      v.pipe(
        finiteSafeNumberSchema,
        v.minValue(Number.MIN_VALUE, "authorization.invalid_number_step")
      )
    ),
    unit: v.optional(unitSchema)
  }),
  v.check((field) => {
    if (
      field.minimum !== undefined &&
      field.maximum !== undefined &&
      field.minimum > field.maximum
    ) {
      return false;
    }
    if (field.defaultValue === undefined) {
      return true;
    }
    if (
      (field.minimum !== undefined && field.defaultValue < field.minimum) ||
      (field.maximum !== undefined && field.defaultValue > field.maximum)
    ) {
      return false;
    }
    return (
      field.step === undefined ||
      isStepAligned(field.defaultValue, field.minimum ?? 0, field.step)
    );
  }, "authorization.invalid_number_field_constraints")
);

export const selectAuthorizationOptionV1Schema = v.strictObject({
  value: boundedString(1, 256),
  label: nonEmptyLabelSchema,
  description: v.optional(descriptionSchema)
});

export const selectAuthorizationFieldV1Schema = v.pipe(
  v.strictObject({
    type: v.literal("select"),
    ...fieldBaseEntries,
    defaultValue: v.optional(boundedString(1, 256)),
    options: v.pipe(
      v.array(selectAuthorizationOptionV1Schema),
      v.minLength(1, "authorization.empty_select_options"),
      v.maxLength(
        authorizationProtocolLimitsV1.selectOptionsPerField,
        "authorization.too_many_select_options"
      )
    )
  }),
  v.check((field) => {
    const optionValues = field.options.map((option) => option.value);
    return (
      hasUniqueStrings(optionValues) &&
      (field.defaultValue === undefined ||
        optionValues.includes(field.defaultValue))
    );
  }, "authorization.invalid_select_field_constraints")
);

export const booleanAuthorizationFieldV1Schema = v.strictObject({
  type: v.literal("boolean"),
  ...fieldBaseEntries,
  defaultValue: v.optional(v.boolean())
});

const localFileExtensionSchema = v.pipe(
  v.string(),
  v.regex(EXTENSION_PATTERN, "authorization.invalid_file_extension")
);

export const localFileAuthorizationFieldV1Schema = v.strictObject({
  type: v.literal("local_file"),
  ...fieldBaseEntries,
  extensions: v.optional(
    v.pipe(
      v.array(localFileExtensionSchema),
      v.minLength(1, "authorization.empty_file_extensions"),
      v.maxLength(
        authorizationProtocolLimitsV1.localFileExtensions,
        "authorization.too_many_file_extensions"
      ),
      v.check(
        (extensions) => hasUniqueStrings(extensions),
        "authorization.duplicate_file_extensions"
      )
    )
  )
});

export const authorizationFieldV1Schema = v.variant("type", [
  textAuthorizationFieldV1Schema,
  secretAuthorizationFieldV1Schema,
  numberAuthorizationFieldV1Schema,
  selectAuthorizationFieldV1Schema,
  booleanAuthorizationFieldV1Schema,
  localFileAuthorizationFieldV1Schema
]);

const fieldErrorsSchema = v.pipe(
  v.record(authorizationFieldNameV1Schema, messageSchema),
  v.check(
    (errors) =>
      Object.keys(errors).length <= authorizationProtocolLimitsV1.fieldsPerForm,
    "authorization.too_many_field_errors"
  )
);

export const authorizationFormViewV1Schema = v.pipe(
  v.strictObject({
    type: v.literal("form"),
    ...viewBaseEntries,
    helpLinks: v.optional(viewHelpLinksSchema),
    fields: v.pipe(
      v.array(authorizationFieldV1Schema),
      v.minLength(1, "authorization.empty_form"),
      v.maxLength(
        authorizationProtocolLimitsV1.fieldsPerForm,
        "authorization.too_many_fields"
      )
    ),
    fieldErrors: v.optional(fieldErrorsSchema),
    submitLabel: v.optional(actionLabelSchema)
  }),
  v.check((view) => {
    const fieldNames = view.fields.map((field) => field.name);
    return (
      hasUniqueStrings(fieldNames) &&
      (view.fieldErrors === undefined ||
        Object.keys(view.fieldErrors).every((name) =>
          fieldNames.includes(name)
        ))
    );
  }, "authorization.invalid_form_constraints")
);

export const authorizationExternalLinkViewV1Schema = v.strictObject({
  type: v.literal("external_link"),
  ...viewBaseEntries,
  url: httpsUrlSchema,
  actionLabel: v.optional(actionLabelSchema),
  expiresAt: optionalTimestampSchema
});

export const authorizationDeviceCodeViewV1Schema = v.strictObject({
  type: v.literal("device_code"),
  ...viewBaseEntries,
  verificationUrl: httpsUrlSchema,
  userCode: boundedString(1, 128),
  actionLabel: v.optional(actionLabelSchema),
  expiresAt: optionalTimestampSchema
});

export const authorizationQrCodeSourceV1Schema = v.variant("type", [
  v.strictObject({
    type: v.literal("payload"),
    value: v.pipe(
      v.string(),
      v.check((value) => {
        const length = new TextEncoder().encode(value).byteLength;
        return (
          length > 0 && length <= authorizationProtocolLimitsV1.qrPayloadBytes
        );
      }, "authorization.invalid_qr_payload")
    )
  }),
  v.strictObject({
    type: v.literal("png_base64"),
    value: v.pipe(
      v.string(),
      v.maxLength(
        Math.ceil(authorizationProtocolLimitsV1.qrPngBytes / 3) * 4,
        "authorization.qr_png_base64_too_long"
      ),
      v.base64("authorization.invalid_base64"),
      v.check(isBoundedPng, "authorization.invalid_qr_png")
    )
  })
]);

export const authorizationQrCodeViewV1Schema = v.strictObject({
  type: v.literal("qr_code"),
  ...viewBaseEntries,
  source: authorizationQrCodeSourceV1Schema,
  fallbackText: v.optional(userTextSchema),
  expiresAt: optionalTimestampSchema,
  refreshable: v.optional(v.boolean())
});

export const authorizationProgressViewV1Schema = v.strictObject({
  type: v.literal("progress"),
  ...viewBaseEntries,
  message: v.optional(messageSchema)
});

export const authorizationResultViewV1Schema = v.pipe(
  v.strictObject({
    type: v.literal("result"),
    ...viewBaseEntries,
    outcome: v.picklist(["success", "failure"]),
    message: v.optional(messageSchema),
    retryable: v.optional(v.boolean())
  }),
  v.check(
    (view) => view.outcome === "failure" || view.retryable === undefined,
    "authorization.success_cannot_retry"
  )
);

export const authorizationViewV1Schema = v.variant("type", [
  authorizationFormViewV1Schema,
  authorizationExternalLinkViewV1Schema,
  authorizationDeviceCodeViewV1Schema,
  authorizationQrCodeViewV1Schema,
  authorizationProgressViewV1Schema,
  authorizationResultViewV1Schema
]);

export const authorizationViewEnvelopeV1Schema = v.strictObject({
  protocol: v.literal(AUTHORIZATION_VIEW_PROTOCOL_V1),
  viewId: authorizationViewIdV1Schema,
  view: authorizationViewV1Schema
});

export const nativeSecretAuthorizationSubmissionV1Schema = v.strictObject({
  kind: v.literal("native_secret"),
  secretField: authorizationFieldNameV1Schema
});

const authorizationLocaleV1Schema = v.pipe(
  v.string(),
  v.regex(LOCALE_PATTERN, "authorization.invalid_locale")
);

const authorizationLocalizedViewsV1Schema = v.pipe(
  v.record(authorizationLocaleV1Schema, authorizationViewV1Schema),
  v.check(
    (views) => Object.keys(views).length > 0 && Object.keys(views).length <= 8,
    "authorization.invalid_localized_views"
  )
);

export const authorizationLocalizedViewV1Schema = v.pipe(
  v.strictObject({
    defaultLocale: authorizationLocaleV1Schema,
    locales: authorizationLocalizedViewsV1Schema
  }),
  v.check(
    (localizedView) =>
      Object.hasOwn(localizedView.locales, localizedView.defaultLocale),
    "authorization.missing_default_locale"
  )
);

function isNativeSecretForm(
  view: AuthorizationViewV1,
  secretField: string
): boolean {
  if (view.type !== "form") return false;
  const secretFields = view.fields.filter((field) => field.type === "secret");
  return (
    view.fields.length === 1 &&
    secretFields.length === 1 &&
    secretFields[0]?.name === secretField
  );
}

export const declarativeAuthorizationInteractionV1Schema = v.pipe(
  v.strictObject({
    protocol: v.literal(AUTHORIZATION_DECLARATIVE_PROTOCOL_V1),
    initialView: authorizationLocalizedViewV1Schema,
    submission: nativeSecretAuthorizationSubmissionV1Schema
  }),
  v.check((interaction) => {
    const views = Object.values(interaction.initialView.locales);
    return views.every((view) =>
      isNativeSecretForm(view, interaction.submission.secretField)
    );
  }, "authorization.invalid_native_secret_interaction")
);

export const authorizationLocalFileValueV1Schema = v.strictObject({
  type: v.literal("local_file"),
  handleId: v.pipe(
    v.string(),
    v.regex(HANDLE_ID_PATTERN, "authorization.invalid_file_handle")
  )
});

export const authorizationValueV1Schema = v.union([
  userTextSchema,
  finiteSafeNumberSchema,
  v.boolean(),
  authorizationLocalFileValueV1Schema
]);

const submitValuesSchema = v.pipe(
  v.record(authorizationFieldNameV1Schema, authorizationValueV1Schema),
  v.check(
    (values) =>
      Object.keys(values).length <= authorizationProtocolLimitsV1.fieldsPerForm,
    "authorization.too_many_submit_values"
  )
);

export const authorizationSubmitEventV1Schema = v.strictObject({
  type: v.literal("submit"),
  values: submitValuesSchema
});

export const authorizationActivateEventV1Schema = v.strictObject({
  type: v.literal("activate")
});

export const authorizationRefreshEventV1Schema = v.strictObject({
  type: v.literal("refresh")
});

export const authorizationRetryEventV1Schema = v.strictObject({
  type: v.literal("retry")
});

export const authorizationCancelEventV1Schema = v.strictObject({
  type: v.literal("cancel")
});

export const authorizationEventV1Schema = v.variant("type", [
  authorizationSubmitEventV1Schema,
  authorizationActivateEventV1Schema,
  authorizationRefreshEventV1Schema,
  authorizationRetryEventV1Schema,
  authorizationCancelEventV1Schema
]);

export const authorizationEventEnvelopeV1Schema = v.strictObject({
  protocol: v.literal(AUTHORIZATION_EVENT_PROTOCOL_V1),
  viewId: authorizationViewIdV1Schema,
  event: authorizationEventV1Schema
});

export type AuthorizationHelpLinkV1 = v.InferOutput<
  typeof authorizationHelpLinkV1Schema
>;
export type AuthorizationFieldV1 = v.InferOutput<
  typeof authorizationFieldV1Schema
>;
export type AuthorizationFormViewV1 = v.InferOutput<
  typeof authorizationFormViewV1Schema
>;
export type AuthorizationViewV1 = v.InferOutput<
  typeof authorizationViewV1Schema
>;
export type AuthorizationViewEnvelopeV1 = v.InferOutput<
  typeof authorizationViewEnvelopeV1Schema
>;
export type DeclarativeAuthorizationInteractionV1 = v.InferOutput<
  typeof declarativeAuthorizationInteractionV1Schema
>;
export type AuthorizationLocalFileValueV1 = v.InferOutput<
  typeof authorizationLocalFileValueV1Schema
>;
export type AuthorizationValueV1 = v.InferOutput<
  typeof authorizationValueV1Schema
>;
export type AuthorizationEventV1 = v.InferOutput<
  typeof authorizationEventV1Schema
>;
export type AuthorizationEventEnvelopeV1 = v.InferOutput<
  typeof authorizationEventEnvelopeV1Schema
>;

export type AuthorizationProtocolParseErrorCode =
  | "invalid_declarative_interaction"
  | "invalid_event"
  | "invalid_view";

export interface AuthorizationProtocolParseError {
  code: AuthorizationProtocolParseErrorCode;
}

export type AuthorizationProtocolParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AuthorizationProtocolParseError };

function parseProtocolValue<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
>(
  schema: TSchema,
  input: unknown,
  code: AuthorizationProtocolParseErrorCode
): AuthorizationProtocolParseResult<v.InferOutput<TSchema>> {
  const result = v.safeParse(schema, input);
  return result.success
    ? { ok: true, value: result.output }
    : { ok: false, error: { code } };
}

export function parseAuthorizationViewV1(
  input: unknown
): AuthorizationProtocolParseResult<AuthorizationViewEnvelopeV1> {
  return parseProtocolValue(
    authorizationViewEnvelopeV1Schema,
    input,
    "invalid_view"
  );
}

export function parseAuthorizationEventV1(
  input: unknown
): AuthorizationProtocolParseResult<AuthorizationEventEnvelopeV1> {
  return parseProtocolValue(
    authorizationEventEnvelopeV1Schema,
    input,
    "invalid_event"
  );
}

export function parseDeclarativeAuthorizationInteractionV1(
  input: unknown
): AuthorizationProtocolParseResult<DeclarativeAuthorizationInteractionV1> {
  return parseProtocolValue(
    declarativeAuthorizationInteractionV1Schema,
    input,
    "invalid_declarative_interaction"
  );
}

export function resolveDeclarativeAuthorizationInitialViewV1(
  interaction: DeclarativeAuthorizationInteractionV1,
  locale: string
): AuthorizationViewV1 {
  const normalized = locale.trim();
  return (
    interaction.initialView.locales[normalized] ??
    interaction.initialView.locales[interaction.initialView.defaultLocale]!
  );
}

export function defineAuthorizationForm<
  const TForm extends v.InferInput<typeof authorizationFormViewV1Schema>
>(form: TForm): TForm {
  v.parse(authorizationFormViewV1Schema, form);
  return form;
}
