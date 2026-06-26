---
"@tutti-os/desktop": patch
"@tutti-os/agent-gui": patch
---

Rework the agent environment setup wizard into one consistent step track shared by the in‑progress and completed states, with each step shown in its done tense ("已安装 CLI") and its info inline. A blocked step states the problem ("未xxx") and offers the inline fix ("进行xxx"). Re‑detect now opens the wizard and re‑runs detection there (the dock action too), and opening the panel no longer silently re‑probes on every open.

Add an active network‑check step that probes connectivity for real and reports each link separately: the npm registry (install path), the provider API (run/login path, skipped when the CLI uses a custom API key/endpoint — detected from env and the CLI config files), and the HTTP proxy (whether configured, its host:port, and reachability).

Rebuild the agent run‑failure error taxonomy around the codes the daemon actually emits (splitting out `cli_not_found`, `cli_version_unsupported`, and `network_error`), with granular provider‑aware copy and a wizard call‑to‑action on every environment‑fixable failure, while transient/server‑side failures get accurate copy and no (misleading) wizard button.
