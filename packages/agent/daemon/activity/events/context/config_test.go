package agentcontext

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveConfigUsesExplicitRoomID(t *testing.T) {
	cfg, err := ResolveConfig(ConfigInput{RoomID: "room-1", CWD: "/workspace/project"})
	if err != nil {
		t.Fatalf("ResolveConfig() error = %v", err)
	}
	if cfg.RoomID != "room-1" || cfg.CWD != "/workspace/project" {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestResolveConfigReadsAgentContextConfig(t *testing.T) {
	t.Setenv("TUTTI_WORKSPACE_ID", "")
	dir := t.TempDir()
	path := filepath.Join(dir, "agent-context.json")
	if err := os.WriteFile(path, []byte(`{
		"schema_version": 1,
		"room_id": "room-from-config",
		"workspace_id": "runtime-ws-1",
		"service_group": "agent-context",
		"endpoint": {"transport":"unix"}
	}`), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	t.Setenv("TUTTI_AGENT_CONTEXT_CONFIG", path)

	cfg, err := ResolveConfig(ConfigInput{})
	if err != nil {
		t.Fatalf("ResolveConfig() error = %v", err)
	}
	if cfg.RoomID != "room-from-config" || cfg.WorkspaceID != "runtime-ws-1" || cfg.Endpoint.Transport != "unix" {
		t.Fatalf("unexpected config: %#v", cfg)
	}
}

func TestResolveConfigAllowsCWDOnlyContext(t *testing.T) {
	t.Setenv("TUTTI_AGENT_CONTEXT_CONFIG", "")
	t.Setenv("TUTTI_WORKSPACE_ID", "")
	cfg, err := ResolveConfig(ConfigInput{CWD: "/workspace/runtime-ws-1/project"})
	if err != nil {
		t.Fatalf("ResolveConfig() error = %v", err)
	}
	if cfg.RoomID != "" || cfg.WorkspaceID != "" || cfg.CWD != "/workspace/runtime-ws-1/project" {
		t.Fatalf("config = %#v", cfg)
	}
}
