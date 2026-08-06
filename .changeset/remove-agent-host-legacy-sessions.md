---
"@tutti-os/agent-gui": major
---

Remove the obsolete `AgentHostInputApi.agentSessions` activity lifecycle surface and its unused `AgentHostAgentSessionsApi` type. Agent session lifecycle remains owned by the canonical AgentSessionEngine rather than the host capability contract.
