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

V2 is the renderer-facing convergence contract:

- it retains the V1 form, external-link, device-code, QR-code, progress, and
  result views;
- it adds `embedded_page` as a schema view with a credential-free HTTPS URL
  and a stable `flowId` for browser-session continuity across view steps;
- it lets the host normalize a validated runtime broker URL into either
  `external_link` or `embedded_page` before the UI sees it;
- it keeps one View/Event validation and rendering path for declarative and
  runtime authorization.

Credential brokers may continue emitting the transport-level
`authorization_url` event. That event is provider output, not a UI contract:
the host applies URL policy, creates an `AuthorizationViewEnvelopeV2`, and
retains the legacy URL response only for older clients.
