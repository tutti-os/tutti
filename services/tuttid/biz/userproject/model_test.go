package userproject

import (
	"path/filepath"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestSectionKeyFromPathMatchesRailClassification(t *testing.T) {
	rawDir := t.TempDir()
	canonicalDir := storesqlite.NormalizeProjectPath(rawDir)
	if canonicalDir == "" {
		t.Fatal("normalized temp dir is empty")
	}

	gotRaw := SectionKeyFromPath(rawDir)
	gotCanonical := SectionKeyFromPath(canonicalDir)
	want := storesqlite.RailSectionKeyForProject(rawDir)
	if gotRaw != want {
		t.Fatalf("SectionKeyFromPath(raw) = %q, want %q", gotRaw, want)
	}
	if gotCanonical != want {
		t.Fatalf("SectionKeyFromPath(canonical) = %q, want %q", gotCanonical, want)
	}
	if canonicalDir != rawDir && gotRaw == "project:"+rawDir {
		t.Fatalf("SectionKeyFromPath must normalize symlink forms, got %q", gotRaw)
	}
	if gotRaw != "project:"+filepath.Clean(canonicalDir) &&
		gotRaw != storesqlite.RailSectionKeyForProject(canonicalDir) {
		t.Fatalf("unexpected section key %q for %q", gotRaw, rawDir)
	}
}

func TestSectionKeyFromPathEmpty(t *testing.T) {
	if got := SectionKeyFromPath("  "); got != "" {
		t.Fatalf("empty path section key = %q, want empty", got)
	}
}

func TestLabelFromPathSupportsWindowsAndPOSIXSeparators(t *testing.T) {
	tests := map[string]string{
		"/workspace/tutti/":              "tutti",
		`C:\Users\demo\Documents\tutti`:  "tutti",
		`C:\Users\demo\Documents\tutti\`: "tutti",
	}
	for path, want := range tests {
		if got := LabelFromPath(path); got != want {
			t.Errorf("LabelFromPath(%q) = %q, want %q", path, got, want)
		}
	}
}
