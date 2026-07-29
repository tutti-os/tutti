package agentruntime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

// TestRealCodexAppServerTurn drives the adapter against the locally
// installed `codex app-server` binary. Gated behind an env var because it
// needs codex credentials and spends real tokens.
func TestRealCodexAppServerTurn(t *testing.T) {
	if os.Getenv("TUTTI_REAL_CODEX_TEST") == "" {
		t.Skip("set TUTTI_REAL_CODEX_TEST=1 to run against the real codex app-server")
	}
	workDir := t.TempDir()
	adapter := NewCodexAppServerAdapter(NewLocalProcessTransport())
	session := Session{
		RoomID:         "real-room",
		AgentSessionID: "real-session",
		Provider:       ProviderCodex,
		CWD:            workDir,
		Status:         SessionStatusReady,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Second)
	defer cancel()
	events, err := adapter.Start(ctx, session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("no start events")
	}
	state := adapter.SessionState(session)
	t.Logf("auth state: %s", state.AuthState)
	if state.AuthState != "authenticated" {
		t.Fatalf("not authenticated: %s", state.AuthState)
	}
	defer func() { _ = adapter.Close(context.Background(), session) }()

	var streamed []activityshared.Event
	turnEvents, err := adapter.Exec(ctx, session, []PromptContentBlock{{
		Type: "text",
		Text: "Reply with exactly the word PONG and nothing else. Do not run any commands.",
	}}, "", "real-turn-1", func(next []activityshared.Event) {
		streamed = append(streamed, next...)
	}, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	var assistantText string
	var completed bool
	for _, event := range turnEvents {
		if event.Type == activityshared.EventMessageAppended && event.Payload.Role == activityshared.MessageRoleAssistant {
			assistantText = event.Payload.Content
		}
		if event.Type == activityshared.EventTurnCompleted && event.Payload.TurnOutcome == string(activityshared.TurnOutcomeCompleted) {
			completed = true
		}
	}
	t.Logf("streamed=%d total=%d assistant=%q completed=%v", len(streamed), len(turnEvents), assistantText, completed)
	if !completed {
		t.Fatalf("turn did not complete: %d events", len(turnEvents))
	}
	if !strings.Contains(strings.ToUpper(assistantText), "PONG") {
		t.Fatalf("assistant reply = %q, want PONG", assistantText)
	}
}

// TestRealCodexAppServerCrossVersionBootstrap proves that the same startup
// path used by Tutti can initialize, list models, and start a thread after
// switching between two real Codex CLI versions. It uses an isolated HOME and
// only reads the user's real config and authentication inputs.
func TestRealCodexAppServerCrossVersionBootstrap(t *testing.T) {
	if os.Getenv("TUTTI_REAL_CODEX_CROSS_VERSION_TEST") != "1" {
		t.Skip("set TUTTI_REAL_CODEX_CROSS_VERSION_TEST=1 to run the real cross-version startup smoke")
	}
	oldBinary := strings.TrimSpace(os.Getenv("TUTTI_REAL_CODEX_OLD_BIN"))
	newBinary := strings.TrimSpace(os.Getenv("TUTTI_REAL_CODEX_NEW_BIN"))
	if oldBinary == "" || newBinary == "" {
		t.Fatal("TUTTI_REAL_CODEX_OLD_BIN and TUTTI_REAL_CODEX_NEW_BIN are required")
	}

	realHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	config, err := os.ReadFile(filepath.Join(realHome, ".codex", "config.toml"))
	if err != nil {
		t.Fatalf("read real Codex config: %v", err)
	}
	authPath := filepath.Join(realHome, ".codex", "auth.json")
	if _, err := os.Stat(authPath); err != nil {
		t.Fatalf("inspect real Codex auth: %v", err)
	}

	isolatedHome := t.TempDir()
	t.Setenv("HOME", isolatedHome)
	userCodexHome := filepath.Join(isolatedHome, ".codex")
	if err := os.MkdirAll(userCodexHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userCodexHome, "config.toml"), config, 0o600); err != nil {
		t.Fatal(err)
	}

	for _, item := range []struct {
		name    string
		binary  string
		version string
	}{
		{name: "old", binary: oldBinary, version: "0.144.6"},
		{name: "new", binary: newBinary, version: "0.145.0"},
	} {
		t.Run(item.name, func(t *testing.T) {
			codexHome := t.TempDir()
			if err := os.MkdirAll(filepath.Join(codexHome, "plugins"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), config, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(authPath, filepath.Join(codexHome, "auth.json")); err != nil {
				t.Fatal(err)
			}

			bootstrapStarted := time.Now()
			bootstrap := runtimeprep.PrepareCodexRuntimeForLaunch(
				t.Context(),
				runtimeprep.CodexRuntimeBootstrapInput{
					CodexHome: codexHome,
					ResolveCLI: func(context.Context) (runtimeprep.CodexCLICommand, error) {
						return runtimeprep.CodexCLICommand{
							Command: []string{item.binary, "app-server"},
						}, nil
					},
				},
			)
			if bootstrap.CLIVersion != item.version ||
				bootstrap.PluginSync.Status != "succeeded" {
				t.Fatalf("bootstrap = %#v", bootstrap)
			}
			bootstrapElapsed := time.Since(bootstrapStarted)

			adapter := NewCodexAppServerAdapterWithHostMetadataAndCommandResolver(
				NewLocalProcessTransport(),
				LegacyHostMetadata(),
				func(_ context.Context, provider string) (ProviderCommand, error) {
					if provider != ProviderCodex {
						t.Fatalf("provider = %q, want %q", provider, ProviderCodex)
					}
					return ProviderCommand{
						Command: []string{item.binary, "app-server"},
					}, nil
				},
			)
			session := Session{
				RoomID:         "real-cross-version-" + item.name,
				AgentSessionID: "real-cross-version-" + item.name,
				Provider:       ProviderCodex,
				CWD:            t.TempDir(),
				Env: append(
					[]string{"CODEX_HOME=" + codexHome},
					bootstrap.Env()...,
				),
				Status: SessionStatusReady,
			}

			started := time.Now()
			ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
			defer cancel()
			events, err := adapter.Start(ctx, session)
			if err != nil {
				t.Fatalf("Start: %v", err)
			}
			defer func() { _ = adapter.Close(context.Background(), session) }()
			if len(events) == 0 || strings.TrimSpace(events[0].ProviderSessionID) == "" {
				t.Fatalf("startup events = %#v", events)
			}
			state := adapter.SessionState(session)
			if state.AuthState != "authenticated" {
				t.Fatalf("auth state = %q", state.AuthState)
			}
			startup, _ := state.RuntimeContext["appServerStartup"].(map[string]any)
			if startup["models"] != "ready" {
				t.Fatalf("startup state = %#v", startup)
			}
			t.Logf(
				"version=%s bootstrap=%s app_server_start=%s thread=%s",
				item.version,
				bootstrapElapsed.Round(time.Millisecond),
				time.Since(started).Round(time.Millisecond),
				events[0].ProviderSessionID,
			)
		})
	}
}
