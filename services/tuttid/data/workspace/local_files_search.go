package workspace

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
)

const defaultMaxSearchCandidates = 5000

var defaultSearchIgnoredDirectories = map[string]struct{}{
	".git":         {},
	".next":        {},
	".turbo":       {},
	"applications": {},
	"bin":          {},
	"build":        {},
	"cores":        {},
	"dev":          {},
	"dist":         {},
	"etc":          {},
	"library":      {},
	"network":      {},
	"node_modules": {},
	"opt":          {},
	"private":      {},
	"sbin":         {},
	"system":       {},
	"tmp":          {},
	"usr":          {},
	"var":          {},
	"volumes":      {},
}

type searchWalkStats struct {
	candidateCapReached      bool
	deadlineExceeded         bool
	ignoredDirectoryCount    int
	scannedEntryCount        int
	skippedHiddenFileCount   int
	skippedUnsupportedCount  int
	skippedUnrequestedCount  int
	skippedUnreadableCount   int
	skippedSymlinkEntryCount int
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

	includeKinds := map[workspacefiles.EntryKind]bool{}
	for _, kind := range input.IncludeKinds {
		includeKinds[kind] = true
	}

	candidates := make([]workspacefiles.SearchCandidate, 0, input.Limit)
	maxCandidates := a.maxSearchCandidates()
	ignoredDirectories := a.ignoredDirectories()
	allowHiddenFiles := input.IncludeHidden || workspacefiles.SearchQueryTargetsHiddenFile(input.Query)
	allowHiddenAndNoiseDirectories := input.IncludeHidden || workspacefiles.SearchQueryTargetsHiddenOrNoise(input.Query)
	stats := searchWalkStats{}
	walkErr := filepath.WalkDir(rootPath, func(physicalPath string, entry fs.DirEntry, err error) error {
		if err != nil {
			stats.skippedUnreadableCount++
			return nil
		}
		stats.scannedEntryCount++
		if err := ctx.Err(); err != nil {
			return err
		}
		if !input.Deadline.IsZero() && time.Now().After(input.Deadline) {
			stats.deadlineExceeded = true
			return context.DeadlineExceeded
		}
		if physicalPath == rootPath {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			stats.skippedSymlinkEntryCount++
			return nil
		}

		kind := entryKind(entry.Type())
		if kind != workspacefiles.EntryKindFile && kind != workspacefiles.EntryKindDirectory {
			stats.skippedUnsupportedCount++
			return nil
		}
		if entry.IsDir() {
			if !allowHiddenAndNoiseDirectories && shouldIgnoreSearchEntryName(entry.Name(), ignoredDirectories) {
				stats.ignoredDirectoryCount++
				return filepath.SkipDir
			}
		}
		if !allowHiddenFiles && shouldIgnoreHiddenSearchFile(entry) {
			stats.skippedHiddenFileCount++
			return nil
		}
		// 文件类型筛选:仅对文件按分类过滤(目录始终保留以便继续递归/路径打分)。
		// 全局统一口径,见 reference_filter_categories.go(TS 镜像同名)。
		if kind == workspacefiles.EntryKindFile &&
			!matchesReferenceFilterCategories(entry.Name(), false, input.Filters) {
			stats.skippedUnrequestedCount++
			return nil
		}
		appendSearchCandidate(rootPath, physicalPath, kind, includeKinds, &candidates, &stats)
		if len(candidates) >= maxCandidates {
			stats.candidateCapReached = true
			return fs.SkipAll
		}
		return nil
	})
	if walkErr != nil &&
		!errors.Is(walkErr, fs.SkipAll) &&
		(!stats.deadlineExceeded || !errors.Is(walkErr, context.DeadlineExceeded)) {
		logWorkspaceFileSearch(
			start,
			root,
			input,
			candidates,
			stats,
			0,
			walkErr,
		)
		return workspacefiles.SearchResult{}, walkErr
	}

	logicalRoot := workspacefiles.NormalizeLogicalRoot(root.LogicalRoot)
	var entries []workspacefiles.SearchEntry
	if strings.TrimSpace(input.Query) != "" {
		entries = workspacefiles.ScoreSearchCandidates(
			logicalRoot,
			input.Query,
			candidates,
			input.Limit,
		)
	} else {
		// 仅按类型筛选(无关键词):直接枚举命中的文件(不含目录,避免目录噪声),按名排序。
		fileCandidates := make([]workspacefiles.SearchCandidate, 0, len(candidates))
		for _, candidate := range candidates {
			if candidate.Kind == workspacefiles.EntryKindFile {
				fileCandidates = append(fileCandidates, candidate)
			}
		}
		entries = workspacefiles.BuildListingEntries(logicalRoot, fileCandidates, input.Limit)
	}
	logWorkspaceFileSearch(start, root, input, candidates, stats, len(entries), nil)

	return workspacefiles.SearchResult{
		WorkspaceID: root.WorkspaceID,
		Root:        workspacefiles.NormalizeLogicalRoot(root.LogicalRoot),
		Entries:     entries,
	}, nil
}

