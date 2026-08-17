---
"@tutti-os/agent-activity-core": patch
---

Allow hosts that already fence transport identity and ordering to mark a
same-Turn settlement as authoritative across source clock skew, while keeping
the canonical timestamp guard for ordinary realtime and generic projections.
