---
"@tutti-os/desktop": patch
---

Mirror relative Codex `model_catalog_json` files into the run-scoped sandbox `CODEX_HOME`. CC Switch and similar tools write `model_catalog_json = "cc-switch-model-catalog.json"`; Tutti previously copied only `config.toml`, so Codex `thread/start` failed with ENOENT and the UI showed "agent session is not connected".
