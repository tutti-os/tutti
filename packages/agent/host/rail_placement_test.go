package agenthost

import (
	"context"
	"errors"
	"runtime"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type railPlacementCanonicalStore struct {
	CanonicalStore
	session storesqlite.Session
}

func (railPlacementCanonicalStore) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}

func (s railPlacementCanonicalStore) GetSession(
	context.Context,
	string,
	string,
) (storesqlite.Session, bool, error) {
	return s.session, true, nil
}

type railPlacementRuntime struct{ RuntimeController }

func (railPlacementRuntime) Session(string, string) (ProviderRuntimeSession, bool) {
	return ProviderRuntimeSession{}, false
}

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

func TestGetSessionWithRailPlacementOwnsCanonicalRecoveryPolicy(t *testing.T) {
	t.Parallel()
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	host := New(Config{
		CanonicalStore: railPlacementCanonicalStore{session: storesqlite.Session{
			WorkspaceID: ref.WorkspaceID, ID: ref.AgentSessionID,
			RailSectionKind: storesqlite.RailSectionKindProject,
			RailProjectPath: "/workspace/project",
			RailSectionKey:  storesqlite.RailSectionKeyForProject("/workspace/project"),
		}},
		Runtime: railPlacementRuntime{},
	})

	result, err := host.GetSessionWithRailPlacement(t.Context(), ref, &RailPlacement{
		Version: 1, Kind: RailPlacementKindProject,
		ProjectPath: "/workspace/project", SectionKey: "project:/ignored-by-normalization",
	})
	if err != nil || result.Canonical.ID != ref.AgentSessionID {
		t.Fatalf("GetSessionWithRailPlacement() = (%#v, %v), want canonical Session", result, err)
	}
	if _, err := host.GetSessionWithRailPlacement(t.Context(), ref, &RailPlacement{
		Version: 1, Kind: RailPlacementKindProject, ProjectPath: "/workspace/other-project",
	}); !errors.Is(err, ErrRailPlacementConflict) {
		t.Fatalf("mismatched project rail error = %v, want %v", err, ErrRailPlacementConflict)
	}
	if _, err := host.GetSessionWithRailPlacement(t.Context(), ref, nil); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("missing recovery rail error = %v, want %v", err, ErrInvalidArgument)
	}
}
