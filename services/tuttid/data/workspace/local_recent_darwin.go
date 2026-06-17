//go:build darwin

package workspace

import (
	"bufio"
	"context"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
)

// recentCandidateCap bounds how many Spotlight hits we date-stamp and sort.
// Spotlight returns matches unordered, so we over-fetch candidates, read each
// one's last-used date, then keep the newest `limit`.
const recentCandidateCap = 400

// recentLookupTimeout bounds the external Spotlight calls so a slow index never
// stalls the picker.
const recentLookupTimeout = 4 * time.Second

// mdlsLastUsedDateLayout matches `mdls -name kMDItemLastUsedDate` output, e.g.
// "kMDItemLastUsedDate = 2026-06-17 06:35:10 +0000".
const mdlsLastUsedDateLayout = "2006-01-02 15:04:05 -0700"

// ListRecent enumerates the workspace's recently accessed entries (most-recent
// first) via Spotlight, scoped to the workspace root so results never escape it.
func (LocalFilesAdapter) ListRecent(
	ctx context.Context,
	root workspacefiles.WorkspaceRoot,
	limit int,
) (workspacefiles.DirectoryListing, error) {
	limit = workspacefiles.NormalizeRecentLimit(limit)
	rootPath := strings.TrimSpace(root.PhysicalRoot)
	listing := workspacefiles.DirectoryListing{
		WorkspaceID:   root.WorkspaceID,
		Root:          workspacefiles.NormalizeLogicalRoot(root.LogicalRoot),
		DirectoryPath: workspacefiles.NormalizeLogicalRoot(root.LogicalRoot),
		Entries:       []workspacefiles.FileEntry{},
	}
	if rootPath == "" {
		return listing, nil
	}

	lookupCtx, cancel := context.WithTimeout(ctx, recentLookupTimeout)
	defer cancel()

	candidates, err := spotlightRecentCandidates(lookupCtx, rootPath)
	if err != nil || len(candidates) == 0 {
		// A Spotlight failure (index disabled, sandboxed, etc.) degrades to an
		// empty recent list rather than failing the whole picker.
		return listing, nil
	}

	dated := spotlightLastUsedDates(lookupCtx, candidates)
	sort.SliceStable(dated, func(left, right int) bool {
		return dated[left].lastUsed.After(dated[right].lastUsed)
	})

	entries := make([]workspacefiles.FileEntry, 0, limit)
	for _, candidate := range dated {
		if len(entries) >= limit {
			break
		}
		logicalPath, ok := logicalPathWithinRoot(root, candidate.physicalPath)
		if !ok {
			continue
		}
		// Skip the workspace root itself; it is reachable via the "个人" entry.
		if workspacefiles.IsLogicalRoot(logicalPath, root.LogicalRoot) {
			continue
		}
		entry, err := localFileEntry(root, logicalPath)
		if err != nil {
			continue
		}
		lastUsedMs := candidate.lastUsed.UnixMilli()
		entry.LastOpenedMs = &lastUsedMs
		entries = append(entries, entry)
	}

	listing.Entries = entries
	return listing, nil
}

type recentCandidate struct {
	physicalPath string
	lastUsed     time.Time
}

// spotlightRecentCandidates returns recently used paths under rootPath, capped
// to recentCandidateCap. Order is Spotlight's (unranked by date here).
func spotlightRecentCandidates(ctx context.Context, rootPath string) ([]string, error) {
	cmd := exec.CommandContext(
		ctx,
		"mdfind",
		"-onlyin", rootPath,
		"kMDItemLastUsedDate >= $time.this_month",
	)
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	paths := make([]string, 0, recentCandidateCap)
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		path := strings.TrimSpace(scanner.Text())
		if path == "" {
			continue
		}
		paths = append(paths, path)
		if len(paths) >= recentCandidateCap {
			break
		}
	}
	return paths, nil
}

// spotlightLastUsedDates reads kMDItemLastUsedDate for each path via a single
// `mdls` call. Output is one line per input path, in input order; entries
// without a parseable date are dropped.
func spotlightLastUsedDates(ctx context.Context, paths []string) []recentCandidate {
	if len(paths) == 0 {
		return nil
	}
	args := append([]string{"-name", "kMDItemLastUsedDate"}, paths...)
	output, err := exec.CommandContext(ctx, "mdls", args...).Output()
	if err != nil {
		return nil
	}

	dated := make([]recentCandidate, 0, len(paths))
	index := 0
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		if index >= len(paths) {
			break
		}
		line := scanner.Text()
		value, ok := parseMdlsValue(line)
		path := paths[index]
		index++
		if !ok {
			continue
		}
		lastUsed, parseErr := time.Parse(mdlsLastUsedDateLayout, value)
		if parseErr != nil {
			continue
		}
		dated = append(dated, recentCandidate{physicalPath: path, lastUsed: lastUsed})
	}
	return dated
}

// parseMdlsValue extracts the value from an `mdls` line such as
// "kMDItemLastUsedDate = 2026-06-17 06:35:10 +0000". Returns ok=false for null
// values or lines without an assignment.
func parseMdlsValue(line string) (string, bool) {
	separator := strings.Index(line, " = ")
	if separator < 0 {
		return "", false
	}
	value := strings.TrimSpace(line[separator+len(" = "):])
	if value == "" || value == "(null)" {
		return "", false
	}
	return value, true
}

// logicalPathWithinRoot converts an absolute physical path into a logical path
// scoped to root, returning ok=false when the path escapes the root.
func logicalPathWithinRoot(
	root workspacefiles.WorkspaceRoot,
	physicalPath string,
) (workspacefiles.LogicalPath, bool) {
	relative, err := filepath.Rel(root.PhysicalRoot, physicalPath)
	if err != nil {
		return "", false
	}
	relative = filepath.ToSlash(relative)
	if relative == ".." || strings.HasPrefix(relative, "../") {
		return "", false
	}
	logicalPath, err := workspacefiles.NormalizeLogicalPathWithinRoot(relative, root.LogicalRoot)
	if err != nil {
		return "", false
	}
	return logicalPath, true
}
