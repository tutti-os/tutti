---
"@tutti-os/agent-gui": patch
"@tutti-os/agent-activity-core": patch
---

Tighten AgentGUI runtime capability contracts and activity-core submit
availability derivation. AgentGUI runtimes can now declare optional command
capabilities, development builds get a default console diagnostic sink when no
runtime sink is provided, and timeline projection rows no longer participate in
durable message paging cursors. Activity-core now treats explicit wire
`submitAvailability.state = "available"` as authoritative and ignores stale
`activeTurnId` values once the turn lifecycle is settled.
