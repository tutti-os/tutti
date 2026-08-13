package workspace

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
)

const defaultMaxSearchCandidates = 5000

// defaultSearchIgnoredDirectoryNames preserves the search scope of the former
// filesystem walker. Native index providers use the same list to discard
// predictable noise before applying their candidate limit, while
// localFileSearchCandidates applies it again as a provider-independent guard.
var defaultSearchIgnoredDirectoryNames = []string{
	".git",
	".next",
	".turbo",
	"applications",
	"bin",
	"build",
	"cores",
	"dev",
	"dist",
	"etc",
	"library",
	"network",
	"node_modules",
	"opt",
	"private",
	"sbin",
	"system",
	"tmp",
	"usr",
	"var",
	"volumes",
}

var defaultSearchIgnoredDirectories = func() map[string]struct{} {
	directories := make(map[string]struct{}, len(defaultSearchIgnoredDirectoryNames))
	for _, name := range defaultSearchIgnoredDirectoryNames {
		directories[name] = struct{}{}
	}
	return directories
}()

type localFileSearchRequest struct {
	CandidateLimit int
	Filters        []string
	IncludeHidden  bool
	IncludeKinds   []workspacefiles.EntryKind
	Query          string
	SearchRootPath string
}

type localFileSearchProvider interface {
	Name() string
	Search(context.Context, localFileSearchRequest) ([]string, error)
}

type localFileSearchStats struct {
	candidateCount          int
	indexedPathCount        int
	skippedHiddenCount      int
	skippedIgnoredCount     int
	skippedOutsideRootCount int
	skippedSymlinkCount     int
	skippedUnavailableCount int
	skippedUnrequestedCount int
}

func (a LocalFilesAdapter) Search(
	ctx context.Context,
	root workspacefiles.WorkspaceRoot,
	input workspacefiles.SearchInput,
) (workspacefiles.SearchResult, error) {
	start := time.Now()
	rootPath, err := existingPhysicalPath(root, workspacefiles.NormalizeLogicalRoot(root.LogicalRoot))
	if err != nil {
		return workspacefiles.SearchResult{}, err
	}
	searchRootPath, err := resolveLocalFileSearchRoot(root, rootPath, input.Within)
	if err != nil {
		return workspacefiles.SearchResult{}, err
	}

	provider := a.searchProvider
	if provider == nil {
		provider = newPlatformLocalFileSearchProvider()
	}
	if provider == nil {
		err := fmt.Errorf("%w: no platform adapter", workspacefiles.ErrSearchUnavailable)
		logWorkspaceFileSearch(start, root, input, "none", localFileSearchStats{}, 0, 0, err)
		return workspacefiles.SearchResult{}, err
	}

	searchCtx := ctx
	cancel := func() {}
	if !input.Deadline.IsZero() {
		searchCtx, cancel = context.WithDeadline(ctx, input.Deadline)
	}
	defer cancel()

	paths, err := provider.Search(searchCtx, localFileSearchRequest{
		CandidateLimit: a.maxSearchCandidates(),
		Filters:        input.Filters,
		IncludeHidden:  input.IncludeHidden,
		IncludeKinds:   input.IncludeKinds,
		Query:          strings.TrimSpace(input.Query),
		SearchRootPath: searchRootPath,
	})
	if err != nil {
		if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			err = fmt.Errorf("%w: %s: %v", workspacefiles.ErrSearchUnavailable, provider.Name(), err)
		}
		logWorkspaceFileSearch(start, root, input, provider.Name(), localFileSearchStats{}, len(paths), 0, err)
		return workspacefiles.SearchResult{}, err
	}

	candidates, stats := localFileSearchCandidates(rootPath, searchRootPath, paths, input)
	logicalRoot := workspacefiles.NormalizeLogicalRoot(root.LogicalRoot)
	var entries []workspacefiles.SearchEntry
	if strings.TrimSpace(input.Query) != "" {
		entries = workspacefiles.ScoreSearchCandidates(
			logicalRoot,
			normalizePhysicalSearchQuery(root, input.Query),
			candidates,
			input.Limit,
		)
	} else {
		entries = workspacefiles.BuildListingEntries(logicalRoot, candidates, input.Limit)
	}
	logWorkspaceFileSearch(start, root, input, provider.Name(), stats, len(paths), len(entries), nil)
	return workspacefiles.SearchResult{
		WorkspaceID: root.WorkspaceID,
		Root:        logicalRoot,
		Entries:     entries,
	}, nil
}

func resolveLocalFileSearchRoot(
	root workspacefiles.WorkspaceRoot,
	rootPath string,
	within string,
) (string, error) {
	if strings.TrimSpace(within) == "" {
		return rootPath, nil
	}
	logicalPath, err := workspacefiles.NormalizeLogicalPathWithinRoot(within, root.LogicalRoot)
	if err != nil {
		return "", err
	}
	return existingPhysicalPath(root, logicalPath)
}

