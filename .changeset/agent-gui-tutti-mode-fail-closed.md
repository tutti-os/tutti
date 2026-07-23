---
"@tutti-os/agent-gui": patch
---

Fail closed on Tutti Mode UI unless the host sets
`capabilityMenuState.tuttiMode.enabled` to true, so shared AgentGUI hosts do not
leak the hero toggle, badge activation, or `/tutti` when the lab capability is
omitted or disabled.
