---
"@tutti-os/agent-gui": patch
---

Reset the local submitting flag as soon as the server confirms a turn has settled, rather than waiting for the original send request promise to resolve. Fixes #428 where completed conversations briefly flashed a queued state when sending the next message.
