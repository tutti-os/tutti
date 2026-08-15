# Connector Authorization Protocol

Host-neutral, versioned View/Event contracts for Connector authorization UI.

- The protocol contains data only and has no React or transport dependency.
- All untrusted payloads must pass the exported Valibot parsers before use.
- Runtime credential routing remains outside this package.

V1 includes:

- strict `AuthorizationViewEnvelopeV1` and `AuthorizationEventEnvelopeV1`
  contracts;
- form, external-link, device-code, QR-code, progress, and result views;
- text, secret, number, select, boolean, and opaque local-file fields;
- view-aware event validation, including stale-view and unknown-field rejection;
- a narrow declarative `native_secret` interaction whose submission field must
  reference its only secret field;
- symmetric localized initial views under `initialView.locales`, with an
  explicit `initialView.defaultLocale` fallback.

The declarative interaction is configuration, not executable Connector code.
The host adapter owns runtime `viewId` generation and calls the existing trusted
authorization backend after validation.
