---
"@tutti-os/connector-renderer": patch
---

Keep OAuth authorization loading active until its durable operation reaches a terminal state, and prevent a late accepted response from overwriting that terminal result in connector cards.
