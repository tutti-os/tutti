# ADR 0002 — codexproto: pinning, source acquisition, drift tolerance

- Date: 2026-07-02
- Status: Accepted (grilling session)
- Context: Step 1 codegen inputs. Corroborated by two independent real
  consumers: `codex-sdk-go` (Go) and `t3code/effect-codex-app-server` (TS).

## Decisions

### Pinning (Q3-A)

- codexproto is generated against an explicit **codex git commit SHA**, stamped
  into `metadata_gen.go` (cf. codex-sdk-go `Source codex commit:` and t3code
  `meta.gen.ts` `Upstream protocol ref:`).
- The Step-0 runtime **binary** baseline (`codex-cli 0.142.5`) and this **source
  SHA** are recorded together in the bug-corpus/baseline doc. They are distinct
  axes: source SHA governs the typed surface; binary version is what the daemon
  actually spawns.

### Source acquisition (Q4 → option 1)

- **Vendor the upstream _already-committed_ `schema/json/*.json` at the pinned
  SHA. Do NOT run the Rust `export` bin.** The schema artifacts are tracked in
  the codex repo (`git ls-files codex-rs/app-server-protocol/schema/json`), so
  no Rust toolchain or local codex checkout is required.
- **Eliminates design Risk #1** ("codegen toolchain depends on the Rust export
  bin"). Ops-2 becomes: vendor committed schema at pinned SHA + CI re-fetches the
  same ref and diffs.
- Generator = adapted `codex-sdk-go/internal/codegen` (Go, go-jsonschema), with
  its `exportSchemas` (run-Rust) step **replaced** by "read vendored JSON".

### Drift tolerance (Q3-B)

- The runtime codex binary floats (auto-updates) relative to the pinned source.
  The CI drift check only catches codexproto-vs-pinned-source drift, NOT
  codexproto-vs-running-binary drift.
- Therefore: generated types **allow unknown fields**, and notification/server-
  request dispatch keeps an explicit **unknown-method fallback** (cf. t3code
  `handleUnknownServerRequest` / `handleUnknownServerNotification`) that logs and
  degrades instead of crashing. This preserves the tolerance `map[string]any`
  has today. Extends the Step-4 "lossless tier / degradable events" principle
  down into the decode layer.

### Manual type supplement

- A hand-maintained supplement is unavoidable and universal across consumers
  (codex-sdk-go `manual_types.go` 214 lines; t3code `ManualSchemas`).
- **`collaborationMode/list` is "used-but-unexported":** tutti calls it live
  (`codex_appserver_adapter.go:807`, feeding `turn/start`'s `collaborationMode`),
  but it is absent from upstream `ClientRequest.json` and from both reference
  consumers' generated output. It goes in tutti's manual supplement — NOT
  deleted, NOT expected from the generator.

## Evidence

- `git ls-files` lists `ClientRequest.json`, `codex_app_server_protocol.schemas.json`,
  `…v2.schemas.json` → schema is committed upstream.
- t3code `generate.ts`: `UPSTREAM_REF` SHA + GitHub API `?ref=` fetch of committed
  JSON; `ManualSchemas`; `handleUnknown*` fallbacks.
- collaborationMode exists upstream only as a ServerNotification/ThreadSettings
  field, never as a `collaborationMode/list` method.
