# Codex App-Server Refactor — Step 2 Typed Client Plan

Goal: make the Codex app-server adapter speak through a typed client facade
over the existing shared JSON-RPC transport. Generic ACP code stays intact.

Sources:

- Design: `docs/specs/2026-07-01-codex-appserver-refactor-design.md`
- ADR: `docs/adr/0002-codexproto-pinning-source-drift.md`
- Existing transport: `packages/agent/daemon/runtime/acp_client.go`
- Generated protocol: `packages/agent/daemon/runtime/codexproto`

Implementation tasks:

- [ ] Add a Codex-specific typed client wrapper in `runtime` that owns:
      generated `codexproto.Client` calls, startup timeout/handler variants,
      server notification parsing, server request parsing, and unknown-method
      fallback.
- [ ] Keep `acp_client.go` as the shared transport and do not alter generic ACP
      adapters.
- [ ] Export generated codexproto parser/dispatcher helpers needed by the
      wrapper while preserving unknown notification fallback.
- [ ] Replace app-server adapter request send sites with typed client methods.
      Keep behavior and wire payloads stable.
- [ ] Leave event reduction and approval semantics unchanged; those belong to
      Steps 3-6.
- [ ] Validate from `packages/agent/daemon`: `go build ./runtime/...`,
      `go test ./runtime/ -count=1`, Step 0 bug corpus, and
      `pnpm check:codexproto-generated`.

Review boundary: stop after Step 2 validation and wait for review before Step 3.
