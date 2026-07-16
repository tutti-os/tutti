---
"@tutti-os/agent-gui": patch
"@tutti-os/ui-rich-text": patch
---

Group Agent target mention results by the owning member declared in the
host-provided provenance catalog, while preserving per-Agent grouping for hosts
without ownership data and uncatalogued targets when no source is selected.
Agent directory owners now expose an optional stable user id so collaboration
hosts can group targets that do not have session history yet.

Keep unavailable shared Agent targets visible in mention directories while
preventing mouse and keyboard selection until the host reports them ready.
