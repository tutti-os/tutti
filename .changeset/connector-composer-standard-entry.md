---
"@tutti-os/agent-gui": patch
"@tutti-os/connector-market": minor
"@tutti-os/desktop": patch
---

Standardize Connector Composer integration around the shared Connector Market
package. Connector Market now exports the compact composer menu and the
authoritative dialog-open use case, AgentGUI maps capability options into that
host-neutral entry, and Desktop routes workspace and standalone requests through
the shared dialog state machine.
