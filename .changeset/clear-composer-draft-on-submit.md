---
"@tutti-os/agent-gui": patch
---

Clear the composer draft (including images) immediately when a prompt is submitted instead of waiting for the send request to resolve. Fixes #430 where sent images remained visible in the composer for a while after sending.
