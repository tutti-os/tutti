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
	cwd, ok := canonicalExistingDir(session.Cwd)
	if !ok {
		return "", false
	}
	if session.NoProject {
		return cwd, true
	}
	if gitRoot, ok := nearestExternalImportGitRoot(cwd); ok {
		return gitRoot, true
	}
	return cwd, true
}

func nearestExternalImportGitRoot(cwd string) (string, bool) {
	current := filepath.Clean(cwd)
	for current != "" {
		gitPath := filepath.Join(current, ".git")
		if info, err := os.Lstat(gitPath); err == nil {
			if !info.IsDir() {
				// A `.git` *file* (rather than directory) at the nearest git
				// root means current is a linked worktree, not the main
				// checkout — resolve back to the main checkout so callers
				// never treat an ephemeral per-task worktree as its own
				// independent project. Fall back to current, unresolved, if
				// that fails for any reason (e.g. malformed metadata).
				if mainRoot, ok := resolveGitWorktreeMainRoot(gitPath); ok {
					return mainRoot, true
				}
			}
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

// resolveExternalImportWorktreeCwd walks up from cwd looking for the nearest
// git root — a directory containing a `.git` entry, whether a real
// directory (a normal/main checkout) or a `.git` *file* (the pointer git
// leaves at the root of a linked worktree created via `git worktree add`).
// When the nearest root turns out to be a linked worktree, it resolves back
// to the *main* checkout's working-tree root and maps cwd onto the
// equivalent path under that root, preserving any subdirectory depth.
//
// This matters because a coding agent (Codex, in particular) commonly runs
// each task inside its own throwaway worktree, e.g.
// ~/.codex/worktrees/8db5/tsh. That directory has its own `.git` file, so
// naively it looks like its own independent git root/project — but it is
// not the directory the user actually registered as their "tsh" project;
// the main checkout is. Without this resolution, every session imported
// from such a worktree gets grouped under (and, if registered, creates a
// brand-new project card for) the ephemeral worktree path instead of lining
// up with the user's real, already-registered project — leaving the real
// project empty and the imported sessions stranded in the no-project
// bucket.
//
// Returns ok=false whenever there's nothing to resolve — no git root found,
// the root is a normal checkout, or the worktree's metadata can't be read
// for any reason (malformed, main checkout since removed) — so callers can
// safely keep using cwd unchanged.
func resolveExternalImportWorktreeCwd(cwd string) (string, bool) {
	current := filepath.Clean(cwd)
	for current != "" {
		gitPath := filepath.Join(current, ".git")
		info, err := os.Lstat(gitPath)
		if err != nil {
			parent := filepath.Dir(current)
			if parent == current {
				return "", false
			}
			current = parent
			continue
		}
		if info.IsDir() {
			return "", false
		}
		mainRoot, ok := resolveGitWorktreeMainRoot(gitPath)
		if !ok {
			return "", false
		}
		rel, err := filepath.Rel(current, filepath.Clean(cwd))
		if err != nil {
			return "", false
		}
		return filepath.Clean(filepath.Join(mainRoot, rel)), true
	}
	return "", false
}

// resolveGitWorktreeMainRoot resolves a linked worktree's `.git` pointer
// file (gitFilePath) back to the main checkout's working-tree root. It
// follows the same two-step lookup git itself uses: the pointer file's
// "gitdir: <path>" line names the worktree's private metadata directory
// (<main>/.git/worktrees/<name>), and that directory's `commondir` file
// names the shared .git directory it's relative to (normally "../.."). The
// main checkout's root is that shared directory's parent.
func resolveGitWorktreeMainRoot(gitFilePath string) (string, bool) {
	data, err := os.ReadFile(gitFilePath)
	if err != nil {
		return "", false
	}
	const prefix = "gitdir:"
	line := strings.TrimSpace(string(data))
	if !strings.HasPrefix(line, prefix) {
		return "", false
	}
	worktreeGitDir := strings.TrimSpace(strings.TrimPrefix(line, prefix))
	if worktreeGitDir == "" {
		return "", false
	}
	if !filepath.IsAbs(worktreeGitDir) {
		worktreeGitDir = filepath.Join(filepath.Dir(gitFilePath), worktreeGitDir)
	}
	commonDirRaw, err := os.ReadFile(filepath.Join(worktreeGitDir, "commondir"))
	if err != nil {
		return "", false
	}
	commonDir := strings.TrimSpace(string(commonDirRaw))
	if commonDir == "" {
		return "", false
	}
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(worktreeGitDir, commonDir)
	}
	return canonicalExistingDir(filepath.Dir(filepath.Clean(commonDir)))
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
