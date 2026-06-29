---
"@tutti-os/desktop": patch
---

Treat Claude Code API Usage Billing as authenticated in the environment wizard. Claude Code can run on an API key / auth token / apiKeyHelper instead of an Anthropic Console login; `claude auth status` only reflects the stored OAuth session and is blind to those env/settings credentials, so the provider status probe now detects them directly and reports the provider as ready instead of blocking on "未登录". The login step label now distinguishes between a Console OAuth session ("已登录账号") and API Usage Billing ("已配置 API 计费"). A bare custom API endpoint without any credential is not treated as API billing, since the user may still be on an OAuth session against that endpoint.
