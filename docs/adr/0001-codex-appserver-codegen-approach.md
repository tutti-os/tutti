# ADR 0001 — Codex app-server codegen: full generated surface, subset wiring

- Date: 2026-07-02
- Status: Accepted (grilling session)
- Context: Step 1 of the app-server layer refactor (see
  `docs/specs/2026-07-01-codex-appserver-refactor-design.md`).

## Decision

Port-and-slim codex-sdk-go's `internal/codegen` generator into tutti's
`codexproto` package (design option **a**, not hand-written stubs and not
vendoring the SDK's generated output).

- **Codegen surface = full.** Generate the complete protocol surface
  (~84 client methods / 8 server requests / 64 notifications) from the upstream
  `export`, plus the unavoidable hand-maintained type supplement
  (cf. SDK `protocol/manual_types.go`, 214 lines — go-jsonschema cannot express
  the whole schema).
- **Wiring = subset.** This refactor's steps wire only the four-state-machine
  subset tutti actually uses today (~21 client / 4 server-req / 22 notif);
  the rest of the generated surface is additive and unwired (Step 1 is
  "purely additive").
- **Full capability alignment is a direction, not this refactor's wiring scope.**
  Keeps the design's out-of-scope boundary (fork/compact/realtime/inject_items
  wiring) and the one-state-machine-per-step discipline intact, while laying the
  generator foundation so future alignment is "re-run + wire", not "write a
  generator".

## Why not

- **(b) hand-write stubs for the subset:** minimal now, but re-writing 156 stubs
  by hand for future full alignment and chasing every codex version bump is the
  exact cost a generator exists to remove.
- **(c) vendor SDK's generated `protocol/`+`rpc/`:** pinned to an older codex
  commit (`e2b60462`) that lacks methods tutti already uses
  (`collaborationMode/list`), and inherits the SDK's facade opinions —
  contradicts D5 supply-chain stance for daemon core.

## Evidence

- SDK generator is `codex-sdk-go/internal/codegen/main.go` (1066 lines):
  runs Rust `export`, feeds JSON Schema → go-jsonschema → `protocol/types_gen.go`
  (3973 lines), and separately renders `rpc/*_requests_gen.go` from the
  `ClientRequest.json`/`ServerRequest.json` `oneOf` method-unions.
- Generated files are stamped by codex git commit, not version string.
- tutti uses ~25% of the client surface today; 3 used methods
  (`initialize`, `initialized`, `collaborationMode/list`) are NOT in the SDK's
  generated output — version/commit skew.