func appendSearchCandidate(
	rootPath string,
	physicalPath string,
	kind workspacefiles.EntryKind,
	includeKinds map[workspacefiles.EntryKind]bool,
	candidates *[]workspacefiles.SearchCandidate,
	stats *searchWalkStats,
) {
	if len(includeKinds) > 0 && !includeKinds[kind] {
		stats.skippedUnrequestedCount++
		return
	}

	relativePath, err := filepath.Rel(rootPath, physicalPath)
	if err != nil || strings.HasPrefix(relativePath, "..") {
		return
	}
	*candidates = append(*candidates, workspacefiles.SearchCandidate{
		Kind:         kind,
		RelativePath: filepath.ToSlash(relativePath),
	})
}

func (a LocalFilesAdapter) maxSearchCandidates() int {
	if a.MaxSearchCandidates <= 0 {
		return defaultMaxSearchCandidates
	}
	return a.MaxSearchCandidates
}

func (a LocalFilesAdapter) ignoredDirectories() map[string]struct{} {
	if a.IgnoredDirectories == nil {
		return defaultSearchIgnoredDirectories
	}
	return a.IgnoredDirectories
}

func shouldIgnoreSearchEntryName(name string, ignoredDirectories map[string]struct{}) bool {
	if _, ignored := ignoredDirectories[name]; ignored {
		return true
	}
	if _, ignored := ignoredDirectories[strings.ToLower(name)]; ignored {
		return true
	}
	return strings.HasPrefix(name, ".")
}

func shouldIgnoreHiddenSearchFile(entry fs.DirEntry) bool {
	return !entry.IsDir() && strings.HasPrefix(entry.Name(), ".")
}

func logWorkspaceFileSearch(
	start time.Time,
	root workspacefiles.WorkspaceRoot,
	input workspacefiles.SearchInput,
	candidates []workspacefiles.SearchCandidate,
	stats searchWalkStats,
	resultCount int,
	err error,
) {
	attrs := []any{
		"event", "workspace_files.search",
		"workspaceId", root.WorkspaceID,
		"root", workspacefiles.NormalizeLogicalRoot(root.LogicalRoot).String(),
		"query_length", len([]rune(input.Query)),
		"limit", input.Limit,
		"include_hidden", input.IncludeHidden,
		"include_kinds", input.IncludeKinds,
		"duration_ms", time.Since(start).Milliseconds(),
		"scanned_entry_count", stats.scannedEntryCount,
		"candidate_count", len(candidates),
		"result_count", resultCount,
		"candidate_cap_reached", stats.candidateCapReached,
		"deadline_exceeded", stats.deadlineExceeded,
		"partial", stats.deadlineExceeded,
		"ignored_directory_count", stats.ignoredDirectoryCount,
		"skipped_hidden_file_count", stats.skippedHiddenFileCount,
		"skipped_symlink_entry_count", stats.skippedSymlinkEntryCount,
		"skipped_unsupported_count", stats.skippedUnsupportedCount,
		"skipped_unrequested_count", stats.skippedUnrequestedCount,
		"skipped_unreadable_count", stats.skippedUnreadableCount,
	}
	if !input.Deadline.IsZero() {
		attrs = append(attrs, "deadline_remaining_ms", time.Until(input.Deadline).Milliseconds())
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
