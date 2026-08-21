---
"@tutti-os/desktop": patch
---

Stop replaying in-flight connector authorization from durable state, so API-key Connect cannot complete a control-plane session with an empty secret.
