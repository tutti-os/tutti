# Codex App-Server Refactor — Step 1 Codexproto Plan

Goal: add the typed Codex app-server protocol layer as additive infrastructure.
No production adapter path consumes it in this step.

Sources:

- Design: `docs/specs/2026-07-01-codex-appserver-refactor-design.md`
- ADRs: `docs/adr/0001-codex-appserver-codegen-approach.md`,
  `docs/adr/0002-codexproto-pinning-source-drift.md`
- Reference generator: `/Users/asdf/Repo/codex-sdk-go/internal/codegen`
- Upstream schema source: `/Users/asdf/Repo/codex/codex-rs/app-server-protocol/schema/json`

Pinned source:

- Codex commit: `6d2168f06ae275d5e1f73cabf935d2bcc8549998`
- Codex package version: resolved from the pinned checkout during generation

Implementation tasks:

- [ ] Create `packages/agent/daemon/runtime/codexproto`.
- [ ] Vendor upstream committed `schema/json/**/*.json` from the pinned commit.
- [ ] Add a Go generator command under `runtime/codexproto/internal/codegen`
      adapted from `codex-sdk-go`, with the Rust export step removed.
- [ ] Generate protocol types, RPC method helpers, notification parsing, fallback
      types, aliases, metadata, and the manual supplement in package
      `codexproto`.
- [ ] Add a drift check command that re-fetches the pinned schema and verifies
      the generated files are current.
- [ ] Keep the step purely additive: do not alter `codex_appserver_adapter.go`,
      `acp_client.go`, or generic ACP code.
- [ ] Validate from `packages/agent/daemon`: `go build ./runtime/...`,
      `go test ./runtime/ -count=1`, and the Step 0 bug corpus command.

Review boundary: stop after Step 1 validation and wait for review before Step 2.
