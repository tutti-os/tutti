# Agent Provider Detection Audit

Date: 2026-07-11

This note records the evidence used to audit provider-detection constants and
the remaining read/detect split work. It is intentionally separate from
runtime code so future updates can distinguish compatibility policy from
upstream release churn.

## Hard-coded value audit

| Item                                           | Decision                                                                                                                     | Evidence checked on 2026-07-11                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex npm platform packages and target triples | Keep the six published Node platform mappings and the existing vendor target triples; remove the unused `386`/`ia32` branch. | `npm view @openai/codex@0.144.1 optionalDependencies` listed `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, and `win32-arm64`. The `0.144.1-darwin-arm64` and `0.144.1-linux-x64` tarballs contained `vendor/aarch64-apple-darwin/bin/codex` and `vendor/x86_64-unknown-linux-musl/bin/codex`.                                       |
| Provider API endpoints                         | Keep the ChatGPT Codex, OpenAI API, and Anthropic endpoints.                                                                 | Current Codex source constructs the ChatGPT base at `https://chatgpt.com/backend-api/codex` and the API-key base at `https://api.openai.com/v1`; current Codex response requests append `/responses`. Claude Code continues to use Anthropic's messages API. These are connectivity probes, not authenticated API calls.                                     |
| npm registry fallbacks                         | Keep official npm first, followed by Huawei and Tencent mirrors.                                                             | Package metadata for `@openai/codex` returned HTTP 200 from all three endpoints. Tencent was materially slower in the audit, which is handled by the existing ranking timeout and keeps it as a fallback rather than the preferred source. npm integrity verification remains authoritative for downloaded tarballs.                                         |
| `MinSupportedCodexVersion = 0.126.0`           | Keep.                                                                                                                        | The floor is capability-derived (the app-server thread/goal method used by Tutti), not a latest-version pin. npm latest was `0.144.1`; raising the floor solely to latest would unnecessarily reject compatible installations. Unknown/unparseable versions are now reported as `CODEX_VERSION_UNKNOWN` instead of bypassing the floor.                      |
| `minTuttiAgentVersion`                         | Raise from `0.0.2` to `0.0.3`.                                                                                               | `npm view @tutti-os/tutti-agent version` returned `0.0.3`, and all current platform dist-tags/optional dependencies point to `0.0.3` artifacts. The native `0.0.3-darwin-arm64` binary still prints `tutti-agent 0.0.2`; the compatibility gate intentionally uses the installed adapter package manifest (`0.0.3`), not that stale embedded version string. |

Primary upstream references:

- <https://www.npmjs.com/package/@openai/codex>
- <https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/responses.rs>
- <https://docs.cursor.com/en/cli/reference/authentication>
- <https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/auth/index.ts>

## Read/detect split status

The full design in
`docs/specs/2026-06-28-agent-status-read-detect-split-design.md` remains
deferred. This change deliberately does not add a daemon status store or a new
detect endpoint because the required API/client/polling migration would expand
the already broad correctness patch and is not needed to complete items 1-8.

Current gap after this audit:

- `Service.List` still performs local CLI, version, auth, and selected adapter
  runtime probes on every call.
- Network probing is already opt-in and the wizard is the only desktop caller
  that requests it.
- Install-in-flight Cursor checks skip the runtime launch probe, and
  install-progress network probes are skipped, limiting the most expensive
  repeated work.
- Desktop no longer changes daemon availability verdicts. It only merges
  provider-scoped responses and preserves the last network diagnostic when a
  later local-only response omits that optional field.

The next implementation should update the older design assumption that an
empty `agentstatus.Service{}` is unavoidable: provider availability now
receives the configured daemon status lister through dependency injection.
