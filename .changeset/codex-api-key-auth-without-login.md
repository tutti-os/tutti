---
"@tutti-os/desktop": patch
---

Treat Codex API-key billing as authenticated in the environment wizard. Codex can run with `OPENAI_API_KEY` (env), a `config.toml` `api_key`, or `OPENAI_API_KEY` inside `~/.codex/auth.json` (e.g. cc-switch OpenRouter providers) without a ChatGPT login; `codex login status` only reflects the OAuth session and reports "Not logged in" for API-key users, so the provider status probe now detects those credentials the same way Claude Code API Usage Billing does and reports the provider as ready instead of blocking on "未登录". A bare custom base URL without a credential is still not treated as API billing.
