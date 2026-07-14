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

	// 搜索范围限定:Within 非空时把遍历起点收敛到工作区根下的该子目录(左栏选中的「位置」,
	// 如 文稿/下载/桌面),而候选项的相对路径仍以工作区根为基准计算,使结果逻辑路径保持可定位。
	// 空 = 跨整根搜索(searchRootPath == rootPath,行为与既有一致)。
	searchRootPath := rootPath
	if within := strings.TrimSpace(input.Within); within != "" {
		withinLogical, err := workspacefiles.NormalizeLogicalPathWithinRoot(within, root.LogicalRoot)
		if err != nil {
			return workspacefiles.SearchResult{}, err
		}
		searchRootPath, err = existingPhysicalPath(root, withinLogical)
		if err != nil {
			return workspacefiles.SearchResult{}, err
		}
	}

	includeKinds := map[workspacefiles.EntryKind]bool{}
	for _, kind := range input.IncludeKinds {
		includeKinds[kind] = true
	}

	maxCandidates := a.maxSearchCandidates()
	ignoredDirectories := a.ignoredDirectories()
	allowHiddenFiles := input.IncludeHidden
	allowHiddenAndNoiseDirectories := input.IncludeHidden
	candidates, stats, walkErr := walkSearchCandidates(ctx, rootPath, searchRootPath, input, searchWalkOptions{
		allowHiddenAndNoiseDirectories: allowHiddenAndNoiseDirectories,
		allowHiddenFiles:               allowHiddenFiles,
		ignoredDirectories:             ignoredDirectories,
		includeKinds:                   includeKinds,
		maxCandidates:                  maxCandidates,
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

type searchWalkOptions struct {
	allowHiddenAndNoiseDirectories bool
	allowHiddenFiles               bool
	ignoredDirectories             map[string]struct{}
	includeKinds                   map[workspacefiles.EntryKind]bool
	maxCandidates                  int
}

func walkSearchCandidates(
	ctx context.Context,
	rootPath string,
	searchRootPath string,
	input workspacefiles.SearchInput,
	options searchWalkOptions,
) ([]workspacefiles.SearchCandidate, searchWalkStats, error) {
	candidates := make([]workspacefiles.SearchCandidate, 0, input.Limit)
	stats := searchWalkStats{scannedEntryCount: 1}
	queue := []string{searchRootPath}

	for len(queue) > 0 {
		directoryPath := queue[0]
		queue = queue[1:]

		dirEntries, err := os.ReadDir(directoryPath)
		if err != nil {
			stats.skippedUnreadableCount++
			continue
		}

		for _, entry := range dirEntries {
			physicalPath := filepath.Join(directoryPath, entry.Name())
			stats.scannedEntryCount++
			if err := ctx.Err(); err != nil {
				return candidates, stats, err
			}
			if !input.Deadline.IsZero() && time.Now().After(input.Deadline) {
				stats.deadlineExceeded = true
				return candidates, stats, context.DeadlineExceeded
			}
			if entry.Type()&os.ModeSymlink != 0 {
				stats.skippedSymlinkEntryCount++
				continue
			}

			kind := entryKind(entry.Type())
			if kind != workspacefiles.EntryKindFile && kind != workspacefiles.EntryKindDirectory {
				stats.skippedUnsupportedCount++
				continue
			}
			if entry.IsDir() {
				if !options.allowHiddenAndNoiseDirectories && shouldIgnoreSearchEntryName(entry.Name(), options.ignoredDirectories) {
					stats.ignoredDirectoryCount++
					continue
				}
				queue = append(queue, physicalPath)
			}
			if !options.allowHiddenFiles && shouldIgnoreHiddenSearchFile(entry) {
				stats.skippedHiddenFileCount++
				continue
			}
			// 文件类型筛选:筛选生效时,搜索结果须是「关键词 ∩ 类型」的交集。目录不属于任何文件
			// 类型,故不作为结果候选(但仍递归进入以发现匹配类型的文件);文件按其分类过滤。
			if len(input.Filters) > 0 {
				if kind == workspacefiles.EntryKindDirectory {
					continue
				}
				if !matchesReferenceFilterCategories(entry.Name(), false, input.Filters) {
					stats.skippedUnrequestedCount++
					continue
				}
			}
			appendSearchCandidate(rootPath, physicalPath, kind, options.includeKinds, &candidates, &stats)
			if len(candidates) >= options.maxCandidates {
				stats.candidateCapReached = true
				return candidates, stats, fs.SkipAll
			}
		}
	}

	return candidates, stats, nil
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
