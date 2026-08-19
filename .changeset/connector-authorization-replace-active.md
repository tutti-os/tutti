---
"@tutti-os/connector-renderer": patch
---

Replace an active Connector authorization attempt through one Host-owned command, wait for managed credential-broker termination before starting the replacement, propagate replacement and cancellation to the account control plane, start managed authorization only after an explicit user action, and keep dialog dismissal separate from explicit cancellation.
