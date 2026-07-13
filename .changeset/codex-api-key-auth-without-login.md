---
"@tutti-os/desktop": patch
---

Improve Codex custom-provider support: treat API keys from the environment, `config.toml`, or `auth.json` as authenticated without a ChatGPT login; expose only the configured model for custom `model_provider` endpoints; suppress non-actionable model-metadata warnings; and avoid duplicate assistant replies when Codex replays polished final text.
