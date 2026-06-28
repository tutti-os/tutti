---
"@tutti-os/agent-gui": patch
---

Strip Markdown emphasis markers (**bold**, *italic*, __bold__, _italic_, ~~strike~~, `code`) from agent message text when it is shown in plain-text contexts — clipboard copy and Message Center stack previews / lazy fallback rendering.  Fixes stray asterisks visible in copied agent replies (#432) and Message Center digests (#423).
