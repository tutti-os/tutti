---
"@tutti-os/desktop": patch
---

Add `agent.provider_ready` and `agent.chat_ready` analytics events so the first-landing activation funnel (page view → provider bound → chat surface ready → message sent) is measurable regardless of how a provider became ready. `agent.provider_ready` fires on a non-ready→ready provider transition (carrying `became_ready_via` and `previous_status`), closing the blind spot where users who authenticate outside the in-app login button never produced funnel data; `agent.chat_ready` fires when the agent workbench is mounted with a ready provider.
