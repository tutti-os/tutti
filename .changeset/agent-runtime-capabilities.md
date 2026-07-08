---
"@tutti-os/agent-activity-core": patch
"@tutti-os/agent-gui": patch
---

Add optional AgentGUI runtime capabilities for shared or remote agent sources, letting hosts hide cancel, interactive prompt, goal control, and attachment upload affordances while keeping undeclared capabilities enabled by default. Make `AgentActivityAdapter.subscribeSessionEvents` optional with a no-op retained-stream fallback so adapters using external event delivery no longer need throwing stubs when controller auto-retain is disabled.
