package agent

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

// ExternalImportValidProjectPaths returns the canonical paths of the selected
// projects that contain at least one valid importable session, without importing
// anything. The register-only import path uses it to avoid surfacing empty
// projects. Returned paths are canonical (see canonicalExistingDir), matching
// ImportExternalSessions.ProjectPaths so callers can register them directly.
func (*Service) ExternalImportValidProjectPaths(ctx context.Context, input ExternalImportInput) ([]string, error) {
	selections := normalizeExternalImportSelections(input.Projects)
	if len(selections) == 0 {
		return nil, nil
	}
	data := scanExternalAgentSessions(ctx, providersFromExternalImportSelections(selections), -1)
	valid := map[string]int64{}
	for _, session := range data.sessions {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if session.NoProject {
			continue
		}
		if projectPath, ok := matchingExternalImportProject(session, selections); ok {
			if session.UpdatedAtUnixMS > valid[projectPath] {
				valid[projectPath] = session.UpdatedAtUnixMS
			}
		}
	}
	return sortedProjectPathsByLatest(valid), nil
}

func projectFromExternalSession(session externalImportedSession) (ExternalImportProject, bool) {
	projectPath, ok := externalSessionProjectPath(session)
	if !ok {
		return ExternalImportProject{}, false
	}
	return ExternalImportProject{
		Path:                projectPath,
		Label:               filepath.Base(projectPath),
		Providers:           []string{session.Provider},
		SessionCount:        1,
		MessageCount:        len(session.Messages),
		LastUpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}, true
}

func externalSessionProjectPath(session externalImportedSession) (string, bool) {
	// session.Cwd has already been resolved by resolveExternalImportSessionCwd
	// (see external_import_parse.go) — canonicalized when the directory still
	// exists, or a best-effort cleaned absolute path when it no longer does (a
	// deleted worktree/temp dir must still be countable and importable, just
	// without git-root-based project grouping). Re-requiring existence here
	// would silently drop those sessions from the scan a second time.
	cwd := filepath.Clean(strings.TrimSpace(session.Cwd))
	if cwd == "" || cwd == "." {
		return "", false
	}
	if session.NoProject {
		// Every "no project selected" session (whether it literally ran in the
		// user's home directory, or in a provider-owned scratch workspace such
		// as Codex's ~/Documents/Codex/<slug>) collapses onto one consistent
		// bucket instead of surfacing its own machine-generated scratch
		// directory name as if it were a real project. Using the raw cwd here
		// previously surfaced synthetic slugs (e.g. "2026-04-24-gh") as bogus
		// project labels — the source of reports that imported project folder
		// names looked garbled and didn't match any folder the user chose.
		if home, ok := externalImportNoProjectBucketPath(); ok {
			return home, true
		}
		return cwd, true
	}
	if gitRoot, ok := nearestExternalImportGitRoot(cwd); ok {
		return gitRoot, true
	}
	return cwd, true
}

// externalImportNoProjectBucketPath resolves the canonical path used to group
// every no-project-selected session together, so the scan/import result
// treats them as one consistent "no project" bucket rather than one bogus
// per-session "project" per scratch directory.
func externalImportNoProjectBucketPath() (string, bool) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", false
	}
	return canonicalExistingDir(home)
}

func nearestExternalImportGitRoot(cwd string) (string, bool) {
	current := filepath.Clean(cwd)
	for current != "" {
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			return current, true
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return "", false
}

func externalImportSessionSummary(session externalImportedSession, projectPath string) ExternalImportSession {
	return ExternalImportSession{
		ID:                  externalImportedSessionID(session.Provider, session.ProviderSessionID),
		ProjectPath:         projectPath,
		Provider:            session.Provider,
		SourcePath:          session.SourcePath,
		Title:               session.Title,
		MessageCount:        len(session.Messages),
		LastUpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}
}

func upsertExternalImportProject(projects map[string]*ExternalImportProject, next ExternalImportProject, provider string) {
	project, ok := projects[next.Path]
	if !ok {
		projects[next.Path] = &next
		return
	}
	project.SessionCount += next.SessionCount
	project.MessageCount += next.MessageCount
	if next.LastUpdatedAtUnixMS > project.LastUpdatedAtUnixMS {
		project.LastUpdatedAtUnixMS = next.LastUpdatedAtUnixMS
	}
	for _, existingProvider := range project.Providers {
		if existingProvider == provider {
			return
		}
	}
	project.Providers = append(project.Providers, provider)
}

func matchingExternalImportProject(session externalImportedSession, selections []ExternalImportProjectSelection) (string, bool) {
	bestPath := ""
	for _, selection := range selections {
		if !externalProviderSelected(session.Provider, selection.Providers) {
			continue
		}
		if len(selection.SessionIDs) > 0 && !externalSessionSelected(session, selection.SessionIDs) {
			continue
		}
		if externalProjectPathContains(selection.Path, session.Cwd) {
			selectionPath := filepath.Clean(selection.Path)
			if selectionPath == filepath.Clean(session.Cwd) {
				return selection.Path, true
			}
			if bestPath == "" || len(selectionPath) > len(filepath.Clean(bestPath)) {
				bestPath = selection.Path
			}
		}
	}
	return bestPath, bestPath != ""
}

func externalSessionSelected(session externalImportedSession, sessionIDs []string) bool {
	sessionID := externalImportedSessionID(session.Provider, session.ProviderSessionID)
	for _, candidate := range sessionIDs {
		if strings.TrimSpace(candidate) == sessionID {
			return true
		}
	}
	return false
}

func externalProviderSelected(provider string, providers []string) bool {
	provider = agentproviderbiz.Normalize(provider)
	for _, candidate := range normalizeExternalImportProviders(providers) {
		if candidate == provider {
			return true
		}
	}
	return false
}

func externalProjectPathContains(parent string, child string) bool {
	parent = filepath.Clean(parent)
	child = filepath.Clean(child)
	if parent == child {
		return true
	}
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel != "." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != ".."
}

func canonicalExistingDir(path string) (string, bool) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", false
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", false
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return "", false
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return filepath.Clean(abs), true
}

func sortedProjectPathsByLatest(values map[string]int64) []string {
	out := make([]string, 0, len(values))
	for value := range values {
		out = append(out, value)
	}
	sort.SliceStable(out, func(left, right int) bool {
		leftUpdatedAt := values[out[left]]
		rightUpdatedAt := values[out[right]]
		if leftUpdatedAt == rightUpdatedAt {
			return out[left] < out[right]
		}
		return leftUpdatedAt > rightUpdatedAt
	})
	return out
}
