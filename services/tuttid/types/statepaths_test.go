package types

import (
	"path/filepath"
	"testing"
)

func TestDefaultStateDirUsesOverride(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", "/tmp/tutti-custom")
	t.Setenv("TUTTI_ENV", "")

	if got := DefaultStateDir(); got != "/tmp/tutti-custom" {
		t.Fatalf("DefaultStateDir() = %q", got)
	}
}

func TestDefaultStateDirUsesDevelopmentDirectory(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("TUTTI_STATE_DIR", "")
	t.Setenv("TUTTI_ENV", "development")

	want := filepath.Join(homeDir, ".tutti-dev")
	if got := DefaultStateDir(); got != want {
		t.Fatalf("DefaultStateDir() = %q, want %q", got, want)
	}
}

func TestDefaultStateDirUsesProductionDirectory(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("TUTTI_STATE_DIR", "")
	t.Setenv("TUTTI_ENV", "production")

	want := filepath.Join(homeDir, ".tutti")
	if got := DefaultStateDir(); got != want {
		t.Fatalf("DefaultStateDir() = %q, want %q", got, want)
	}
}

func TestTuttidDerivedPathsUseDevelopmentRoot(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("TUTTI_STATE_DIR", "")
	t.Setenv("TUTTI_ENV", "development")
	t.Setenv("TUTTI_LOG_DIR", "")
	t.Setenv("TUTTID_DB_PATH", "")
	t.Setenv("TUTTID_LOG_PATH", "")
	t.Setenv("TUTTID_RUN_DIR", "")
	t.Setenv("TUTTID_LISTENER_INFO_PATH", "")
	t.Setenv("TUTTID_PID_PATH", "")

	stateDir := filepath.Join(homeDir, ".tutti-dev")
	if got := TuttidDBPath(); got != filepath.Join(stateDir, "tuttid.db") {
		t.Fatalf("TuttidDBPath() = %q", got)
	}
	if got := TuttidLogsDir(); got != filepath.Join(stateDir, "logs") {
		t.Fatalf("TuttidLogsDir() = %q", got)
	}
	if got := TuttidLogPath(); got != filepath.Join(stateDir, "logs", "tuttid.log") {
		t.Fatalf("TuttidLogPath() = %q", got)
	}
	if got := TuttidRunDir(); got != filepath.Join(stateDir, "run") {
		t.Fatalf("TuttidRunDir() = %q", got)
	}
	if got := TuttidListenerInfoPath(); got != filepath.Join(stateDir, "run", "tuttid.listener.json") {
		t.Fatalf("TuttidListenerInfoPath() = %q", got)
	}
	if got := TuttidPIDPath(); got != filepath.Join(stateDir, "run", "tuttid.pid") {
		t.Fatalf("TuttidPIDPath() = %q", got)
	}
}

func TestTuttidDerivedPathsUseOverrides(t *testing.T) {
	t.Setenv("TUTTI_STATE_DIR", "/tmp/tutti-custom")
	t.Setenv("TUTTID_DB_PATH", "/tmp/tuttid-custom.db")
	t.Setenv("TUTTID_LOG_PATH", "/tmp/tuttid.log")
	t.Setenv("TUTTID_RUN_DIR", "/tmp/tuttid-run")
	t.Setenv("TUTTID_LISTENER_INFO_PATH", "/tmp/tuttid.listener.json")
	t.Setenv("TUTTID_PID_PATH", "/tmp/tuttid.pid")

	if got := TuttidDBPath(); got != "/tmp/tuttid-custom.db" {
		t.Fatalf("TuttidDBPath() = %q", got)
	}
	if got := TuttidLogPath(); got != "/tmp/tuttid.log" {
		t.Fatalf("TuttidLogPath() = %q", got)
	}
	if got := TuttidRunDir(); got != "/tmp/tuttid-run" {
		t.Fatalf("TuttidRunDir() = %q", got)
	}
	if got := TuttidListenerInfoPath(); got != "/tmp/tuttid.listener.json" {
		t.Fatalf("TuttidListenerInfoPath() = %q", got)
	}
	if got := TuttidPIDPath(); got != "/tmp/tuttid.pid" {
		t.Fatalf("TuttidPIDPath() = %q", got)
	}
	if got, want := TuttidStateOwnershipLockPath(), filepath.Join("/tmp/tutti-custom", "run", "tuttid.pid.lock"); got != want {
		t.Fatalf("TuttidStateOwnershipLockPath() = %q", got)
	}
}
