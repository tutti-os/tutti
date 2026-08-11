//go:build windows

package agentruntime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestCodexAppServerWindowsTurnStartContract crosses the real Codex
// app-server process boundary. Unit request-shape tests cannot catch Rust's
// platform-aware AbsolutePathBuf deserialization failures.
func TestCodexAppServerWindowsTurnStartContract(t *testing.T) {
	command := strings.TrimSpace(os.Getenv("TUTTI_CODEX_APP_SERVER_CONTRACT_BIN"))
	if command == "" {
		t.Skip("set TUTTI_CODEX_APP_SERVER_CONTRACT_BIN to the native codex.exe")
	}
	command, err := filepath.Abs(command)
	if err != nil {
		t.Fatalf("resolve Codex executable: %v", err)
	}
	if filepath.Ext(command) != ".exe" {
		t.Fatalf("Codex contract executable = %q, want native .exe", command)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cwd := t.TempDir()
	codexHome := filepath.Join(t.TempDir(), "codex-home")
	if err := os.MkdirAll(codexHome, 0o700); err != nil {
		t.Fatalf("create isolated CODEX_HOME: %v", err)
	}
	conn, err := NewLocalProcessTransport().Start(ctx, ProcessSpec{
		Provider: ProviderCodex,
		CWD:      cwd,
		Command:  []string{command, "app-server"},
		Env: append(
			withoutEnvironmentKey(os.Environ(), "CODEX_HOME"),
			"CODEX_HOME="+codexHome,
		),
	})
	if err != nil {
		t.Fatalf("start Codex app-server: %v", err)
	}
	client := newCodexAppServerClient(conn)
	defer func() { _ = client.Close() }()

	if _, err := client.Initialize(ctx, 10*time.Second, map[string]any{
		"clientInfo": map[string]any{
			"name": "tutti-windows-contract-test", "title": "Tutti", "version": "0",
		},
		"capabilities": map[string]any{"experimentalApi": true},
	}, nil); err != nil {
		t.Fatalf("initialize Codex app-server: %v", err)
	}
	if err := client.Initialized(ctx); err != nil {
		t.Fatalf("notify initialized: %v", err)
	}

	// The historical payload must fail in the real Windows deserializer. This
	// negative control proves the contract test would catch the regression.
	const missingThreadID = "00000000-0000-0000-0000-000000000001"
	historical := map[string]any{
		"threadId": missingThreadID,
		"input":    []any{},
		"sandboxPolicy": map[string]any{
			"type": "workspaceWrite", "writableRoots": []string{"/sandbox-tmp"},
		},
	}
	if _, err := client.TurnStart(ctx, 10*time.Second, historical); err == nil ||
		!strings.Contains(err.Error(), "AbsolutePathBuf deserialized without a base path") {
		t.Fatalf("historical turn/start error = %v, want AbsolutePathBuf rejection", err)
	}

	projectedTempWithBase := map[string]any{
		"threadId": missingThreadID,
		"input":    []any{},
		"cwd":      cwd,
		"sandboxPolicy": map[string]any{
			"type": "workspaceWrite", "writableRoots": []string{"/sandbox-tmp"},
		},
	}
	_, err = client.TurnStart(ctx, 10*time.Second, projectedTempWithBase)
	if err == nil || !strings.Contains(err.Error(), "AbsolutePathBuf deserialized without a base path") {
		t.Fatalf("projected temp turn/start error = %v, want AbsolutePathBuf rejection even with cwd", err)
	}

	// The production builder supplies cwd and omits the POSIX-only writable
	// root on Windows. A missing thread is deliberate: it exercises request
	// deserialization without authenticating or starting a model turn.
	session := Session{CWD: cwd, PermissionModeID: "auto"}
	params := appServerTurnStartParams(
		session,
		missingThreadID,
		nil,
		nil,
		nil,
		"",
		"",
		false,
	)
	_, err = client.TurnStart(ctx, 10*time.Second, params)
	if err == nil {
		t.Fatal("production turn/start unexpectedly found the missing thread")
	}
	if strings.Contains(err.Error(), "AbsolutePathBuf") {
		t.Fatalf("production turn/start failed path deserialization: %v", err)
	}
	if !strings.Contains(err.Error(), "thread not found") {
		t.Fatalf("production turn/start error = %v, want semantic missing-thread rejection", err)
	}
}
