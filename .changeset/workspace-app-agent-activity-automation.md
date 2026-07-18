---
"@tutti-os/desktop": patch
"@tutti-os/workspace-external-core": minor
---

Expose a trusted workspace-app Agent Activity bridge that lists exact Agent
targets, delegates session and turn operations to the host-owned Agent GUI
runtime, and returns the same Activity snapshot used by Agent GUI.

Document the boundary between host-owned Agent GUI automation and independent
app-owned Agent runtimes.
