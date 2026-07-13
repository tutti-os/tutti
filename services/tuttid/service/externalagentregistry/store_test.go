package externalagentregistry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestStoreFetchesRegistryAndWritesCache(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(testRegistryJSON()))
	}))
	defer server.Close()

	store := Store{
		SourceURL: server.URL,
		CacheRoot: t.TempDir(),
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
	}

	agent, err := store.Agent(context.Background(), "sample-agent")
	if err != nil {
		t.Fatalf("Agent() error = %v", err)
	}
	if agent.Distribution.NPM == nil || agent.Distribution.NPM.Package != "@agentclientprotocol/sample-agent-acp@0.46.0" {
		t.Fatalf("NPM distribution = %#v", agent.Distribution.NPM)
	}
	if _, err := os.Stat(store.CachePath()); err != nil {
		t.Fatalf("cache file missing: %v", err)
	}
}

func TestStoreUsesCacheWhenRemoteUnavailable(t *testing.T) {
	cacheRoot := t.TempDir()
	cachePath := filepath.Join(cacheRoot, "cache", "registry.json")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		t.Fatalf("mkdir cache: %v", err)
	}
	if err := os.WriteFile(cachePath, []byte(testRegistryJSON()), 0o644); err != nil {
		t.Fatalf("write cache: %v", err)
	}
	oldTime := time.Date(2026, 6, 2, 6, 0, 0, 0, time.UTC)
	if err := os.Chtimes(cachePath, oldTime, oldTime); err != nil {
		t.Fatalf("chtimes cache: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		http.Error(writer, "down", http.StatusInternalServerError)
	}))
	defer server.Close()

	store := Store{
		SourceURL:  server.URL,
		CacheRoot:  cacheRoot,
		RefreshTTL: time.Nanosecond,
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 8, 0, 0, 0, time.UTC)
		},
	}

	agent, err := store.Agent(context.Background(), "sample-agent")
	if err != nil {
		t.Fatalf("Agent() error = %v", err)
	}
	if agent.Version != "0.46.0" {
		t.Fatalf("Version = %q, want 0.46.0", agent.Version)
	}
}

func TestRegistryPlatformKeyUsesRegistryArchNames(t *testing.T) {
	if got := RegistryPlatformKey("darwin", "arm64"); got != "darwin-aarch64" {
		t.Fatalf("RegistryPlatformKey(darwin, arm64) = %q", got)
	}
	if got := GoPlatformKey("linux-x86_64"); got != "linux-amd64" {
		t.Fatalf("GoPlatformKey(linux-x86_64) = %q", got)
	}
	if got := CurrentPlatformKey(); got == runtime.GOOS+"-"+runtime.GOARCH {
		t.Fatalf("CurrentPlatformKey() = %q, want registry platform key, not Go key", got)
	}
}

func TestStoreParsesBinarySHA256(t *testing.T) {
	cacheRoot := t.TempDir()
	registryPath := filepath.Join(cacheRoot, "registry.json")
	if err := os.WriteFile(registryPath, []byte(`{
  "version": "test",
  "agents": [{
    "id": "binary-agent",
    "name": "Binary Agent",
    "version": "1.2.3",
    "description": "Binary test",
    "distribution": {
      "binary": {
        "darwin-aarch64": {
          "archive": "https://example.com/agent.tar.gz",
          "cmd": "./agent",
          "sha256": "0123456789abcdef"
        }
      }
    }
  }]
}`), 0o644); err != nil {
		t.Fatalf("write registry: %v", err)
	}
	store := Store{SourceURL: registryPath, CacheRoot: cacheRoot}

	agent, err := store.Agent(context.Background(), "binary-agent")
	if err != nil {
		t.Fatalf("Agent() error = %v", err)
	}
	target := agent.Distribution.Binary["darwin-aarch64"]
	if target.SHA256 != "0123456789abcdef" {
		t.Fatalf("SHA256 = %q, want parsed value", target.SHA256)
	}
}

func testRegistryJSON() string {
	return `{
  "version": "test",
  "agents": [{
    "id": "sample-agent",
    "name": "Sample Agent",
    "version": "0.46.0",
    "description": "ACP wrapper for sample agent",
    "distribution": {
      "npx": {
        "package": "@agentclientprotocol/sample-agent-acp@0.46.0",
        "args": ["--stdio"],
        "env": {"CLAUDE_TEST": "1"}
      }
    }
  }]
}`
}
