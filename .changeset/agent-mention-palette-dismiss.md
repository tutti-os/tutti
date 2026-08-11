---
"@tutti-os/agent-gui": patch
---

Add natural dismiss interactions for the Agent composer `@`-mention palette: pointer interactions outside the prompt input area and the palette surface now close the palette, and a settled multi-word query with zero matching results dismisses it instead of pinning an empty panel, aligning the mention palette with the slash-command palette's dismissal contract.
