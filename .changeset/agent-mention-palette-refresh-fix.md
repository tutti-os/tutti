---
"@tutti-os/desktop": patch
---

Fix the agent mention palette resetting when switching to the "Agents" tab. The desktop agents service now skips emitting snapshot updates when the fetched agent target list is unchanged, preventing unnecessary workbench host input reconstruction and AgentGUI remounts.
