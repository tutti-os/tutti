---
"@tutti-os/agent-gui": patch
"@tutti-os/ui-rich-text": minor
"@tutti-os/ui-system": patch
"@tutti-os/workspace-external-core": minor
---

Hydrate mention presentation in readonly rich-text conversations from the same
trigger providers used by the composer, so workspace app icons remain available
without serializing presentation URLs into Markdown.

Render semantic mention icons whenever a supplied image cannot load across the
shared mention pill, AgentGUI composer, and AgentGUI Markdown surfaces.

Add a host-agnostic mention service with bounded stale-while-revalidate cache,
React context integration, exact external-host resolution, and invalidation.
