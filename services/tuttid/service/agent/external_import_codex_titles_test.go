package agent

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestScanExternalImportsAppliesCodexSQLiteTitle(t *testing.T) {
	root := t.TempDir()
	codexHome := filepath.Join(root, "codex-home")
	project := filepath.Join(root, "project-x")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatalf("create project error = %v", err)
	}
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))

	// The scan applies a rolling 30-day cutoff, so a fixed fixture date rots:
	// hardcoded stamps aged out of the window exactly 30 days after they were
	// written and the scan silently returned nothing. Stamp relative to now.
	recent := time.Now().UTC().Add(-time.Hour)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "codex-x.jsonl"),
		map[string]any{
			"timestamp": recent.Format(time.RFC3339),
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-x", "cwd": project},
		},
		map[string]any{"timestamp": recent.Add(time.Second).Format(time.RFC3339), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-x-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "First raw prompt"}},
		}},
	)
	writeCodexThreadsDB(t, filepath.Join(codexHome, "state_5.sqlite"), map[string]string{
		"codex-x": "Generated summary title",
	})

	service := newIsolatedAgentService(newFakeRuntime())
	scan, err := service.ScanExternalImports(context.Background(), ExternalImportScanInput{Providers: []string{"codex"}, Days: -1})
	if err != nil {
		t.Fatalf("ScanExternalImports error = %v", err)
	}
	if !slices.ContainsFunc(scan.Sessions, func(session ExternalImportSession) bool {
		return session.Provider == "codex" && session.Title == "Generated summary title"
	}) {
		t.Fatalf("scan sessions = %#v, want SQLite-derived title", scan.Sessions)
	}
}

func TestCodexThreadTitlesReadsStateDB(t *testing.T) {
	codexHome := t.TempDir()
	writeCodexThreadsDB(t, filepath.Join(codexHome, "state_5.sqlite"), map[string]string{
		"thread-a": "Summarize user persona prompts",
		"thread-b": "",
	})

	titles := codexThreadTitles(codexHome)
	if titles["thread-a"] != "Summarize user persona prompts" {
		t.Fatalf("title = %q, want stored thread title", titles["thread-a"])
	}
	if _, ok := titles["thread-b"]; ok {
		t.Fatalf("empty title should be skipped, got %#v", titles)
	}
}

func TestCodexThreadTitlesReadsFromPathWithSpaces(t *testing.T) {
	codexHome := filepath.Join(t.TempDir(), "code x home")
	if err := os.MkdirAll(codexHome, 0o755); err != nil {
		t.Fatalf("create codex home error = %v", err)
	}
	writeCodexThreadsDB(t, filepath.Join(codexHome, "state_5.sqlite"), map[string]string{
		"thread-a": "Title in spaced dir",
	})
	titles := codexThreadTitles(codexHome)
	if titles["thread-a"] != "Title in spaced dir" {
		t.Fatalf("title = %q, want title read from a path containing spaces", titles["thread-a"])
	}
}

func TestCodexThreadTitlesMissingDB(t *testing.T) {
	if titles := codexThreadTitles(t.TempDir()); len(titles) != 0 {
		t.Fatalf("titles = %#v, want empty for missing DB", titles)
	}
	if titles := codexThreadTitles(""); len(titles) != 0 {
		t.Fatalf("titles = %#v, want empty for empty home", titles)
	}
}

func writeCodexThreadsDB(t *testing.T, path string, rows map[string]string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open sqlite error = %v", err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)"); err != nil {
		t.Fatalf("create table error = %v", err)
	}
	for id, title := range rows {
		if _, err := db.Exec("INSERT INTO threads (id, title) VALUES (?, ?)", id, title); err != nil {
			t.Fatalf("insert error = %v", err)
		}
	}
}
