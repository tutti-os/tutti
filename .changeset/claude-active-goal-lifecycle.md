---
"@tutti-os/agent-gui": patch
"@tutti-os/claude-sdk-sidecar": patch
---

Normalize Claude SDK `active_goal` messages, including the native completion wire shape whose omitted `value` means the Goal hook cleared, stop inferring Goal completion from ordinary Turn settlement, and settle exact Goal control operations through the Host-owned lifecycle lane instead of transient session runtime context.