func localFileSearchCandidates(
	rootPath string,
	searchRootPath string,
	paths []string,
	input workspacefiles.SearchInput,
) ([]workspacefiles.SearchCandidate, localFileSearchStats) {
	includeKinds := make(map[workspacefiles.EntryKind]bool, len(input.IncludeKinds))
	for _, kind := range input.IncludeKinds {
		includeKinds[kind] = true
	}
	candidates := make([]workspacefiles.SearchCandidate, 0, min(len(paths), input.Limit))
	stats := localFileSearchStats{indexedPathCount: len(paths)}
	seen := make(map[string]struct{}, len(paths))
	for _, rawPath := range paths {
		physicalPath := filepath.Clean(strings.TrimSpace(rawPath))
		if physicalPath == "" {
			stats.skippedUnavailableCount++
			continue
		}
		relativeToSearchRoot, ok := relativePathWithin(searchRootPath, physicalPath)
		if !ok || relativeToSearchRoot == "." {
			stats.skippedOutsideRootCount++
			continue
		}
		relativeToRoot, ok := relativePathWithin(rootPath, physicalPath)
		if !ok || relativeToRoot == "." {
			stats.skippedOutsideRootCount++
			continue
		}
		relativeToRoot = filepath.ToSlash(relativeToRoot)
		key := relativeToRoot
		if runtime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}

		info, err := os.Lstat(physicalPath)
		if err != nil {
			stats.skippedUnavailableCount++
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			stats.skippedSymlinkCount++
			continue
		}
		kind := entryKind(info.Mode())
		if kind != workspacefiles.EntryKindFile && kind != workspacefiles.EntryKindDirectory {
			stats.skippedUnavailableCount++
			continue
		}
		if !input.IncludeHidden {
			if localSearchPathIsHidden(relativeToRoot) {
				stats.skippedHiddenCount++
				continue
			}
			if localSearchPathIsNoise(relativeToRoot) {
				stats.skippedIgnoredCount++
				continue
			}
		}
		if len(includeKinds) > 0 && !includeKinds[kind] {
			stats.skippedUnrequestedCount++
			continue
		}
		if len(input.Filters) > 0 {
			if kind == workspacefiles.EntryKindDirectory ||
				!matchesReferenceFilterCategories(info.Name(), false, input.Filters) {
				stats.skippedUnrequestedCount++
				continue
			}
		}
		candidates = append(candidates, workspacefiles.SearchCandidate{
			Kind:         kind,
			RelativePath: relativeToRoot,
		})
	}
	stats.candidateCount = len(candidates)
	return candidates, stats
}

func relativePathWithin(rootPath string, candidatePath string) (string, bool) {
	relative, err := filepath.Rel(rootPath, candidatePath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", false
	}
	return relative, true
}

func localSearchPathIsIgnored(relativePath string) bool {
	return localSearchPathIsHidden(relativePath) || localSearchPathIsNoise(relativePath)
}

func localSearchPathIsHidden(relativePath string) bool {
	for _, segment := range strings.Split(filepath.ToSlash(relativePath), "/") {
		if strings.HasPrefix(segment, ".") {
			return true
		}
	}
	return false
}

func localSearchPathIsNoise(relativePath string) bool {
	for _, segment := range strings.Split(filepath.ToSlash(relativePath), "/") {
		if _, ignored := defaultSearchIgnoredDirectories[strings.ToLower(segment)]; ignored {
			return true
		}
	}
	return false
}

func normalizePhysicalSearchQuery(root workspacefiles.WorkspaceRoot, query string) string {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" || !filepath.IsAbs(trimmed) {
		return query
	}
	physicalRootValue := strings.TrimSpace(root.PhysicalRoot)
	if physicalRootValue == "" {
		return query
	}
	physicalRoot, err := filepath.Abs(physicalRootValue)
	if err != nil {
		return query
	}
	physicalQuery := filepath.Clean(trimmed)
	relative, err := filepath.Rel(physicalRoot, physicalQuery)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return query
	}
	if relative == "." {
		return ""
	}
	normalized := path.Join(
		workspacefiles.NormalizeLogicalRoot(root.LogicalRoot).String(),
		filepath.ToSlash(relative),
	)
	if strings.HasSuffix(trimmed, "/") || strings.HasSuffix(trimmed, "\\") {
		normalized += "/"
	}
	return normalized
}

func (a LocalFilesAdapter) maxSearchCandidates() int {
	if a.MaxSearchCandidates <= 0 {
		return defaultMaxSearchCandidates
	}
	return a.MaxSearchCandidates
}

func logWorkspaceFileSearch(
	start time.Time,
	root workspacefiles.WorkspaceRoot,
	input workspacefiles.SearchInput,
	provider string,
	stats localFileSearchStats,
	indexedPathCount int,
	resultCount int,
	err error,
) {
	attrs := []any{
		"event", "workspace_files.search",
		"workspaceId", root.WorkspaceID,
		"root", workspacefiles.NormalizeLogicalRoot(root.LogicalRoot).String(),
		"provider", provider,
		"platform", runtime.GOOS,
		"query_length", len([]rune(input.Query)),
		"limit", input.Limit,
		"include_hidden", input.IncludeHidden,
		"include_kinds", input.IncludeKinds,
		"duration_ms", time.Since(start).Milliseconds(),
		"indexed_path_count", indexedPathCount,
		"candidate_count", stats.candidateCount,
		"result_count", resultCount,
		"skipped_hidden_count", stats.skippedHiddenCount,
		"skipped_ignored_count", stats.skippedIgnoredCount,
		"skipped_outside_root_count", stats.skippedOutsideRootCount,
		"skipped_symlink_count", stats.skippedSymlinkCount,
		"skipped_unavailable_count", stats.skippedUnavailableCount,
		"skipped_unrequested_count", stats.skippedUnrequestedCount,
	}
	if err != nil {
		attrs = append(attrs, "error", err)
		if errors.Is(err, context.Canceled) {
			slog.Info("workspace file search canceled", attrs...)
			return
		}
		slog.Warn("workspace file search failed", attrs...)
		return
	}
	slog.Info("workspace file search completed", attrs...)
}
