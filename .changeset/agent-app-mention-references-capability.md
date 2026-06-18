---
"@tutti-os/agent-gui": patch
"@tutti-os/desktop": patch
---

Drive the "@" mention palette's per-app "view artifact files" (产物文件) entry from the app's real reference capability instead of a hardcoded app-id blocklist. The desktop workspace-app mention provider now threads each app's `references.listSupported` (declared by the app manifest) through the mention presentation, and the palette only renders the entry for apps that can actually provide reference files. Apps without that capability — including agent launchers like Claude Code and Codex — no longer show the entry, and newly added referenceable apps light up automatically without code changes.
