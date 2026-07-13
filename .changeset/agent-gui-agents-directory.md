---
"@tutti-os/agent-gui": minor
"@tutti-os/desktop": patch
---

Replace AgentGUI's public provider-target catalog contract with a required,
host-ordered `agents` directory projected from `/agents`. Agent selection,
filtering, composer caches, workbench state, and launches now use exact
`agentTargetId` identity; names, icons, owner badges, and availability come from
the corresponding agent entry. Empty directories no longer synthesize local
provider entries, one-agent views hide `All`, and multiple agents may share one
runtime provider without being grouped or deduplicated.

Remove the old public `providerTargets`, `providerRailMode`, provider-target
renderers, and `defaultProviderTargetId` surface. Desktop now feeds its agents
snapshot through the new contract. Workbench hydration retains only a one-time
legacy `providerTargetId` to `agentTargetId` state repair.
