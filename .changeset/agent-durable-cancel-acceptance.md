---
"@tutti-os/agent-activity-core": patch
"@tutti-os/agent-gui": patch
---

Model durable turn-cancel acceptance separately from terminal cancellation so
shared-agent callers remain blocked until the canonical turn settles.
