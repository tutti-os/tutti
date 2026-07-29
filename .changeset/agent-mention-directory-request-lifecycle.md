---
"@tutti-os/agent-gui": patch
---

Give composer mention directory navigation an independent cancellable request
lifecycle so slow directory reads are not converted into empty results by the
short keyword-search provider timeout.
