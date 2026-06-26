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
	data := scanExternalAgentSessions(ctx, providersFromExternalImportSelections(selections))
	valid := map[string]int64{}
	for _, session := range data.sessions {
		if ctx.Err() != nil {
			return nil, ctx.Err()
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
	cwd, ok := canonicalExistingDir(session.Cwd)
	if !ok {
		return ExternalImportProject{}, false
	}
	return ExternalImportProject{
		Path:                cwd,
		Label:               filepath.Base(cwd),
		Providers:           []string{session.Provider},
		SessionCount:        1,
		MessageCount:        len(session.Messages),
		LastUpdatedAtUnixMS: session.UpdatedAtUnixMS,
	}, true
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
