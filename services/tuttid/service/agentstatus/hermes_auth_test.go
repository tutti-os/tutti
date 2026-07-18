package agentstatus

import "testing"

// hermesStatusFixture* mirror real `hermes status` output (hermes-agent
// 0.18.2), trimmed to the sections the parser reads. The active provider is
// named under "◆ Environment" and its readiness lives in a section that
// depends on how it is configured (OAuth vs configured inference provider vs
// raw API key).
const hermesStatusFixtureAuthenticated = `
┌─────────────────────────────────────────────────────────┐
│                 ⚕ Hermes Agent Status                  │
└─────────────────────────────────────────────────────────┘

◆ Environment
  Project:      /Users/test/.hermes/hermes-agent
  Python:       3.11.15
  .env file:    ✓ exists
  Model:        gpt-5.6-terra
  Provider:     OpenAI Codex

◆ API Keys
  OpenAI        ✗ (not set)

◆ Auth Providers
  Nous Portal   ✗ not logged in (run: hermes portal)
  OpenAI Codex  ✓ logged in
    Auth file:  /Users/test/.hermes/auth.json
    Refreshed:  2026-07-15 15:01:20 CST
  Qwen OAuth    ✗ not logged in (run: qwen auth qwen-oauth)

◆ API-Key Providers
  Z.AI / GLM       ✗ not configured (run: hermes model)

◆ Terminal Backend
  Backend:      local
  Sudo:         ✗ disabled
`

const hermesStatusFixtureRequired = `
◆ Environment
  Project:      /Users/test/.hermes/hermes-agent
  Provider:     OpenAI Codex

◆ Auth Providers
  Nous Portal   ✗ not logged in (run: hermes portal)
  OpenAI Codex  ✗ not logged in (run: hermes auth add openai-codex)

◆ Terminal Backend
  Backend:      local
`

// Active provider is a configured inference provider (API-Key Providers
// section), not an OAuth one. Reading only Auth Providers would miss it and
// fall back to the marker file.
const hermesStatusFixtureAPIKeyProviderConfigured = `
◆ Environment
  Provider:     Z.AI / GLM

◆ Auth Providers
  Nous Portal   ✗ not logged in (run: hermes portal)
  OpenAI Codex  ✗ not logged in (run: hermes auth add openai-codex)

◆ API-Key Providers
  Z.AI / GLM       ✓ configured
  Kimi / Moonshot  ✗ not configured (run: hermes model)
`

// Active provider is an unconfigured inference provider. Must resolve to
// AuthRequired directly so a stale ~/.hermes/auth.json (from some other OAuth
// login) can't make the marker-file fallback report it as ready.
const hermesStatusFixtureAPIKeyProviderUnconfigured = `
◆ Environment
  Provider:     Z.AI / GLM

◆ Auth Providers
  OpenAI Codex  ✓ logged in

◆ API-Key Providers
  Z.AI / GLM       ✗ not configured (run: hermes model)
`

// Active provider is driven by a raw provider API key (API Keys section).
const hermesStatusFixtureRawAPIKeySet = `
◆ Environment
  Provider:     OpenAI

◆ API Keys
  OpenRouter    ✗ (not set)
  OpenAI        ✓ set

◆ Auth Providers
  Nous Portal   ✗ not logged in (run: hermes portal)
`

func TestParseHermesAuthStatusOutputAuthenticated(t *testing.T) {
	auth, ok := parseHermesAuthStatusOutput([]byte(hermesStatusFixtureAuthenticated))
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if auth.Status != AuthAuthenticated {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthAuthenticated)
	}
	if auth.AccountLabel != "OpenAI Codex" {
		t.Fatalf("AccountLabel = %q, want %q", auth.AccountLabel, "OpenAI Codex")
	}
}

func TestParseHermesAuthStatusOutputRequired(t *testing.T) {
	auth, ok := parseHermesAuthStatusOutput([]byte(hermesStatusFixtureRequired))
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if auth.Status != AuthRequired {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthRequired)
	}
}

// Regression: a valid API-key inference provider must read as authenticated
// even though it is absent from the Auth Providers section (which would
// otherwise fall through to the marker file and, with no auth.json, report
// auth_required).
func TestParseHermesAuthStatusOutputAPIKeyProviderConfigured(t *testing.T) {
	auth, ok := parseHermesAuthStatusOutput([]byte(hermesStatusFixtureAPIKeyProviderConfigured))
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if auth.Status != AuthAuthenticated {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthAuthenticated)
	}
	if auth.AccountLabel != "Z.AI / GLM" {
		t.Fatalf("AccountLabel = %q, want %q", auth.AccountLabel, "Z.AI / GLM")
	}
}

// Regression: an unconfigured active provider must resolve to AuthRequired
// directly, not fall back to the marker file (which a stale auth.json would
// mislabel as ready).
func TestParseHermesAuthStatusOutputAPIKeyProviderUnconfigured(t *testing.T) {
	auth, ok := parseHermesAuthStatusOutput([]byte(hermesStatusFixtureAPIKeyProviderUnconfigured))
	if !ok {
		t.Fatal("ok = false, want true (must resolve directly, not defer to marker file)")
	}
	if auth.Status != AuthRequired {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthRequired)
	}
}

func TestParseHermesAuthStatusOutputRawAPIKeySet(t *testing.T) {
	auth, ok := parseHermesAuthStatusOutput([]byte(hermesStatusFixtureRawAPIKeySet))
	if !ok {
		t.Fatal("ok = false, want true")
	}
	if auth.Status != AuthAuthenticated {
		t.Fatalf("Status = %q, want %q", auth.Status, AuthAuthenticated)
	}
}

func TestParseHermesAuthStatusOutputFallsBackWhenUnparseable(t *testing.T) {
	cases := map[string]string{
		"empty output": "",
		"no provider field": `
◆ Auth Providers
  OpenAI Codex  ✓ logged in
`,
		"active provider absent from every readiness section": `
◆ Environment
  Provider:     Some Unknown Provider

◆ Auth Providers
  Nous Portal   ✗ not logged in (run: hermes portal)

◆ API-Key Providers
  Z.AI / GLM       ✗ not configured (run: hermes model)
`,
		"garbage": "not a hermes status report at all",
	}
	for name, output := range cases {
		if _, ok := parseHermesAuthStatusOutput([]byte(output)); ok {
			t.Fatalf("%s: ok = true, want false (fall back to marker file)", name)
		}
	}
}
