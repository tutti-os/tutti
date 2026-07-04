---
"@tutti-os/workbench-surface": patch
---

Fix the dock agent-provider "连接/登录" popover button doing nothing when clicked. The hover-panel action fired on `onClick`, but the panel can be torn down between pointerdown and pointerup (a re-render race, or the overlapping workspace-app webview swallowing the pointerup), so the browser never dispatched the click and the button looked dead. The action now triggers on `pointerdown` (the event proven to reliably reach the button), with keyboard activation still flowing through `onClick` and a short dedupe so a mouse press doesn't double-fire.
