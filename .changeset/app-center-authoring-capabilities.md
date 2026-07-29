---
"@tutti-os/workspace-app-center": patch
"@tutti-os/desktop": patch
---

Let App Center hosts independently enable create, archive import, and load-unpacked authoring actions. Declared capabilities fail closed when the matching host callback is absent, and local-only hosts can present the final factory action as Save to my apps while Tutti keeps its existing defaults.
