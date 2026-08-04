---
"@tutti-os/agent-gui": patch
---

Allow AgentGUI long-paste staging to return a prepared remote file URL as well
as a local archive path. Shared hosts can now pass text/plain pasted content
through their existing attachment upload pipeline without treating a remote
asset as a local file, while conversation lists receive only a safe pasted-text
preview rather than the remote locator.
