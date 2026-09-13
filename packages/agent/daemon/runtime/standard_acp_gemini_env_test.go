package agentruntime

import (
	"context"
	"testing"
)

func TestStandardACPAdapterDisablesGeminiCLIRelaunchOnLaunch(t *testing.T) {
	t.Parallel()

	cases := []struct {
		provider string
		want     bool
	}{
		{provider: "acp:gemini", want: true},
		{provider: "acp:example", want: false},
		{provider: "acp:kimi-code", want: false},
		{provider: "acp:grok", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			t.Parallel()

			transport := newStandardACPTransport("Agent", "session-1")
			adapter, err := NewStandardACPAdapter(StandardACPAdapterConfig{
				Provider:    tc.provider,
				Name:        "test-acp",
				DisplayName: "Agent",
				Command:     []string{"agent", "--acp"},
			}, transport, LegacyHostMetadata())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := adapter.Start(context.Background(), standardTestSession(tc.provider)); err != nil {
				t.Fatal(err)
			}
			if len(transport.specs) != 1 {
				t.Fatalf("specs = %d, want 1", len(transport.specs))
			}
			got := containsString(transport.specs[0].Env, geminiCLINoRelaunchEnv)
			if got != tc.want {
				t.Fatalf("GEMINI_CLI_NO_RELAUNCH present = %v, want %v; env=%#v", got, tc.want, transport.specs[0].Env)
			}
		})
	}
}

func TestRunStandardACPSetupKeepsGeminiCLINoRelaunchDuringAuthenticate(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Gemini CLI", "setup-session")
	transport.conn.authMethods = []map[string]any{{
		"id": "oauth-personal", "name": "Log in with Google",
	}}
	transport.conn.requireAuthentication = true
	result, err := RunStandardACPSetup(
		context.Background(),
		StandardACPAdapterConfig{
			Provider: "acp:gemini", Name: "gemini-acp", Command: []string{"gemini", "--acp"},
		},
		transport,
		LegacyHostMetadata(),
		standardTestSession("acp:gemini"),
		"oauth-personal",
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StandardACPSetupReady {
		t.Fatalf("setup status = %q, want ready", result.Status)
	}
	if len(transport.specs) != 1 {
		t.Fatalf("specs = %d, want 1", len(transport.specs))
	}
	if !containsString(transport.specs[0].Env, geminiCLINoRelaunchEnv) {
		t.Fatalf("authenticate env = %#v, want %s", transport.specs[0].Env, geminiCLINoRelaunchEnv)
	}
	if containsString(transport.specs[0].Env, "NO_BROWSER=1") {
		t.Fatal("interactive authenticate must still allow the runtime to open a browser")
	}
}
