---
"@tutti-os/workspace-file-reference": patch
"@tutti-os/agent-gui": patch
---

Use each reference source heading as its root navigation target instead of rendering a duplicate synthetic root directory in the picker sidebar. Keep type-only filtering in a cancellable recursive tree that removes directories without matching descendants, constrain keyword results by picker purpose, remove provenance filtering from the shared full picker, and hide opaque node ids from search result subtitles.
