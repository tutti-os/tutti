package agenthost

import (
	"runtime"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestNormalizeRailPlacementDerivesCanonicalSectionKey(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	placement, err := normalizeRailPlacement(&RailPlacement{
		Version:     1,
		Kind:        RailPlacementKindProject,
		ProjectPath: root,
		SectionKey:  "project:/unrelated",
	})
	if err != nil {
		t.Fatalf("normalizeRailPlacement() error = %v", err)
	}
	wantPath := storesqlite.NormalizeProjectPath(root)
	wantKey := storesqlite.RailSectionKeyForProject(wantPath)
	if placement.ProjectPath != wantPath {
		t.Fatalf("ProjectPath = %q, want %q", placement.ProjectPath, wantPath)
	}
	if placement.SectionKey != wantKey {
		t.Fatalf("SectionKey = %q, want %q", placement.SectionKey, wantKey)
	}
}

func TestRailPlacementMatchesSessionAcrossSymlinkForms(t *testing.T) {
	t.Parallel()
	if runtime.GOOS != "darwin" {
		t.Skip("macOS /var vs /private/var alias")
	}

	root := t.TempDir()
	canonical := storesqlite.NormalizeProjectPath(root)
	if canonical == root {
		t.Skip("temp dir has no symlink alias")
	}
	placement, err := normalizeRailPlacement(&RailPlacement{
		Version:     1,
		Kind:        RailPlacementKindProject,
		ProjectPath: canonical,
		SectionKey:  storesqlite.RailSectionKeyForProject(canonical),
	})
	if err != nil {
		t.Fatalf("normalizeRailPlacement() error = %v", err)
	}
	session := storesqlite.Session{
		RailSectionKind: string(RailPlacementKindProject),
		RailProjectPath: root,
		RailSectionKey:  "project:" + root,
	}
	if !railPlacementMatchesSession(placement, session) {
		t.Fatalf("expected alias forms to match: placement=%#v session=%#v", placement, session)
	}
}
